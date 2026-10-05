import { QueryExecuted } from '../events';
import { Dispatcher } from '../events/Dispatcher';
import { SchemaException, UniqueConstraintViolationException } from '../exceptions';
import { Handles } from '../database/Handles';
import { Request } from '../database/Request';
import { Columns } from './Columns';
import { Comparator } from './Comparator';
import { Joiner } from './Joiner';
import { Planner } from './Planner';
import { Predicate } from './Predicate';
import { Signature } from './Signature';
import { Writer } from './Writer';
import type { Connection } from '../database/Connection';
import type { ColumnSchema, ColumnType, IndexSchema, TableSchema } from '../schema/types';
import type { Constraint, JoinClause, Order, Plan, Projection, Query } from './types';

type Entry<T> = { record: T; key: IDBValidKey };

const KEY: unique symbol = Symbol('key');

type Row = Record<string, unknown> & { [KEY]?: IDBValidKey };

type Change = (record: Record<string, unknown>) => Record<string, unknown>;

type Writes = {
    last: Promise<void>;
    failure: { record: Record<string, unknown>; previous: Record<string, unknown>; error: unknown } | null;
};

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
        if (this.#query.joins.length > 0) {
            return 'join';
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);

        return Planner.describe(await this.#planned(schema, await this.#store('readonly')));
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
     * Get the records held under the given keys, skipping any deleted or no longer matching since.
     */
    async fetch(keys: IDBValidKey[]): Promise<T[]> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readonly');

        // Every constraint is checked rather than only the residual, since the one that drove the
        // scan is exactly what a record changed after the keys were taken may no longer meet.
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(this.#prepared(schema));

        const records: (T | undefined)[] = await Promise.all(
            keys.map((key: IDBValidKey): Promise<T | undefined> => Request.settle(store.get(key) as IDBRequest<T | undefined>)),
        );

        return records.filter((record: T | undefined): record is T => {
            return record !== undefined && matches(record as Record<string, unknown>);
        });
    }

    /**
     * Get the record with the given key.
     */
    async find(key: IDBValidKey | null | undefined): Promise<T | null> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const column: ColumnSchema | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === schema.key);
        const prepared: unknown = column === undefined ? key : Planner.convert(key, column.type, this.#connection.timezone);

        if (!Planner.keyable(prepared)) {
            return null;
        }

        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
        const record: T | undefined = await Request.settle(store.get(prepared as IDBValidKey) as IDBRequest<T | undefined>);

        this.#emit('key', started, record === undefined ? 0 : 1);

        return record ?? null;
    }

    /**
     * Count the records matching the query.
     */
    async count(): Promise<number> {
        if (this.#query.joins.length > 0) {
            return this.#tally();
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const plan: Plan = Planner.plan(this.#prepared(schema), [], schema);

        if (plan.residual.length > 0 || plan.values !== null || this.#deduplicates(schema, this.#query.distinct)) {
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
     * Get the numeric values of a column across the records matching the query, each value once when the query is distinct.
     */
    async numbers(column: string): Promise<number[]> {
        const records: Record<string, unknown>[] = (await this.#matched(false)).records as Record<string, unknown>[];

        const held: unknown[] = records
            .map((record: Record<string, unknown>): unknown => record[column])
            .filter((value: unknown): boolean => value !== null && value !== undefined);

        const values: unknown[] = this.#query.distinct
            ? [...new Map<string, unknown>(held.map((value: unknown): [string, unknown] => [Signature.value(value), value])).values()]
            : held;

        return values.map((value: unknown): number => Number(value));
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
        this.writable(ignore ? 'insertOrIgnore' : 'insert');

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        let inserted: number = 0;

        for (const row of rows) {
            try {
                await Writer.add(store, schema, this.#connection.strict, this.#connection.timezone, row as Record<string, unknown>);

                inserted++;
            } catch (error: unknown) {
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
        this.writable('insertGetId');

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();
        const key: IDBValidKey = await Writer.add(store, schema, this.#connection.strict, this.#connection.timezone, record as Record<string, unknown>);

        this.#emit('insert', started, 1);

        return key;
    }

    /**
     * Insert records, updating those that already hold their conflict key.
     */
    async upsert(values: Partial<T>[], columns: string[], update?: string[]): Promise<number> {
        this.writable('upsert');

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const target: IndexSchema | null = Writer.conflict(schema, columns);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        for (const value of values) {
            await Writer.merge(store, schema, this.#connection.strict, this.#connection.timezone, columns, target, value as Record<string, unknown>, update, this.#query.transaction === null);
        }

        this.#emit('upsert', started, values.length);

        return values.length;
    }

    /**
     * Rewrite every record matching the query through the change, or delete it when there is none, in the order the query asks for.
     */
    async modify(change: Change | null, changes: readonly string[] = []): Promise<number> {
        if (this.#query.joins.length > 0) {
            return this.#rewrite(change);
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();
        const plan: Plan = await this.#planned(schema, store);
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);
        const limit: number | null = this.#query.limit;
        const offset: number = this.#query.offset;
        const ceiling: number | null = limit === null ? null : offset + limit;

        const arranged: boolean = this.#query.random || this.#query.orders.length > 0;
        const collects: boolean = !plan.ordered && arranged && (limit !== null || offset > 0);
        const writes: Writes = { last: Promise.resolve(), failure: null };
        const apply: (cursor: IDBCursorWithValue) => void = this.#writer(change, writes);

        let seen: number = 0;
        let affected: number = 0;

        if (collects) {
            const collected: Entry<T>[] = plan.values === null
                ? await this.#cursored(store, plan, matches)
                : await this.#points(store, plan, matches);

            for (const entry of this.#paged(this.#sorted(collected))) {
                if (writes.failure !== null) {
                    break;
                }

                await Request.walk(store.openCursor(IDBKeyRange.only(entry.key)), (cursor: IDBCursorWithValue): void => {
                    apply(cursor);

                    affected++;
                });
            }

            await this.#landed(store, schema, writes);

            this.#emit(Planner.describe(plan), started, affected);

            return affected;
        }

        const visit: (cursor: IDBCursorWithValue) => boolean = (cursor: IDBCursorWithValue): boolean => {
            if (writes.failure !== null) {
                return false;
            }

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

        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const moves: boolean = plan.index !== null && this.#moves(schema, plan.index, changes);
        const lookups: unknown[] | null = moves ? await this.#keys(source as IDBIndex, plan) : plan.values;
        const target: IDBObjectStore | IDBIndex = moves ? store : source;

        if (lookups === null) {
            await Request.walk(source.openCursor(plan.range, plan.direction), visit);
        } else {
            for (const value of lookups) {
                if (writes.failure !== null || (ceiling !== null && seen >= ceiling)) {
                    break;
                }

                await Request.walk(target.openCursor(IDBKeyRange.only(value as IDBValidKey)), visit);
            }
        }

        await this.#landed(store, schema, writes);

        this.#emit(Planner.describe(plan), started, affected);

        return affected;
    }

    /**
     * Delete every record in the table.
     */
    async truncate(): Promise<void> {
        this.writable('truncate');

        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = performance.now();

        await Request.settle(store.clear());

        this.#emit('truncate', started, 0);
    }

    /**
     * Refuse a write that has no meaning through a join.
     */
    writable(operation: string): void {
        if (this.#query.joins.length > 0) {
            throw new SchemaException(`Table [${this.#query.table}] does not support ${operation} through a join.`);
        }
    }

    /**
     * Project the records the query returns.
     */
    shape(records: T[]): T[] {
        return records.map((record: T): T => this.#projected(record));
    }

    /**
     * Get a filter that, across every page it is given, lets each row of a distinct query through once.
     */
    async once(): Promise<(rows: T[]) => T[]> {
        if (!this.#deduplicates(await this.#connection.schema(this.#query.table), this.#query.distinct)) {
            return (rows: T[]): T[] => rows;
        }

        const fresh: (row: Record<string, unknown>) => boolean = this.#fresh();

        return (rows: T[]): T[] => rows.filter((row: T): boolean => fresh(row as Record<string, unknown>));
    }

    /**
     * Project a record onto the selected columns.
     */
    #projected(record: T): T {
        const columns: readonly string[] | null = this.#query.columns;

        // A joined query has already projected, since only there can a column need qualifying.
        if (columns === null || this.#query.joins.length > 0) {
            return record;
        }

        return Object.fromEntries(
            columns.map((expression: string): [string, unknown] => {
                const projection: Projection = Columns.parse(expression);

                return [projection.alias, Columns.read(record as Record<string, unknown>, projection.column)];
            }),
        ) as T;
    }

    /**
     * Get a check that passes the first row of each signature it is shown and fails every later one.
     */
    #fresh(): (row: Record<string, unknown>) => boolean {
        const seen: Set<string> = new Set<string>();

        return (row: Record<string, unknown>): boolean => {
            const signature: string = Signature.of(row);

            if (seen.has(signature)) {
                return false;
            }

            seen.add(signature);

            return true;
        };
    }

    /**
     * Determine whether a distinct read of this table can find two records alike, which it cannot when it projects nothing away from records that each hold their key.
     */
    #deduplicates(schema: TableSchema, distinct: boolean): boolean {
        return distinct && (this.#query.columns !== null || schema.key === null);
    }

    /**
     * Get the object store the query reads from.
     */
    async #store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        const table: string = this.#query.table;

        if (this.#query.transaction !== null) {
            return Handles.alive(this.#query.transaction).objectStore(table);
        }

        const database: IDBDatabase = await this.#connection.open();

        await this.#connection.schema(table);

        return database.transaction(table, mode).objectStore(table);
    }

    /**
     * Get the constraints with each value compared to a column of this table converted into its type.
     */
    #prepared(schema: TableSchema): Constraint[] {
        const types: Map<string, ColumnType> = new Map<string, ColumnType>(
            schema.columns.map((column: ColumnSchema): [string, ColumnType] => [column.name, column.type]),
        );

        return Planner.prepare(this.#query.constraints, types, this.#connection.timezone);
    }

    /**
     * Plan the query, setting the orders aside when the index they would walk leaves records out.
     */
    async #planned(schema: TableSchema, store: IDBObjectStore): Promise<Plan> {
        const constraints: Constraint[] = this.#prepared(schema);
        const plan: Plan = Planner.plan(constraints, this.#orders(), schema);

        if (!plan.ordered || plan.index === null || plan.range !== null) {
            return plan;
        }

        const [held, total]: [number, number] = await Promise.all([
            Request.settle(store.index(plan.index).count()),
            Request.settle(store.count()),
        ]);

        return held === total ? plan : Planner.plan(constraints, [], schema);
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
     * Run the query, collecting the matching records and their keys, only the first record of each distinct row when told to.
     */
    async #matched(distinct: boolean = this.#query.distinct): Promise<{ records: T[]; keys: IDBValidKey[] }> {
        if (this.#query.joins.length > 0) {
            const rows: Record<string, unknown>[] = await this.#joined(distinct);

            return { records: rows as T[], keys: [] };
        }

        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
        const plan: Plan = await this.#planned(schema, store);
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);
        const first: ((row: Record<string, unknown>) => boolean) | null = this.#deduplicates(schema, distinct) ? this.#fresh() : null;
        const fresh: ((record: T) => boolean) | null = first === null ? null : (record: T): boolean => first(this.#projected(record) as Record<string, unknown>);

        const collected: Entry<T>[] = plan.values === null
            ? await this.#cursored(store, plan, matches, plan.ordered ? fresh : null)
            : await this.#points(store, plan, matches);

        const ordered: Entry<T>[] = plan.ordered ? collected : this.#sorted(collected);

        const unique: Entry<T>[] = fresh === null || plan.ordered
            ? ordered
            : ordered.filter((entry: Entry<T>): boolean => fresh(entry.record));

        const paged: Entry<T>[] = this.#paged(unique);

        this.#emit(Planner.describe(plan), started, paged.length);

        return {
            records: paged.map((entry: Entry<T>): T => entry.record),
            keys   : paged.map((entry: Entry<T>): IDBValidKey => entry.key),
        };
    }

    /**
     * Determine whether a write changes a column of the index it walks.
     */
    #moves(schema: TableSchema, name: string, changes: readonly string[]): boolean {
        return schema.indexes.some((index: IndexSchema): boolean => index.name === name
            && index.columns.some((column: string): boolean => changes.includes(column)));
    }

    /**
     * Collect the primary keys the planned walk of an index reaches, in the order it reaches them.
     */
    async #keys(index: IDBIndex, plan: Plan): Promise<IDBValidKey[]> {
        const keys: IDBValidKey[] = [];
        const collect: (cursor: IDBCursor) => void = (cursor: IDBCursor): void => {
            keys.push(cursor.primaryKey);
        };

        if (plan.values === null) {
            await Request.walk(index.openKeyCursor(plan.range, plan.direction), collect);

            return keys;
        }

        for (const value of plan.values) {
            await Request.walk(index.openKeyCursor(IDBKeyRange.only(value as IDBValidKey)), collect);
        }

        return keys;
    }

    /**
     * Collect the records a cursor over the planned source yields, only those the fresh check passes when there is one.
     */
    async #cursored(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean, fresh: ((record: T) => boolean) | null = null): Promise<Entry<T>[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: Entry<T>[] = [];
        const ceiling: number | null = plan.ordered && this.#query.limit !== null ? this.#query.offset + this.#query.limit : null;

        await Request.walk(source.openCursor(plan.range, plan.direction), (cursor: IDBCursorWithValue): boolean => {
            if (matches(cursor.value as Record<string, unknown>) && (fresh === null || fresh(cursor.value as T))) {
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
     * Sort the collected records by the requested orders, or shuffle them when the order is random.
     */
    #sorted(collected: Entry<T>[]): Entry<T>[] {
        if (this.#query.random) {
            return this.#shuffled(collected);
        }

        return Comparator.sort(
            collected,
            this.#query.orders,
            (entry: Entry<T>, column: string): unknown => Columns.read(entry.record as Record<string, unknown>, column),
        );
    }

    /**
     * Get a copy of the collected records in a random order.
     */
    #shuffled<R>(collected: R[]): R[] {
        const shuffled: R[] = [...collected];

        for (let index: number = shuffled.length - 1; index > 0; index--) {
            const other: number = Math.floor(Math.random() * (index + 1));

            [shuffled[index], shuffled[other]] = [shuffled[other] as R, shuffled[index] as R];
        }

        return shuffled;
    }

    /**
     * Get the orders the query sorts by, which a random order sets aside.
     */
    #orders(): readonly Order[] {
        return this.#query.random ? [] : this.#query.orders;
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

        for (const [name, schema] of await this.#schemas()) {
            tables.set(name, schema.columns.map((column: ColumnSchema): string => column.name));
        }

        return tables;
    }

    /**
     * Get the schema of every table the query reads, keyed by table.
     */
    async #schemas(): Promise<Map<string, TableSchema>> {
        const schemas: Map<string, TableSchema> = new Map<string, TableSchema>();
        const names: string[] = [this.#query.table, ...this.#query.joins.map((clause: JoinClause): string => clause.table)];

        for (const name of names) {
            schemas.set(name, await this.#connection.schema(name));
        }

        return schemas;
    }

    /**
     * Get the constraints qualified by table, each value converted into the type of the column it is compared with.
     */
    async #qualified(tables: Map<string, string[]>): Promise<Constraint[]> {
        const types: Map<string, ColumnType> = new Map<string, ColumnType>();

        for (const [name, schema] of await this.#schemas()) {
            for (const column of schema.columns) {
                types.set(`${name}.${column.name}`, column.type);
            }
        }

        return Planner.prepare(this.#query.constraints.map((constraint: Constraint): Constraint => Joiner.qualified(constraint, tables)), types, this.#connection.timezone);
    }

    /**
     * Get the object stores of the given tables, all within one transaction.
     */
    async #stores(tables: string[], mode: IDBTransactionMode): Promise<(table: string) => IDBObjectStore> {
        const transaction: IDBTransaction = this.#query.transaction === null
            ? (await this.#connection.open()).transaction(tables, mode)
            : Handles.alive(this.#query.transaction);
        const outside: string | undefined = tables.find((table: string): boolean => !transaction.objectStoreNames.contains(table));

        if (outside !== undefined) {
            throw new SchemaException(`Table [${outside}] is outside the scope of this transaction.`);
        }

        return (table: string): IDBObjectStore => transaction.objectStore(table);
    }

    /**
     * Run the joins and keep the rows the constraints match, each carrying the key of its base record.
     */
    async #combined(tables: Map<string, string[]>, constraints: Constraint[], stores: (table: string) => IDBObjectStore): Promise<Row[]> {
        const store: IDBObjectStore = stores(this.#query.table);

        const [records, keys]: [Record<string, unknown>[], IDBValidKey[]] = await Promise.all([
            Request.settle(store.getAll() as IDBRequest<Record<string, unknown>[]>),
            Request.settle(store.getAllKeys()),
        ]);

        // Held under a symbol, the key travels through every join as the rows are spread together,
        // yet is never read as a column nor flattened into the result. A row a right join keeps for
        // the other table alone has no base record, and so carries none.
        let rows: Row[] = Joiner.qualify(records, this.#query.table).map(
            (row: Record<string, unknown>, index: number): Row => ({ ...row, [KEY]: keys[index] as IDBValidKey }),
        );

        for (const clause of this.#query.joins) {
            const other: Record<string, unknown>[] = await Request.settle(stores(clause.table).getAll() as IDBRequest<Record<string, unknown>[]>);
            const columns: string[] = (tables.get(clause.table) as string[]).map((column: string): string => `${clause.table}.${column}`);

            rows = Joiner.join(rows, Joiner.qualify(other, clause.table), clause, columns);
        }

        return rows.filter(Predicate.compile(constraints));
    }

    /**
     * Run the joins, returning flat rows, only the first of each distinct row when told to.
     */
    async #joined(distinct: boolean): Promise<Record<string, unknown>[]> {
        const tables: Map<string, string[]> = await this.#tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readonly');
        const started: number = performance.now();
        const kept: Row[] = await this.#combined(tables, constraints, stores);
        const orders: Order[] = this.#query.orders.map((order: Order): Order => ({ ...order, column: Columns.resolve(order.column, tables) }));

        const sorted: Row[] = this.#query.random
            ? this.#shuffled(kept)
            : Comparator.sort(kept, orders, (row: Row, column: string): unknown => Columns.read(row, column));
        const rows: Record<string, unknown>[] = distinct
            ? this.#paged(Joiner.flatten(sorted, tables, this.#query.columns).filter(this.#fresh()))
            : Joiner.flatten(this.#paged(sorted), tables, this.#query.columns);

        this.#emit('join', started, rows.length);

        return rows;
    }

    /**
     * Count the rows the joins and the constraints keep, whatever the paging.
     */
    async #tally(): Promise<number> {
        if (this.#query.distinct) {
            return (await this.#joined(true)).length;
        }

        const tables: Map<string, string[]> = await this.#tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readonly');
        const started: number = performance.now();
        const count: number = (await this.#combined(tables, constraints, stores)).length;

        this.#emit('join', started, count);

        return count;
    }

    /**
     * Rewrite each record of this table that the joined rows keep through the change, or delete it when there is none, once however many rows hold it.
     */
    async #rewrite(change: Change | null): Promise<number> {
        if (this.#query.random || this.#query.orders.length > 0 || this.#query.limit !== null || this.#query.offset > 0) {
            throw new SchemaException(`Table [${this.#query.table}] does not support ordering, a limit or an offset on a write through a join.`);
        }

        const tables: Map<string, string[]> = await this.#tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readwrite');
        const store: IDBObjectStore = stores(this.#query.table);
        const started: number = performance.now();
        const keys: Set<IDBValidKey> = new Set<IDBValidKey>();
        const writes: Writes = { last: Promise.resolve(), failure: null };
        const apply: (cursor: IDBCursorWithValue) => void = this.#writer(change, writes);

        for (const row of await this.#combined(tables, constraints, stores)) {
            if (row[KEY] !== undefined) {
                keys.add(row[KEY]);
            }
        }

        let affected: number = 0;

        for (const key of keys) {
            if (writes.failure !== null) {
                break;
            }

            await Request.walk(store.openCursor(IDBKeyRange.only(key)), (cursor: IDBCursorWithValue): void => {
                apply(cursor);

                affected++;
            });
        }

        await this.#landed(store, await this.#connection.schema(this.#query.table), writes);

        this.#emit('join', started, affected);

        return affected;
    }

    /**
     * Get the write to apply under a cursor, noting in the writes the last one issued and the first that fails.
     */
    #writer(change: Change | null, writes: Writes): (cursor: IDBCursorWithValue) => void {
        return (cursor: IDBCursorWithValue): void => {
            if (change === null) {
                cursor.delete();

                return;
            }

            const previous: Record<string, unknown> = cursor.value as Record<string, unknown>;

            let record: Record<string, unknown>;

            try {
                record = change(previous);
            } catch (error: unknown) {
                writes.failure ??= { record: previous, previous, error };

                return;
            }

            writes.last = Request.settle(cursor.update(record), true).then((): void => undefined, (error: unknown): void => {
                writes.failure = { record, previous, error };
            });
        };
    }

    /**
     * Wait for the last write to land, then throw the error the first failed one reports.
     */
    async #landed(store: IDBObjectStore, schema: TableSchema, writes: Writes): Promise<void> {
        // Requests on a transaction complete in the order they were made, so the last write landing
        // means every earlier one has, including any the walk stopped short of waiting for.
        await writes.last;

        if (writes.failure !== null) {
            throw await Writer.failed(store, schema, writes.failure.record, writes.failure.previous, writes.failure.error, this.#query.transaction === null);
        }
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
            this.#orders() as Order[],
            this.#query.limit,
            performance.now() - started,
            records,
        ));
    }
}
