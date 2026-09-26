import { QueryExecuted } from '../events';
import { Dispatcher } from '../events/Dispatcher';
import { UniqueConstraintViolationException } from '../exceptions';
import { Request } from '../database/Request';
import { Columns } from './Columns';
import { Comparator } from './Comparator';
import { Joiner } from './Joiner';
import { Planner } from './Planner';
import { Predicate } from './Predicate';
import { Signature } from './Signature';
import { Writer } from './Writer';
import type { Connection } from '../database/Connection';
import type { ColumnSchema, IndexSchema, TableSchema } from '../schema/types';
import type { Constraint, JoinClause, Order, Plan, Projection, Query } from './types';

type Entry<T> = { record: T; key: IDBValidKey };

export class Executor<T> {
    /**
     * The connection the query runs on.
     */
    readonly #connection: Connection;

    /**
     * The query being run.
     */
    readonly #query: Query;

    /**
     * Create a new executor over a query.
     */
    constructor(connection: Connection, query: Query) {
        this.#connection = connection;
        this.#query = query;
    }

    /**
     * Describe the plan the query would run under.
     */
    async explain(): Promise<string> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);

        return Planner.describe(Planner.plan(this.#query.constraints, this.#query.orders, schema));
    }

    /**
     * Get the records matching the query, unshaped.
     */
    async records(): Promise<T[]> {
        return (await this.#matched()).records;
    }

    /**
     * Get the keys of the records matching the query.
     */
    async keys(): Promise<IDBValidKey[]> {
        return (await this.#matched()).keys;
    }

    /**
     * Get the records held under the given keys, skipping any deleted since.
     */
    async fetch(keys: IDBValidKey[]): Promise<T[]> {
        const store: IDBObjectStore = await this.#store('readonly');

        const records: (T | undefined)[] = await Promise.all(
            keys.map((key: IDBValidKey): Promise<T | undefined> => Request.settle(store.get(key) as IDBRequest<T | undefined>)),
        );

        return records.filter((record: T | undefined): record is T => record !== undefined);
    }

    /**
     * Get the record with the given key.
     */
    async find(key: IDBValidKey): Promise<T | null> {
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
        const record: T | undefined = await Request.settle(store.get(key) as IDBRequest<T | undefined>);

        this.#emit('key', started, record === undefined ? 0 : 1);

        return record ?? null;
    }

    /**
     * Count the records matching the query.
     */
    async count(): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const plan: Plan = Planner.plan(this.#query.constraints, this.#query.orders, schema);

        if (plan.residual.length > 0 || plan.values !== null) {
            return (await this.records()).length;
        }

        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const count: number = await Request.settle(source.count(plan.range ?? undefined));

        this.#emit(Planner.describe(plan), started, count);

        return count;
    }

    /**
     * Get the numeric values of a column across the records matching the query.
     */
    async numbers(column: string): Promise<number[]> {
        const records: Record<string, unknown>[] = await this.records() as Record<string, unknown>[];

        return records
            .map((record: Record<string, unknown>): unknown => record[column])
            .filter((value: unknown): boolean => value !== null && value !== undefined)
            .map((value: unknown): number => Number(value));
    }

    /**
     * Get the value at one end of a column's range.
     */
    async extreme(column: string, direction: IDBCursorDirection): Promise<number | null> {
        const index: IndexSchema | null = await this.#sole(column);

        // An index is already sorted, and IndexedDB omits records with no value for its key path,
        // which is exactly what SQL does with nulls. So the answer is its first entry.
        if (index !== null) {
            const store: IDBObjectStore = await this.#store('readonly');
            const started: number = performance.now();
            const cursor: IDBCursorWithValue | null = await Request.settle(store.index(index.name).openCursor(null, direction));

            this.#emit(`index:${index.name}`, started, cursor === null ? 0 : 1);

            return cursor === null ? null : Number(cursor.key);
        }

        const values: number[] = await this.numbers(column);

        if (values.length === 0) {
            return null;
        }

        // Reduced rather than spread, since Math.min(...values) throws past roughly 100k arguments.
        return values.reduce((carry: number, value: number): number => direction === 'next'
            ? Math.min(carry, value)
            : Math.max(carry, value));
    }

    /**
     * Insert records into the table, skipping any the unique indexes reject when told to ignore them.
     */
    async insert(rows: Partial<T>[], ignore: boolean = false): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        let inserted: number = 0;

        for (const row of rows) {
            try {
                await Writer.add(store, schema, this.#connection.strict, row as Record<string, unknown>);

                inserted++;
            } catch (error: unknown) {
                // Only a rejected constraint is skipped. Anything else is the caller's problem.
                if (!ignore || !(error instanceof UniqueConstraintViolationException)) {
                    throw error;
                }
            }
        }

        this.#emit('insert', started, inserted);

        return inserted;
    }

    /**
     * Insert a record and get the key the database gave it.
     */
    async insertGetId(record: Partial<T>): Promise<IDBValidKey> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();
        const key: IDBValidKey = await Writer.add(store, schema, this.#connection.strict, record as Record<string, unknown>);

        this.#emit('insert', started, 1);

        return key;
    }

    /**
     * Insert records, updating those that already hold their conflict key.
     */
    async upsert(values: Partial<T>[], columns: string[], update?: string[]): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const target: IndexSchema | null = Writer.conflict(schema, columns);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        for (const value of values) {
            await Writer.merge(store, schema, this.#connection.strict, columns, target, value as Record<string, unknown>, update);
        }

        this.#emit('upsert', started, values.length);

        return values.length;
    }

    /**
     * Apply a change to every record matching the query, in the order the query asks for.
     */
    async modify(apply: (cursor: IDBCursorWithValue) => void): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const plan: Plan = Planner.plan(this.#query.constraints, this.#query.orders, schema);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);
        const limit: number | null = this.#query.limit;
        const offset: number = this.#query.offset;
        const ceiling: number | null = limit === null ? null : offset + limit;

        const collects: boolean = !plan.ordered && this.#query.orders.length > 0 && (limit !== null || offset > 0);

        let seen: number = 0;
        let affected: number = 0;

        if (collects) {
            const collected: Entry<T>[] = plan.values === null
                ? await this.#cursored(store, plan, matches)
                : await this.#points(store, plan, matches);

            for (const entry of this.#paged(this.#sorted(collected))) {
                await Request.walk(store.openCursor(IDBKeyRange.only(entry.key)), (cursor: IDBCursorWithValue): void => {
                    apply(cursor);

                    affected++;
                });
            }

            this.#emit(Planner.describe(plan), started, affected);

            return affected;
        }

        const visit: (cursor: IDBCursorWithValue) => boolean = (cursor: IDBCursorWithValue): boolean => {
            if (!matches(cursor.value as Record<string, unknown>)) {
                return true;
            }

            seen++;

            if (seen > offset) {
                apply(cursor);

                affected++;
            }

            return ceiling === null || seen < ceiling;
        };

        if (plan.values === null) {
            const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);

            await Request.walk(source.openCursor(plan.range, plan.direction), visit);
        } else {
            for (const value of plan.values) {
                if (ceiling !== null && seen >= ceiling) {
                    break;
                }

                const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);

                await Request.walk(source.openCursor(IDBKeyRange.only(value as IDBValidKey)), visit);
            }
        }

        this.#emit(Planner.describe(plan), started, affected);

        return affected;
    }

    /**
     * Delete every record in the table.
     */
    async truncate(): Promise<void> {
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        await Request.settle(store.clear());

        this.#emit('truncate', started, 0);
    }

    /**
     * Project and deduplicate the records the query returns.
     */
    shape(records: T[]): T[] {
        const columns: readonly string[] | null = this.#query.columns;

        // A joined query has already projected, since only there can a column need qualifying.
        const projected: T[] = columns === null || this.#query.joins.length > 0
            ? records
            : records.map((record: T): T => Object.fromEntries(
                columns.map((expression: string): [string, unknown] => {
                    const projection: Projection = Columns.parse(expression);

                    return [projection.alias, (record as Record<string, unknown>)[projection.column]];
                }),
            ) as T);

        if (!this.#query.distinct) {
            return projected;
        }

        const seen: Set<string> = new Set<string>();

        return projected.filter((record: T): boolean => {
            const signature: string = Signature.of(record as Record<string, unknown>);

            if (seen.has(signature)) {
                return false;
            }

            seen.add(signature);

            return true;
        });
    }

    /**
     * Get the object store the query reads from.
     */
    async #store(mode: IDBTransactionMode, table: string = this.#query.table): Promise<IDBObjectStore> {
        if (this.#query.transaction !== null) {
            return this.#query.transaction.objectStore(table);
        }

        const database: IDBDatabase = await this.#connection.open();

        await this.#connection.schema(table);

        return database.transaction(table, mode).objectStore(table);
    }

    /**
     * Get the single column index that can answer an unconstrained extreme, if there is one.
     */
    async #sole(column: string): Promise<IndexSchema | null> {
        if (this.#query.joins.length > 0 || this.#query.constraints.length > 0) {
            return null;
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);

        return schema.indexes.find((index: IndexSchema): boolean => index.columns.length === 1
            && index.columns[0] === column
            && !index.multiEntry) ?? null;
    }

    /**
     * Run the query, collecting the matching records and their keys.
     */
    async #matched(): Promise<{ records: T[]; keys: IDBValidKey[] }> {
        if (this.#query.joins.length > 0) {
            const rows: Record<string, unknown>[] = await this.#joined();

            return { records: rows as T[], keys: [] };
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const plan: Plan = Planner.plan(this.#query.constraints, this.#query.orders, schema);
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);

        const collected: Entry<T>[] = plan.values === null
            ? await this.#cursored(store, plan, matches)
            : await this.#points(store, plan, matches);

        const ordered: Entry<T>[] = plan.ordered ? collected : this.#sorted(collected);
        const paged: Entry<T>[] = this.#paged(ordered);

        this.#emit(Planner.describe(plan), started, paged.length);

        return {
            records: paged.map((entry: Entry<T>): T => entry.record),
            keys   : paged.map((entry: Entry<T>): IDBValidKey => entry.key),
        };
    }

    /**
     * Collect the records a cursor over the planned source yields.
     */
    async #cursored(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean): Promise<Entry<T>[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: Entry<T>[] = [];
        const ceiling: number | null = plan.ordered && this.#query.limit !== null ? this.#query.offset + this.#query.limit : null;

        await Request.walk(source.openCursor(plan.range, plan.direction), (cursor: IDBCursorWithValue): boolean => {
            if (matches(cursor.value as Record<string, unknown>)) {
                collected.push({ record: cursor.value as T, key: cursor.primaryKey });
            }

            return ceiling === null || collected.length < ceiling;
        });

        return collected;
    }

    /**
     * Collect the records the planned point lookups yield.
     */
    async #points(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean): Promise<Entry<T>[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: Entry<T>[] = [];

        for (const value of plan.values as unknown[]) {
            const range: IDBKeyRange = IDBKeyRange.only(value as IDBValidKey);

            await Request.walk(source.openCursor(range), (cursor: IDBCursorWithValue): void => {
                if (matches(cursor.value as Record<string, unknown>)) {
                    collected.push({ record: cursor.value as T, key: cursor.primaryKey });
                }
            });
        }

        return collected;
    }

    /**
     * Sort the collected records by the requested orders.
     */
    #sorted(collected: Entry<T>[]): Entry<T>[] {
        return Comparator.sort(
            collected,
            this.#query.orders,
            (entry: Entry<T>, column: string): unknown => (entry.record as Record<string, unknown>)[column],
        );
    }

    /**
     * Apply the offset and limit to the collected records.
     */
    #paged<R>(collected: R[]): R[] {
        const from: number = this.#query.offset;

        return this.#query.limit === null ? collected.slice(from) : collected.slice(from, from + this.#query.limit);
    }

    /**
     * Get the columns of every table the query reads, keyed by table.
     */
    async #tables(): Promise<Map<string, string[]>> {
        const tables: Map<string, string[]> = new Map<string, string[]>();
        const names: string[] = [this.#query.table, ...this.#query.joins.map((clause: JoinClause): string => clause.table)];

        for (const name of names) {
            const schema: TableSchema = await this.#connection.schema(name);

            tables.set(name, schema.columns.map((column: ColumnSchema): string => column.name));
        }

        return tables;
    }

    /**
     * Run the joins, returning rows whose keys are all qualified by table.
     */
    async #joined(): Promise<Record<string, unknown>[]> {
        const tables: Map<string, string[]> = await this.#tables();
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();

        let rows: Record<string, unknown>[] = Joiner.qualify(
            await Request.settle(store.getAll() as IDBRequest<Record<string, unknown>[]>),
            this.#query.table,
        );

        for (const clause of this.#query.joins) {
            const other: IDBObjectStore = await this.#store('readonly', clause.table);
            const records: Record<string, unknown>[] = await Request.settle(other.getAll() as IDBRequest<Record<string, unknown>[]>);
            const columns: string[] = (tables.get(clause.table) as string[]).map((column: string): string => `${clause.table}.${column}`);

            rows = Joiner.join(rows, Joiner.qualify(records, clause.table), clause, columns);
        }

        const constraints: Constraint[] = this.#query.constraints.map((constraint: Constraint): Constraint => Joiner.qualified(constraint, tables));
        const orders: Order[] = this.#query.orders.map((order: Order): Order => ({ ...order, column: Columns.resolve(order.column, tables) }));
        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(constraints);

        const kept: Record<string, unknown>[] = rows.filter(matches);
        const sorted: Record<string, unknown>[] = Comparator.sort(kept, orders, (row: Record<string, unknown>, column: string): unknown => row[column]);
        const paged: Record<string, unknown>[] = this.#paged(sorted);

        this.#emit('join', started, paged.length);

        return Joiner.flatten(paged, tables, this.#query.columns);
    }

    /**
     * Announce that the query ran.
     */
    #emit(plan: string, started: number, records: number): void {
        Dispatcher.dispatch(new QueryExecuted(
            this.#connection.name,
            this.#query.table,
            plan,
            this.#query.constraints as Constraint[],
            this.#query.orders as Order[],
            this.#query.limit,
            performance.now() - started,
            records,
        ));
    }
}
