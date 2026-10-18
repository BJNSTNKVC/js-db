import { QueryExecuted } from '../events';
import { Dispatcher } from '../events/Dispatcher';
import { SchemaException } from '../exceptions';
import { Handles } from '../database/Handles';
import { Request } from '../database/Request';
import { Migrator } from '../migrations/Migrator';
import { Enforcer } from '../schema/Enforcer';
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
    later: { key: IDBValidKey; previous: Record<string, unknown> }[];
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
     * The transactions the query opened itself, each settling once finished.
     */
    readonly #opened: Promise<void>[] = [];

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
        return this.#settled(async (): Promise<string> => {
            if (this.#query.joins.length > 0) {
                return 'join';
            }

            const schema: TableSchema = await this.#connection.schema(this.#query.table);

            return Planner.describe(await this.#planned(schema, await this.#store('readonly')));
        });
    }

    /**
     * Get the records matching the query, unshaped.
     */
    async records(): Promise<T[]> {
        return this.#settled(async (): Promise<T[]> => {
            return (await this.#matched()).records;
        });
    }

    /**
     * Get the keys of the records matching the query.
     */
    async keys(): Promise<IDBValidKey[]> {
        return this.#settled(async (): Promise<IDBValidKey[]> => {
            return (await this.#matched(this.#query.distinct, true)).keys;
        });
    }

    /**
     * Get the records under the given keys that still match.
     */
    async fetch(keys: IDBValidKey[]): Promise<T[]> {
        return this.#settled(async (): Promise<T[]> => {
            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const store: IDBObjectStore = await this.#store('readonly');

            // Every constraint is checked rather than only the residual,
            // since the one that drove the scan is exactly what a record
            // changed after the keys were taken may no longer meet.
            const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(this.#prepared(schema));

            const records: (T | undefined)[] = await Promise.all(
                keys.map((key: IDBValidKey): Promise<T | undefined> => Request.settle(store.get(key) as IDBRequest<T | undefined>)),
            );

            return records.filter((record: T | undefined): record is T => {
                return record !== undefined && matches(record as Record<string, unknown>);
            });
        });
    }

    /**
     * Get the record with the given key, if the query matches it.
     */
    async find(key: IDBValidKey | null | undefined): Promise<T | null> {
        return this.#settled(async (): Promise<T | null> => {
            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const column: ColumnSchema | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === schema.key);
            const prepared: unknown = column === undefined ? key : Planner.convert(key, column.type, this.#connection.timezone);

            if (!Planner.keyable(prepared)) {
                return null;
            }

            if (this.#query.joins.length > 0) {
                return this.#sought(prepared as IDBValidKey);
            }

            const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(this.#prepared(schema));
            const store: IDBObjectStore = await this.#store('readonly');
            const started: number = performance.now();
            const record: T | undefined = await Request.settle(store.get(prepared as IDBValidKey) as IDBRequest<T | undefined>);
            const found: T | null = record !== undefined && matches(record as Record<string, unknown>) ? this.#projected(record) : null;

            this.#emit('key', started, found === null ? 0 : 1);

            return found;
        });
    }

    /**
     * Count the records matching the query.
     */
    async count(): Promise<number> {
        return this.#settled(async (): Promise<number> => {
            if (this.#query.joins.length > 0) {
                return this.#tally();
            }

            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const store: IDBObjectStore = await this.#store('readonly');
            const plan: Plan = await this.#planned(schema, store);
            const started: number = performance.now();
            const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
            const fresh: ((row: Record<string, unknown>) => boolean) | null = this.#deduplicates(schema, this.#query.distinct) ? this.#fresh() : null;
            const ranges: (IDBKeyRange | undefined)[] = plan.values === null
                ? [plan.range ?? undefined]
                : plan.values.map((value: unknown): IDBKeyRange => IDBKeyRange.only(value as IDBValidKey));

            const count: number = plan.residual.length > 0 || fresh !== null
                ? await this.#counted(source, ranges, Predicate.compile(plan.residual), fresh)
                : (await Promise.all(ranges.map((range: IDBKeyRange | undefined): Promise<number> => Request.settle(source.count(range)))))
                    .reduce((carry: number, held: number): number => carry + held, 0);

            this.#emit(Planner.describe(plan), started, count);

            return count;
        });
    }

    /**
     * Get the non-null values a column holds across matching records.
     */
    async values(column: string): Promise<unknown[]> {
        return this.#settled(async (): Promise<unknown[]> => {
            const records: Record<string, unknown>[] = (await this.#matched(false)).records as Record<string, unknown>[];

            const held: unknown[] = records
                .map((record: Record<string, unknown>): unknown => Columns.read(record, column))
                .filter((value: unknown): boolean => value !== null && value !== undefined);

            return this.#query.distinct
                ? [...new Map<string, unknown>(held.map((value: unknown): [string, unknown] => [Signature.value(value), value])).values()]
                : held;
        });
    }

    /**
     * Get a column's values across matching records as numbers.
     */
    async numbers(column: string): Promise<number[]> {
        return (await this.values(column)).map((value: unknown): number => Number(value));
    }

    /**
     * Get the value at one end of a column's range.
     */
    async extreme(column: string, direction: IDBCursorDirection, type: ColumnType | undefined): Promise<unknown> {
        return this.#settled(async (): Promise<unknown> => {
            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const index: IndexSchema | null = this.#sole(schema, column);

            if (index !== null) {
                const store: IDBObjectStore = await this.#store('readonly');

                // An index is already sorted, and IndexedDB omits records with no value for
                // its key path, which is exactly what SQL does with nulls.
                // So the answer is its first entry.
                if (await this.#typed(store, schema, index.name) && (!this.#loose(schema, column) || await this.#complete(store, index.name))) {
                    const started: number = performance.now();
                    const cursor: IDBCursorWithValue | null = await Request.settle(store.index(index.name).openCursor(null, direction));

                    this.#emit(`index:${index.name}`, started, cursor === null ? 0 : 1);

                    return cursor === null ? null : cursor.key;
                }
            }

            const values: unknown[] = Enforcer.stored(await this.values(column), type, this.#connection.timezone);

            if (values.length === 0) {
                return null;
            }

            return values.reduce((carry: unknown, value: unknown): unknown => {
                const compared: number = Comparator.compare(value, carry);

                return (direction === 'next' ? compared < 0 : compared > 0) ? value : carry;
            });
        });
    }

    /**
     * Insert records, skipping unique collisions when told to ignore them.
     */
    async insert(rows: Partial<T>[], ignore: boolean = false): Promise<number> {
        return this.#settled(async (): Promise<number> => {
            this.writable(ignore ? 'insertOrIgnore' : 'insert');

            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const store: IDBObjectStore = await this.#store('readwrite');
            const started: number = performance.now();
            const inserted: number = this.#owns(store)
                ? await Writer.addAll(store, schema, this.#connection.strict, this.#connection.timezone, rows as Record<string, unknown>[], ignore)
                : await Writer.addEach(store, schema, this.#connection.strict, this.#connection.timezone, rows as Record<string, unknown>[], ignore);

            this.#emit('insert', started, inserted);

            return inserted;
        });
    }

    /**
     * Insert a record and get the key the database gave it.
     */
    async insertGetId(record: Partial<T>): Promise<IDBValidKey> {
        return this.#settled(async (): Promise<IDBValidKey> => {
            this.writable('insertGetId');

            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const store: IDBObjectStore = await this.#store('readwrite');
            const started: number = performance.now();
            const key: IDBValidKey = await Writer.add(store, schema, this.#connection.strict, this.#connection.timezone, record as Record<string, unknown>);

            this.#emit('insert', started, 1);

            return key;
        });
    }

    /**
     * Insert records, updating those that already hold their conflict key.
     */
    async upsert(values: Partial<T>[], columns: string[], update?: string[]): Promise<number> {
        return this.#settled(async (): Promise<number> => {
            this.writable('upsert');

            const schema: TableSchema = await this.#connection.schema(this.#query.table);
            const target: IndexSchema | null = Writer.conflict(schema, columns);
            const store: IDBObjectStore = await this.#store('readwrite');
            const started: number = performance.now();

            try {
                for (const value of values) {
                    await Writer.merge(store, schema, this.#connection.strict, this.#connection.timezone, columns, target, value as Record<string, unknown>, update);
                }
            } catch (error: unknown) {
                if (this.#owns(store)) {
                    Writer.rollback(store);
                }

                throw error;
            }

            this.#emit('upsert', started, values.length);

            return values.length;
        });
    }

    /**
     * Rewrite or delete every matching record, in the query's order.
     */
    async modify(change: Change | null, changes: readonly string[] = []): Promise<number> {
        return this.#settled(async (): Promise<number> => {
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
            const writes: Writes = { last: Promise.resolve(), failure: null, later: [] };
            const apply: (cursor: IDBCursorWithValue) => void = this.#writer(change, writes);

            let seen: number = 0;
            let affected: number = 0;

            if (collects) {
                const collected: Entry<T>[] = plan.values === null
                    ? await this.#cursored(store, plan, matches)
                    : await this.#points(store, plan, matches);

                const keys: IDBValidKey[] = this.#paged(this.#sorted(collected)).map((entry: Entry<T>): IDBValidKey => entry.key);

                await this.#byKey(store, keys, (cursor: IDBCursorWithValue): void => {
                    apply(cursor);

                    affected++;
                }, (): boolean => writes.failure !== null);

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

            const stopped: () => boolean = (): boolean => writes.failure !== null || (ceiling !== null && seen >= ceiling);
            const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);

            if (plan.index !== null && this.#moves(schema, plan.index, changes)) {
                await this.#byKey(store, await this.#keys(source, plan), (cursor: IDBCursorWithValue): boolean => !stopped() && visit(cursor), stopped);
            } else if (plan.values === null) {
                await Request.walk(source.openCursor(plan.range, plan.direction), visit);
            } else {
                for (const value of plan.values) {
                    if (stopped()) {
                        break;
                    }

                    await Request.walk(source.openCursor(IDBKeyRange.only(value as IDBValidKey)), visit);
                }
            }

            await this.#landed(store, schema, writes);

            this.#emit(Planner.describe(plan), started, affected);

            return affected;
        });
    }

    /**
     * Delete every record in the table.
     */
    async truncate(): Promise<void> {
        return this.#settled(async (): Promise<void> => {
            this.writable('truncate');

            const store: IDBObjectStore = await this.#store('readwrite');
            const started: number = performance.now();

            await Request.settle(store.clear());

            this.#emit('truncate', started, 0);
        });
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
     * Get a filter letting each distinct row through once across pages.
     */
    async once(): Promise<(rows: T[]) => T[]> {
        if (!this.#deduplicates(await this.#connection.schema(this.#query.table), this.#query.distinct)) {
            return (rows: T[]): T[] => rows;
        }

        const fresh: (row: Record<string, unknown>) => boolean = this.#fresh();

        return (rows: T[]): T[] => rows.filter((row: T): boolean => fresh(row as Record<string, unknown>));
    }

    /**
     * Get the columns of every table the query reads, keyed by table.
     */
    async tables(): Promise<Map<string, string[]>> {
        const tables: Map<string, string[]> = new Map<string, string[]>();

        for (const [name, schema] of await this.#schemas()) {
            tables.set(name, schema.columns.map((column: ColumnSchema): string => column.name));
        }

        return tables;
    }

    /**
     * Project a record onto the selected columns.
     */
    #projected(record: T): T {
        const columns: readonly string[] | null = this.#query.columns;

        // A joined query has already projected, since
        // only there can a column need qualifying.
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
     * Get a check that passes only the first row of each signature.
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
     * Determine whether a distinct read of this table must drop duplicates.
     */
    #deduplicates(schema: TableSchema, distinct: boolean): boolean {
        // Records that each hold their key can never be
        // alike unless a projection drops columns.
        return distinct && (this.#query.columns !== null || schema.key === null);
    }

    /**
     * Get the object store the query reads from.
     */
    async #store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        const table: string = this.#query.table;
        const transaction: IDBTransaction | null = this.#transaction();

        if (transaction !== null) {
            return transaction.objectStore(table);
        }

        const database: IDBDatabase = await this.#connection.open();

        await this.#connection.schema(table);

        return this.#own(database.transaction(table, mode)).objectStore(table);
    }

    /**
     * Track a transaction the query opened itself until it has finished.
     */
    #own(transaction: IDBTransaction): IDBTransaction {
        this.#opened.push(new Promise<void>((resolve: () => void): void => {
            transaction.addEventListener('complete', resolve);
            transaction.addEventListener('abort', resolve);
        }));

        return transaction;
    }

    /**
     * Run a call, settling only once the transactions it opened have finished.
     */
    async #settled<R>(call: () => Promise<R>): Promise<R> {
        const mark: number = this.#opened.length;

        try {
            return await call();
        } finally {
            // A call made from another waits only for what it opened itself,
            // since the caller's own transaction may still be in use.
            await Promise.all(this.#opened.splice(mark));
        }
    }

    /**
     * Get the constraints with each value converted to its column's type.
     */
    #prepared(schema: TableSchema, constraints: readonly Constraint[] = this.#query.constraints): Constraint[] {
        const types: Map<string, ColumnType> = new Map<string, ColumnType>(
            schema.columns.map((column: ColumnSchema): [string, ColumnType] => [column.name, column.type]),
        );

        return Planner.prepare(constraints, types, this.#connection.timezone);
    }

    /**
     * Plan the query over a source that can answer it.
     */
    async #planned(schema: TableSchema, store: IDBObjectStore, constraints: Constraint[] = this.#prepared(schema), sorting: readonly Order[] = this.#orders()): Promise<Plan> {
        const excluded: Set<string | null> = new Set<string | null>();

        let orders: readonly Order[] = sorting;

        for (;;) {
            const plan: Plan = Planner.plan(constraints, orders, schema, excluded);

            if (plan.source === 'scan') {
                return plan;
            }

            const counted: boolean = plan.ordered && plan.index !== null && plan.range === null;

            const [typed, complete]: [boolean, boolean] = await Promise.all([
                this.#typed(store, schema, plan.index),
                counted ? this.#complete(store, plan.index as string) : Promise.resolve(true),
            ]);

            if (!typed) {
                excluded.add(plan.index);
            } else if (!complete) {
                orders = [];
            } else {
                return plan;
            }
        }
    }

    /**
     * Determine whether an index holds an entry for every record.
     */
    async #complete(store: IDBObjectStore, index: string): Promise<boolean> {
        const [held, total]: [number, number] = await Promise.all([
            Request.settle(store.index(index).count()),
            Request.settle(store.count()),
        ]);

        return held === total;
    }

    /**
     * Determine whether every key of an index is of its column's type.
     */
    async #typed(store: IDBObjectStore, schema: TableSchema, index: string | null): Promise<boolean> {
        const column: string | null | undefined = index === null
            ? schema.key
            : schema.indexes.find((candidate: IndexSchema): boolean => candidate.name === index)?.columns[0];

        const type: ColumnType | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === column)?.type;

        if (type === undefined || type === 'json') {
            return true;
        }

        const source: IDBObjectStore | IDBIndex = index === null ? store : store.index(index);

        // IndexedDB orders keys by type first, so the first
        // and last keys tell the type of every one.
        const [first, last]: [IDBCursor | null, IDBCursor | null] = await Promise.all([
            Request.settle(source.openKeyCursor(null, 'next')),
            Request.settle(source.openKeyCursor(null, 'prev')),
        ]);

        if (first === null || last === null) {
            return true;
        }

        switch (type) {
            case 'integer':
            case 'float':
            case 'decimal':
                return typeof last.key === 'number';

            case 'date':
            case 'datetime':
                return first.key instanceof Date && last.key instanceof Date;

            case 'string':
            case 'enum':
                return typeof first.key === 'string' && typeof last.key === 'string';

            default:
                return false;
        }
    }

    /**
     * Determine whether a column may hold a value of any kind.
     */
    #loose(schema: TableSchema, column: string): boolean {
        const type: ColumnType | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === column)?.type;

        return type === undefined || type === 'json';
    }

    /**
     * Get the single column index that can answer an unconstrained extreme.
     */
    #sole(schema: TableSchema, column: string): IndexSchema | null {
        if (this.#query.joins.length > 0 || this.#query.constraints.length > 0) {
            return null;
        }

        if (schema.columns.some((candidate: ColumnSchema): boolean => candidate.name === column && candidate.type === 'boolean')) {
            return null;
        }

        return schema.indexes.find((index: IndexSchema): boolean => index.columns.length === 1
            && index.columns[0] === column
            && !index.multiEntry) ?? null;
    }

    /**
     * Run the query, collecting the matching keys and, unless told not to, records.
     */
    async #matched(distinct: boolean = this.#query.distinct, bare: boolean = false): Promise<{ records: T[]; keys: IDBValidKey[] }> {
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
        const follows: boolean = plan.ordered || (this.#query.orders.length === 0 && !this.#query.random);
        const skipped: number = follows && plan.values === null && plan.residual.length === 0 && fresh === null ? this.#query.offset : 0;
        const ceiling: number | null = follows && this.#query.limit !== null ? this.#query.offset - skipped + this.#query.limit : null;

        if (bare && follows && plan.residual.length === 0 && fresh === null) {
            const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
            const keys: IDBValidKey[] = this.#paged(await this.#keys(source, plan, skipped, ceiling), this.#query.offset - skipped);

            this.#emit(Planner.describe(plan), started, keys.length);

            return { records: [], keys };
        }

        const collected: Entry<T>[] = plan.values === null
            ? await this.#cursored(store, plan, matches, follows ? fresh : null, skipped, ceiling)
            : await this.#points(store, plan, matches, follows ? fresh : null, ceiling);

        const ordered: Entry<T>[] = follows ? collected : this.#sorted(collected);

        const unique: Entry<T>[] = fresh === null || follows
            ? ordered
            : ordered.filter((entry: Entry<T>): boolean => fresh(entry.record));

        const paged: Entry<T>[] = this.#paged(unique, this.#query.offset - skipped);

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
     * Collect the primary keys a planned walk reaches, in order.
     */
    async #keys(source: IDBObjectStore | IDBIndex, plan: Plan, skip: number = 0, ceiling: number | null = null): Promise<IDBValidKey[]> {
        if (plan.values === null && this.#batched(plan, skip, ceiling, false)) {
            return Request.settle(source.getAllKeys(plan.range, ceiling ?? undefined));
        }

        let keys: IDBValidKey[] = [];

        if (plan.values === null) {
            await Request.walk(source.openKeyCursor(plan.range, plan.direction), (cursor: IDBCursor): boolean => {
                keys.push(cursor.primaryKey);

                return ceiling === null || keys.length < ceiling;
            }, skip);

            return keys;
        }

        for (const value of plan.values) {
            if (ceiling !== null && keys.length >= ceiling) {
                break;
            }

            const left: number | undefined = ceiling === null || ceiling - keys.length >= 2 ** 32 ? undefined : ceiling - keys.length;

            keys = keys.concat(await Request.settle(source.getAllKeys(IDBKeyRange.only(value as IDBValidKey), left)));
        }

        return keys;
    }

    /**
     * Determine whether one getAll can read what a walk would collect.
     */
    #batched(plan: Plan, skip: number, ceiling: number | null, filtered: boolean): boolean {
        // IndexedDB reads a count of 0 as no limit at all,
        // and getAll throws on a count of 2^32 or more,
        // so either ceiling keeps the cursor.
        return plan.direction === 'next' && skip === 0 && (ceiling === null || (!filtered && ceiling > 0 && ceiling < 2 ** 32));
    }

    /**
     * Collect the records a walk over the planned source yields.
     */
    async #cursored(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean, fresh: ((record: T) => boolean) | null = null, skip: number = 0, ceiling: number | null = null): Promise<Entry<T>[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);

        if (this.#batched(plan, skip, ceiling, plan.residual.length > 0 || fresh !== null)) {
            const [records, keys]: [T[], IDBValidKey[]] = await Promise.all([
                Request.settle(source.getAll(plan.range, ceiling ?? undefined) as IDBRequest<T[]>),
                Request.settle(source.getAllKeys(plan.range, ceiling ?? undefined)),
            ]);

            return records
                .map((record: T, index: number): Entry<T> => ({ record, key: keys[index] as IDBValidKey }))
                .filter((entry: Entry<T>): boolean => matches(entry.record as Record<string, unknown>) && (fresh === null || fresh(entry.record)));
        }

        const collected: Entry<T>[] = [];

        await Request.walk(source.openCursor(plan.range, plan.direction), (cursor: IDBCursorWithValue): boolean => {
            if (matches(cursor.value as Record<string, unknown>) && (fresh === null || fresh(cursor.value as T))) {
                collected.push({ record: cursor.value as T, key: cursor.primaryKey });
            }

            return ceiling === null || collected.length < ceiling;
        }, skip);

        return collected;
    }

    /**
     * Collect the records the planned point lookups yield.
     */
    async #points(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean, fresh: ((record: T) => boolean) | null = null, ceiling: number | null = null): Promise<Entry<T>[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: Entry<T>[] = [];

        for (const value of plan.values as unknown[]) {
            if (ceiling !== null && collected.length >= ceiling) {
                break;
            }

            const range: IDBKeyRange = IDBKeyRange.only(value as IDBValidKey);

            await Request.walk(source.openCursor(range), (cursor: IDBCursorWithValue): boolean => {
                if (matches(cursor.value as Record<string, unknown>) && (fresh === null || fresh(cursor.value as T))) {
                    collected.push({ record: cursor.value as T, key: cursor.primaryKey });
                }

                return ceiling === null || collected.length < ceiling;
            });
        }

        return collected;
    }

    /**
     * Count the records the ranges hold that pass the filters.
     */
    async #counted(source: IDBObjectStore | IDBIndex, ranges: (IDBKeyRange | undefined)[], matches: (record: Record<string, unknown>) => boolean, fresh: ((row: Record<string, unknown>) => boolean) | null): Promise<number> {
        const read: T[][] = await Promise.all(ranges.map((range: IDBKeyRange | undefined): Promise<T[]> => Request.settle(source.getAll(range) as IDBRequest<T[]>)));

        return read.flat().filter((record: T): boolean => {
            return matches(record as Record<string, unknown>) && (fresh === null || fresh(this.#projected(record) as Record<string, unknown>));
        }).length;
    }

    /**
     * Sort the collected records by the orders, or shuffle them.
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
     * Get the orders the query sorts by, unless it is random.
     */
    #orders(): readonly Order[] {
        return this.#query.random ? [] : this.#query.orders;
    }

    /**
     * Apply the offset and limit to the collected records.
     */
    #paged<R>(collected: R[], from: number = this.#query.offset): R[] {
        return this.#query.limit === null ? collected.slice(from) : collected.slice(from, from + this.#query.limit);
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
     * Get the constraints qualified by table, values in their column's type.
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
        const transaction: IDBTransaction = this.#transaction() ?? this.#own((await this.#connection.open()).transaction(tables, mode));
        const outside: string | undefined = tables.find((table: string): boolean => !transaction.objectStoreNames.contains(table));

        if (outside !== undefined) {
            throw new SchemaException(`Table [${outside}] is outside the scope of this transaction.`);
        }

        return (table: string): IDBObjectStore => transaction.objectStore(table);
    }

    /**
     * Get the transaction the query joins, refusing one that no longer accepts requests.
     */
    #transaction(): IDBTransaction | null {
        const transaction: IDBTransaction | null = this.#query.transaction === null ? null : Handles.alive(this.#query.transaction);

        if (transaction !== null && transaction === Migrator.context()?.transaction) {
            Migrator.alive();
        }

        return transaction ?? this.#connection.migrating();
    }

    /**
     * Determine whether the query opened the store's transaction itself.
     */
    #owns(store: IDBObjectStore): boolean {
        return store.transaction !== this.#query.transaction && store.transaction !== Migrator.context()?.transaction;
    }

    /**
     * Run the joins and keep the rows the constraints match.
     */
    async #combined(tables: Map<string, string[]>, constraints: Constraint[], stores: (table: string) => IDBObjectStore): Promise<Row[]> {
        const entries: Entry<T>[] = await this.#based(tables, stores(this.#query.table));
        const records: Record<string, unknown>[] = entries.map((entry: Entry<T>): Record<string, unknown> => entry.record as Record<string, unknown>);

        // Held under a symbol, the key travels through every join as the
        // rows are spread together, yet is never read as a column nor
        // flattened into the result. A row a right join keeps for the
        // other table alone has no base record, and so carries none.
        let rows: Row[] = Joiner.qualify(records, this.#query.table).map(
            (row: Record<string, unknown>, index: number): Row => ({ ...row, [KEY]: (entries[index] as Entry<T>).key }),
        );

        for (const clause of this.#query.joins) {
            const other: Record<string, unknown>[] = await Request.settle(stores(clause.table).getAll() as IDBRequest<Record<string, unknown>[]>);
            const columns: string[] = (tables.get(clause.table) as string[]).map((column: string): string => `${clause.table}.${column}`);

            rows = Joiner.join(rows, Joiner.qualify(other, clause.table), clause, columns);
        }

        return rows.filter(Predicate.compile(constraints));
    }

    /**
     * Read the base records its own constraints allow, in key order.
     */
    async #based(tables: Map<string, string[]>, store: IDBObjectStore): Promise<Entry<T>[]> {
        const schema: TableSchema = await this.#connection.schema(this.#query.table);
        const plan: Plan = await this.#planned(schema, store, this.#pushed(tables, schema), []);
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);

        const collected: Entry<T>[] = plan.values === null
            ? await this.#cursored(store, plan, matches)
            : await this.#points(store, plan, matches);

        // An index yields its records in index order,
        // and lookups yield them value by value,
        // so both are put back in key order.
        return plan.index === null && plan.values === null
            ? collected
            : collected.sort((first: Entry<T>, second: Entry<T>): number => indexedDB.cmp(first.key, second.key));
    }

    /**
     * Get the constraints naming only the base table, unqualified and prepared.
     */
    #pushed(tables: Map<string, string[]>, schema: TableSchema): Constraint[] {
        const table: string = this.#query.table;
        const constraints: Constraint[] = this.#query.constraints.map((constraint: Constraint): Constraint => Joiner.qualified(constraint, tables));

        if (Planner.disjunctive(constraints) || this.#query.joins.some((clause: JoinClause): boolean => clause.type === 'right' || clause.table === table)) {
            return [];
        }

        return this.#prepared(schema, constraints
            .filter((constraint: Constraint): boolean => Joiner.confined(constraint, table))
            .map((constraint: Constraint): Constraint => Joiner.unqualified(constraint)));
    }

    /**
     * Run the joins, returning flat rows.
     */
    async #joined(distinct: boolean): Promise<Record<string, unknown>[]> {
        const tables: Map<string, string[]> = await this.tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readonly');
        const started: number = performance.now();
        const sorted: Row[] = this.#arranged(await this.#combined(tables, constraints, stores), tables);
        const rows: Record<string, unknown>[] = distinct
            ? this.#paged(Joiner.flatten(sorted, tables, this.#query.columns).filter(this.#fresh()))
            : Joiner.flatten(this.#paged(sorted), tables, this.#query.columns);

        this.#emit('join', started, rows.length);

        return rows;
    }

    /**
     * Get the first joined row holding the record with the given key.
     */
    async #sought(key: IDBValidKey): Promise<T | null> {
        const tables: Map<string, string[]> = await this.tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readonly');
        const started: number = performance.now();

        const held: Row[] = (await this.#combined(tables, constraints, stores)).filter((row: Row): boolean => {
            return row[KEY] !== undefined && indexedDB.cmp(row[KEY], key) === 0;
        });

        const rows: Record<string, unknown>[] = Joiner.flatten(this.#arranged(held, tables).slice(0, 1), tables, this.#query.columns);

        this.#emit('join', started, rows.length);

        return (rows[0] as T | undefined) ?? null;
    }

    /**
     * Sort the joined rows in the query's order, or shuffle them.
     */
    #arranged(rows: Row[], tables: Map<string, string[]>): Row[] {
        const orders: Order[] = this.#query.orders.map((order: Order): Order => ({ ...order, column: Columns.resolve(order.column, tables) }));

        return this.#query.random
            ? this.#shuffled(rows)
            : Comparator.sort(rows, orders, (row: Row, column: string): unknown => Columns.read(row, column));
    }

    /**
     * Count the rows the joins and the constraints keep, whatever the paging.
     */
    async #tally(): Promise<number> {
        if (this.#query.distinct) {
            return (await this.#joined(true)).length;
        }

        const tables: Map<string, string[]> = await this.tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readonly');
        const started: number = performance.now();
        const count: number = (await this.#combined(tables, constraints, stores)).length;

        this.#emit('join', started, count);

        return count;
    }

    /**
     * Rewrite or delete each record the joined rows keep, once each.
     */
    async #rewrite(change: Change | null): Promise<number> {
        if (this.#query.random || this.#query.orders.length > 0 || this.#query.limit !== null || this.#query.offset > 0) {
            throw new SchemaException(`Table [${this.#query.table}] does not support ordering, a limit or an offset on a write through a join.`);
        }

        const tables: Map<string, string[]> = await this.tables();
        const constraints: Constraint[] = await this.#qualified(tables);
        const stores: (table: string) => IDBObjectStore = await this.#stores([...tables.keys()], 'readwrite');
        const store: IDBObjectStore = stores(this.#query.table);
        const started: number = performance.now();
        const keys: Set<IDBValidKey> = new Set<IDBValidKey>();
        const writes: Writes = { last: Promise.resolve(), failure: null, later: [] };
        const apply: (cursor: IDBCursorWithValue) => void = this.#writer(change, writes);

        for (const row of await this.#combined(tables, constraints, stores)) {
            if (row[KEY] !== undefined) {
                keys.add(row[KEY]);
            }
        }

        let affected: number = 0;

        await this.#byKey(store, keys, (cursor: IDBCursorWithValue): void => {
            apply(cursor);

            affected++;
        }, (): boolean => writes.failure !== null);

        await this.#landed(store, await this.#connection.schema(this.#query.table), writes);

        this.#emit('join', started, affected);

        return affected;
    }

    /**
     * Get the write to apply under a cursor.
     */
    #writer(change: Change | null, writes: Writes): (cursor: IDBCursorWithValue) => void {
        return (cursor: IDBCursorWithValue): void => {
            if (change === null) {
                cursor.delete();

                return;
            }

            const key: IDBValidKey = cursor.primaryKey;
            const previous: Record<string, unknown> = cursor.value as Record<string, unknown>;

            let record: Record<string, unknown>;

            try {
                record = change(previous);
            } catch (error: unknown) {
                // Cursors opened together all succeed before the first write lands,
                // so a change that fails waits for the write before it,
                // whose own failure comes first in key order.
                writes.last = writes.last.then((): void => {
                    writes.failure ??= { record: previous, previous, error };
                });

                return;
            }

            writes.last = Request.settle(cursor.update(record), true).then((): void => {
                // Writes land in the order they were sent,
                // so one landing after a failure came after it.
                if (writes.failure !== null) {
                    writes.later.push({ key, previous });
                }
            }, (error: unknown): void => {
                writes.failure ??= { record, previous, error };
            });
        };
    }

    /**
     * Walk a cursor to each key, all at once when the write opened its transaction.
     */
    async #byKey(store: IDBObjectStore, keys: Iterable<IDBValidKey>, visit: (cursor: IDBCursorWithValue) => boolean | void, done: () => boolean): Promise<void> {
        if (this.#owns(store)) {
            await Promise.all(Array.from(keys, (key: IDBValidKey): Promise<void> => Request.walk(store.openCursor(IDBKeyRange.only(key)), visit)));

            return;
        }

        for (const key of keys) {
            if (done()) {
                break;
            }

            await Request.walk(store.openCursor(IDBKeyRange.only(key)), visit);
        }
    }

    /**
     * Wait for the writes to land, then throw the first failure.
     */
    async #landed(store: IDBObjectStore, schema: TableSchema, writes: Writes): Promise<void> {
        // Requests on a transaction complete in the order they were made,
        // so the last write landing means every earlier one has,
        // including any the walk stopped short of waiting for.
        await writes.last;

        if (writes.failure !== null) {
            throw await Writer.failed(store, schema, writes.failure.record, writes.failure.previous, writes.failure.error, this.#owns(store), writes.later);
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
