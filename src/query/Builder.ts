import { QueryExecuted } from '../events';
import { Dispatcher } from '../events/Dispatcher';
import { RecordsNotFoundException, SchemaException, UniqueConstraintViolationException } from '../exceptions';
import { Request } from '../database/Request';
import { Coercer } from '../schema/Coercer';
import { Comparator } from './Comparator';
import { Planner } from './Planner';
import { Grouping } from './Grouping';
import { Predicate } from './Predicate';
import type { Connection } from '../database/Connection';
import type { IndexSchema, TableSchema } from '../schema/types';
import type { Conjunction, Constraint, Direction, Key, Operator, Order, Plan } from './types';

type Nested<T> = (query: Builder<T>) => void;

type Column<T> = Key<T> | Partial<T> | Nested<T>;

export class Builder<T = Record<string, unknown>> {
    /**
     * The connection the query runs on.
     */
    readonly #connection: Connection;

    /**
     * The name of the table the query runs against.
     */
    readonly #table: string;

    /**
     * The transaction the query joins, when it runs inside one.
     */
    readonly #transaction: IDBTransaction | null;

    /**
     * The constraints the query filters by.
     */
    #constraints: Constraint[] = [];

    /**
     * The orders the query sorts by.
     */
    #orders: Order[] = [];

    /**
     * The maximum number of records the query returns.
     */
    #limit: number | null = null;

    /**
     * The number of records the query skips.
     */
    #offset: number = 0;

    /**
     * The columns the query projects, or null for every column.
     */
    #columns: string[] | null = null;

    /**
     * Whether the query removes duplicate records.
     */
    #distinct: boolean = false;

    /**
     * Create a new query builder.
     */
    constructor(connection: Connection, table: string, transaction: IDBTransaction | null = null) {
        this.#connection = connection;
        this.#table = table;
        this.#transaction = transaction;
    }

    /**
     * Get the name of the table the query runs against.
     */
    get table(): string {
        return this.#table;
    }

    /**
     * Add a constraint to the query.
     */
    where(column: Column<T>, operator?: Operator | unknown, value?: unknown): this {
        return this.#constrain('and', false, column, operator, value);
    }

    /**
     * Add a disjunctive constraint to the query.
     */
    orWhere(column: Column<T>, operator?: Operator | unknown, value?: unknown): this {
        return this.#constrain('or', false, column, operator, value);
    }

    /**
     * Add a negated constraint to the query.
     */
    whereNot(column: Column<T>, operator?: Operator | unknown, value?: unknown): this {
        return this.#constrain('and', true, column, operator, value);
    }

    /**
     * Constrain a column to one of the given values.
     */
    whereIn(column: Key<T>, values: unknown[]): this {
        return this.#push({ type: 'in', column, values, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to none of the given values.
     */
    whereNotIn(column: Key<T>, values: unknown[]): this {
        return this.#push({ type: 'in', column, values, conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to be null.
     */
    whereNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to not be null.
     */
    whereNotNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to fall between two values, inclusive.
     */
    whereBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to fall outside two values.
     */
    whereNotBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to match a pattern.
     */
    whereLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'like', value: pattern, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to not match a pattern.
     */
    whereNotLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'not like', value: pattern, conjunction: 'and', not: false });
    }

    /**
     * Project only the given columns.
     */
    select(...columns: (Key<T> | Key<T>[])[]): this {
        this.#columns = columns.flat() as string[];

        return this;
    }

    /**
     * Remove duplicate records from the result.
     */
    distinct(value: boolean = true): this {
        this.#distinct = value;

        return this;
    }

    /**
     * Group the matching records by one or more columns.
     */
    groupBy<G extends (keyof T & string)[]>(...columns: G): Grouping<T, G> {
        // The grouping owns its own ordering and paging, so the fetch it is handed drops this
        // query's, which would otherwise page records before they were ever grouped.
        const records: Builder<T> = this.clone();

        records.#orders = [];
        records.#limit = null;
        records.#offset = 0;

        return new Grouping<T, G>(
            async (): Promise<Record<string, unknown>[]> => await records.#records() as Record<string, unknown>[],
            columns,
        );
    }

    /**
     * Sort the result by a column.
     */
    orderBy(column: Key<T>, direction: Direction = 'asc'): this {
        this.#orders.push({ column, direction });

        return this;
    }

    /**
     * Sort the result by a column, newest first.
     */
    latest(column: Key<T> = 'created_at'): this {
        return this.orderBy(column, 'desc');
    }

    /**
     * Sort the result by a column, oldest first.
     */
    oldest(column: Key<T> = 'created_at'): this {
        return this.orderBy(column, 'asc');
    }

    /**
     * Limit the number of records the query returns.
     */
    limit(value: number): this {
        this.#limit = value;

        return this;
    }

    /**
     * Limit the number of records the query returns.
     */
    take(value: number): this {
        return this.limit(value);
    }

    /**
     * Skip the given number of records.
     */
    offset(value: number): this {
        this.#offset = value;

        return this;
    }

    /**
     * Skip the given number of records.
     */
    skip(value: number): this {
        return this.offset(value);
    }

    /**
     * Limit the query to a single page of records.
     */
    forPage(page: number, perPage: number = 15): this {
        return this.offset((page - 1) * perPage).limit(perPage);
    }

    /**
     * Apply the callback when the value is truthy.
     */
    when(value: unknown, callback: (query: this, value: unknown) => void): this {
        if (value) {
            callback(this, value);
        }

        return this;
    }

    /**
     * Pass the query to the callback and carry on.
     */
    tap(callback: (query: this) => void): this {
        callback(this);

        return this;
    }

    /**
     * Get a copy of the query.
     */
    clone(): Builder<T> {
        const clone: Builder<T> = new Builder<T>(this.#connection, this.#table, this.#transaction);

        clone.#constraints = [...this.#constraints];
        clone.#orders = [...this.#orders];
        clone.#limit = this.#limit;
        clone.#offset = this.#offset;
        clone.#columns = this.#columns === null ? null : [...this.#columns];
        clone.#distinct = this.#distinct;

        return clone;
    }

    /**
     * Dump the state of the query.
     */
    dump(): this {
        console.log({
            table      : this.#table,
            constraints: this.#constraints,
            orders     : this.#orders,
            limit      : this.#limit,
            offset     : this.#offset,
            columns    : this.#columns,
            distinct   : this.#distinct,
        });

        return this;
    }

    /**
     * Describe the plan the query would run under.
     */
    async explain(): Promise<string> {
        const schema: TableSchema = await this.#connection.schema(this.#table);

        return Planner.describe(Planner.plan(this.#constraints, this.#orders, schema));
    }

    /**
     * Get every record matching the query.
     */
    async get(): Promise<T[]> {
        return this.#shape(await this.#records());
    }

    /**
     * Get the first record matching the query.
     */
    async first(): Promise<T | null> {
        const records: T[] = await this.clone().limit(1).get();

        return records[0] ?? null;
    }

    /**
     * Get the first record matching the query, or fail.
     */
    async firstOrFail(): Promise<T> {
        const record: T | null = await this.first();

        if (record === null) {
            throw new RecordsNotFoundException(`No records found in table [${this.#table}].`);
        }

        return record;
    }

    /**
     * Get the record with the given key.
     */
    async find(key: IDBValidKey): Promise<T | null> {
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = Date.now();
        const record: T | undefined = await Request.settle(store.get(key) as IDBRequest<T | undefined>);

        this.#emit('key', started, record === undefined ? 0 : 1);

        return record ?? null;
    }

    /**
     * Get the record with the given key, or fail.
     */
    async findOrFail(key: IDBValidKey): Promise<T> {
        const record: T | null = await this.find(key);

        if (record === null) {
            throw new RecordsNotFoundException(`No record with key [${String(key)}] in table [${this.#table}].`);
        }

        return record;
    }

    /**
     * Get a single column from the first record matching the query.
     */
    async value<V = unknown>(column: Key<T>): Promise<V | null> {
        const record: T | null = await this.clone().first();

        if (record === null) {
            return null;
        }

        return (record as Record<string, unknown>)[column] as V ?? null;
    }

    /**
     * Get a single column from every record matching the query.
     */
    async pluck<V = unknown>(column: Key<T>): Promise<V[]>;
    async pluck<V = unknown>(column: Key<T>, key: Key<T>): Promise<Record<string, V>>;
    async pluck<V = unknown>(column: Key<T>, key?: Key<T>): Promise<V[] | Record<string, V>> {
        const records: Record<string, unknown>[] = await this.#records() as Record<string, unknown>[];

        if (key === undefined) {
            return records.map((record: Record<string, unknown>): V => record[column] as V);
        }

        return Object.fromEntries(records.map((record: Record<string, unknown>): [string, V] => [String(record[key]), record[column] as V]));
    }

    /**
     * Determine whether any record matches the query.
     */
    async exists(): Promise<boolean> {
        return (await this.clone().limit(1).#records()).length > 0;
    }

    /**
     * Determine whether no record matches the query.
     */
    async doesntExist(): Promise<boolean> {
        return !await this.exists();
    }

    /**
     * Count the records matching the query.
     */
    async count(): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const plan: Plan = Planner.plan(this.#constraints, this.#orders, schema);

        if (plan.residual.length > 0 || plan.values !== null) {
            return (await this.#records()).length;
        }

        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = Date.now();
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const count: number = await Request.settle(source.count(plan.range ?? undefined));

        this.#emit(Planner.describe(plan), started, count);

        return count;
    }

    /**
     * Sum a column across the records matching the query.
     */
    async sum(column: Key<T>): Promise<number> {
        return (await this.#numbers(column)).reduce((carry: number, value: number): number => carry + value, 0);
    }

    /**
     * Average a column across the records matching the query.
     */
    async avg(column: Key<T>): Promise<number | null> {
        const values: number[] = await this.#numbers(column);

        if (values.length === 0) {
            return null;
        }

        return values.reduce((carry: number, value: number): number => carry + value, 0) / values.length;
    }

    /**
     * Get the smallest value of a column across the records matching the query.
     */
    async min(column: Key<T>): Promise<number | null> {
        const values: number[] = await this.#numbers(column);

        return values.length === 0 ? null : Math.min(...values);
    }

    /**
     * Get the largest value of a column across the records matching the query.
     */
    async max(column: Key<T>): Promise<number | null> {
        const values: number[] = await this.#numbers(column);

        return values.length === 0 ? null : Math.max(...values);
    }

    /**
     * Walk the records matching the query in chunks.
     */
    async chunk(size: number, callback: (records: T[], page: number) => unknown): Promise<boolean> {
        const keys: IDBValidKey[] = await this.#keys();

        for (let index: number = 0; index < keys.length; index += size) {
            const page: IDBValidKey[] = keys.slice(index, index + size);
            const store: IDBObjectStore = await this.#store('readonly');

            const records: (T | undefined)[] = await Promise.all(
                page.map((key: IDBValidKey): Promise<T | undefined> => Request.settle(store.get(key) as IDBRequest<T | undefined>)),
            );

            const present: T[] = records.filter((record: T | undefined): record is T => record !== undefined);

            if (await callback(this.#shape(present), Math.floor(index / size) + 1) === false) {
                return false;
            }
        }

        return true;
    }

    /**
     * Walk the records matching the query one at a time.
     */
    async each(callback: (record: T, index: number) => unknown): Promise<boolean> {
        let index: number = 0;

        return this.chunk(1, async (records: T[]): Promise<unknown> => callback(records[0] as T, index++));
    }

    /**
     * Insert one or more records into the table.
     */
    async insert(records: Partial<T> | Partial<T>[]): Promise<number> {
        const rows: Partial<T>[] = Array.isArray(records) ? records : [records];
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = Date.now();

        for (const row of rows) {
            await this.#add(store, schema, row);
        }

        this.#emit('insert', started, rows.length);

        return rows.length;
    }

    /**
     * Insert a record and get the key the database gave it.
     */
    async insertGetId(record: Partial<T>): Promise<IDBValidKey> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = Date.now();
        const key: IDBValidKey = await this.#add(store, schema, record);

        this.#emit('insert', started, 1);

        return key;
    }

    /**
     * Update every record matching the query.
     */
    async update(values: Partial<T>): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const prepared: Record<string, unknown> = Coercer.updatable(values as Record<string, unknown>, schema, this.#connection.strict, new Date());

        this.#settled(schema, prepared);

        return this.#modify((cursor: IDBCursorWithValue): void => {
            cursor.update({ ...cursor.value as Record<string, unknown>, ...prepared });
        });
    }

    /**
     * Update the matching record, inserting it when there is none.
     */
    async updateOrInsert(attributes: Partial<T>, values: Partial<T> = {} as Partial<T>): Promise<boolean> {
        const query: Builder<T> = this.clone().where(attributes as Partial<T>);

        if (await query.exists()) {
            await query.update(values);

            return false;
        }

        await this.clone().insert({ ...attributes, ...values });

        return true;
    }

    /**
     * Insert records, updating those that already exist.
     */
    async upsert(values: Partial<T>[], uniqueBy: Key<T> | Key<T>[], update?: Key<T>[]): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const columns: string[] = (Array.isArray(uniqueBy) ? uniqueBy : [uniqueBy]) as string[];
        const target: IndexSchema | null = this.#conflict(schema, columns);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = Date.now();

        for (const value of values) {
            await this.#merge(store, schema, columns, target, value, update);
        }

        this.#emit('upsert', started, values.length);

        return values.length;
    }

    /**
     * Add the given amount to a column of every record matching the query.
     */
    async increment(column: Key<T>, amount: number = 1, extra: Partial<T> = {} as Partial<T>): Promise<number> {
        return this.#step(column, amount, extra);
    }

    /**
     * Subtract the given amount from a column of every record matching the query.
     */
    async decrement(column: Key<T>, amount: number = 1, extra: Partial<T> = {} as Partial<T>): Promise<number> {
        return this.#step(column, -amount, extra);
    }

    /**
     * Delete every record matching the query.
     */
    async delete(): Promise<number> {
        return this.#modify((cursor: IDBCursorWithValue): void => {
            cursor.delete();
        });
    }

    /**
     * Delete every record in the table.
     */
    async truncate(): Promise<void> {
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = Date.now();

        await Request.settle(store.clear());

        this.#emit('truncate', started, 0);
    }

    /**
     * Add a record to the store, reporting a violated constraint by its index.
     */
    async #add(store: IDBObjectStore, schema: TableSchema, record: Partial<T>): Promise<IDBValidKey> {
        const prepared: Record<string, unknown> = Coercer.insertable(record as Record<string, unknown>, schema, this.#connection.strict, new Date());

        try {
            return await Request.settle(store.add(prepared), true);
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'ConstraintError') {
                const index: string | null = await this.#violated(store, schema, prepared);

                if (index !== null) {
                    throw new UniqueConstraintViolationException(this.#table, index);
                }
            }

            throw error;
        }
    }

    /**
     * Find the unique index the record collides with, or null when it cannot be attributed.
     */
    async #violated(store: IDBObjectStore, schema: TableSchema, record: Record<string, unknown>): Promise<string | null> {
        // A generated key is absent from the record, and an absent value is not a valid range.
        if (schema.key !== null && this.#keyable(record[schema.key])) {
            if (await Request.settle(store.count(IDBKeyRange.only(record[schema.key] as IDBValidKey))) > 0) {
                return schema.key;
            }
        }

        for (const index of schema.indexes.filter((candidate: IndexSchema): boolean => candidate.unique)) {
            if (!index.columns.every((column: string): boolean => this.#keyable(record[column]))) {
                continue;
            }

            const key: IDBValidKey = this.#keyOf(index.columns, record);

            if (await Request.settle(store.index(index.name).count(IDBKeyRange.only(key))) > 0) {
                return index.name;
            }
        }

        return null;
    }

    /**
     * Determine whether the value may be used as an IndexedDB key.
     */
    #keyable(value: unknown): boolean {
        return value !== null && value !== undefined;
    }

    /**
     * Build the index key the given columns of a record form.
     */
    #keyOf(columns: string[], record: Record<string, unknown>): IDBValidKey {
        if (columns.length === 1) {
            return record[columns[0] as string] as IDBValidKey;
        }

        return columns.map((column: string): unknown => record[column]) as IDBValidKey;
    }

    /**
     * Resolve the conflict target of an upsert, or fail when it cannot be enforced.
     */
    #conflict(schema: TableSchema, columns: string[]): IndexSchema | null {
        if (columns.length === 1 && columns[0] === schema.key) {
            return null;
        }

        const index: IndexSchema | undefined = schema.indexes.find((candidate: IndexSchema): boolean => candidate.unique
            && candidate.columns.length === columns.length
            && candidate.columns.every((column: string, position: number): boolean => column === columns[position]));

        if (index === undefined) {
            throw new SchemaException(`Upsert on table [${this.#table}] requires [${columns.join(', ')}] to be the key path or a unique index.`);
        }

        return index;
    }

    /**
     * Insert a record, or merge it into the one already holding its conflict key.
     */
    async #merge(store: IDBObjectStore, schema: TableSchema, columns: string[], target: IndexSchema | null, value: Partial<T>, update?: Key<T>[]): Promise<void> {
        if (target === null) {
            await Request.settle(store.put(Coercer.insertable(value as Record<string, unknown>, schema, this.#connection.strict, new Date())));

            return;
        }

        const key: IDBValidKey = this.#keyOf(columns, value as Record<string, unknown>);
        const existing: Record<string, unknown> | undefined = await Request.settle(store.index(target.name).get(IDBKeyRange.only(key)) as IDBRequest<Record<string, unknown> | undefined>);

        if (existing === undefined) {
            await this.#add(store, schema, value);

            return;
        }

        const changes: Record<string, unknown> = update === undefined
            ? value as Record<string, unknown>
            : Object.fromEntries((update as string[]).map((column: string): [string, unknown] => [column, (value as Record<string, unknown>)[column]]));

        const prepared: Record<string, unknown> = Coercer.updatable(changes, schema, this.#connection.strict, new Date());

        this.#settled(schema, prepared);

        await Request.settle(store.put({ ...existing, ...prepared }));
    }

    /**
     * Add the given amount to a column of every record matching the query.
     */
    async #step(column: Key<T>, amount: number, extra: Partial<T>): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const prepared: Record<string, unknown> = Coercer.updatable(extra as Record<string, unknown>, schema, this.#connection.strict, new Date());

        this.#settled(schema, prepared);

        return this.#modify((cursor: IDBCursorWithValue): void => {
            const record: Record<string, unknown> = { ...cursor.value as Record<string, unknown> };
            const current: number = Number(record[column] ?? 0);

            cursor.update({ ...record, ...prepared, [column]: current + amount });
        });
    }

    /**
     * Assert the changes leave the key path of the record alone.
     */
    #settled(schema: TableSchema, changes: Record<string, unknown>): void {
        if (schema.key !== null && Object.hasOwn(changes, schema.key)) {
            throw new SchemaException(`Column [${schema.key}] is the key path of table [${this.#table}] and may not be updated.`);
        }
    }

    /**
     * Apply a change to every record matching the query, in the order the plan scans them.
     */
    async #modify(apply: (cursor: IDBCursorWithValue) => void): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const plan: Plan = Planner.plan(this.#constraints, this.#orders, schema);
        const store: IDBObjectStore = await this.#store('readwrite');
        const started: number = Date.now();
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);
        const ceiling: number | null = this.#limit === null ? null : this.#offset + this.#limit;

        let seen: number = 0;
        let affected: number = 0;

        const visit = (cursor: IDBCursorWithValue): boolean => {
            if (!matches(cursor.value as Record<string, unknown>)) {
                return true;
            }

            seen++;

            if (seen > this.#offset) {
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
                const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);

                await Request.walk(source.openCursor(IDBKeyRange.only(value as IDBValidKey)), visit);
            }
        }

        this.#emit(Planner.describe(plan), started, affected);

        return affected;
    }

    /**
     * Add a constraint of the given shape to the query.
     */
    #constrain(conjunction: Conjunction, not: boolean, column: Column<T>, operator?: Operator | unknown, value?: unknown): this {
        if (typeof column === 'function') {
            const nested: Builder<T> = new Builder<T>(this.#connection, this.#table, this.#transaction)

            ;(column as Nested<T>)(nested);

            return this.#push({ type: 'nested', constraints: nested.#constraints, conjunction, not });
        }

        if (typeof column === 'object' && column !== null) {
            const constraints: Constraint[] = Object.entries(column).map(([key, held]: [string, unknown]): Constraint => ({
                type       : 'basic',
                column     : key,
                operator   : '=',
                value      : held,
                conjunction: 'and',
                not        : false,
            }));

            return this.#push({ type: 'nested', constraints, conjunction, not });
        }

        const resolved: { operator: Operator; value: unknown } = value === undefined
            ? { operator: '=', value: operator }
            : { operator: operator as Operator, value };

        return this.#push({ type: 'basic', column: column as string, operator: resolved.operator, value: resolved.value, conjunction, not });
    }

    /**
     * Append a constraint to the query.
     */
    #push(constraint: Constraint): this {
        this.#constraints.push(constraint);

        return this;
    }

    /**
     * Get the object store the query reads from.
     */
    async #store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        if (this.#transaction !== null) {
            return this.#transaction.objectStore(this.#table);
        }

        const database: IDBDatabase = await this.#connection.open();

        await this.#connection.schema(this.#table);

        return database.transaction(this.#table, mode).objectStore(this.#table);
    }

    /**
     * Get the numeric values of a column across the records matching the query.
     */
    async #numbers(column: Key<T>): Promise<number[]> {
        const records: Record<string, unknown>[] = await this.#records() as Record<string, unknown>[];

        return records
            .map((record: Record<string, unknown>): unknown => record[column])
            .filter((value: unknown): boolean => value !== null && value !== undefined)
            .map((value: unknown): number => Number(value));
    }

    /**
     * Get the records matching the query, unshaped.
     */
    async #records(): Promise<T[]> {
        return (await this.#matched()).records;
    }

    /**
     * Get the keys of the records matching the query.
     */
    async #keys(): Promise<IDBValidKey[]> {
        return (await this.#matched()).keys;
    }

    /**
     * Run the query, collecting the matching records and their keys.
     */
    async #matched(): Promise<{ records: T[]; keys: IDBValidKey[] }> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const plan: Plan = Planner.plan(this.#constraints, this.#orders, schema);
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = Date.now();
        const matches: (record: Record<string, unknown>) => boolean = Predicate.compile(plan.residual);

        const collected: { record: T; key: IDBValidKey }[] = plan.values === null
            ? await this.#cursored(store, plan, matches)
            : await this.#points(store, plan, matches);

        const ordered: { record: T; key: IDBValidKey }[] = plan.ordered ? collected : this.#sorted(collected);
        const paged: { record: T; key: IDBValidKey }[] = this.#paged(ordered);

        this.#emit(Planner.describe(plan), started, paged.length);

        return {
            records: paged.map((entry): T => entry.record),
            keys   : paged.map((entry): IDBValidKey => entry.key),
        };
    }

    /**
     * Collect the records a cursor over the planned source yields.
     */
    async #cursored(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean): Promise<{ record: T; key: IDBValidKey }[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: { record: T; key: IDBValidKey }[] = [];
        const ceiling: number | null = plan.ordered && this.#limit !== null ? this.#offset + this.#limit : null;

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
    async #points(store: IDBObjectStore, plan: Plan, matches: (record: Record<string, unknown>) => boolean): Promise<{ record: T; key: IDBValidKey }[]> {
        const source: IDBObjectStore | IDBIndex = plan.index === null ? store : store.index(plan.index);
        const collected: { record: T; key: IDBValidKey }[] = [];

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
    #sorted(collected: { record: T; key: IDBValidKey }[]): { record: T; key: IDBValidKey }[] {
        return Comparator.sort(
            collected,
            this.#orders,
            (entry, column: string): unknown => (entry.record as Record<string, unknown>)[column],
        );
    }

    /**
     * Apply the offset and limit to the collected records.
     */
    #paged(collected: { record: T; key: IDBValidKey }[]): { record: T; key: IDBValidKey }[] {
        const from: number = this.#offset;

        return this.#limit === null ? collected.slice(from) : collected.slice(from, from + this.#limit);
    }

    /**
     * Project and deduplicate the records the query returns.
     */
    #shape(records: T[]): T[] {
        const projected: T[] = this.#columns === null
            ? records
            : records.map((record: T): T => Object.fromEntries(
                (this.#columns as string[]).map((column: string): [string, unknown] => [column, (record as Record<string, unknown>)[column]]),
            ) as T);

        if (!this.#distinct) {
            return projected;
        }

        const seen: Set<string> = new Set<string>();

        return projected.filter((record: T): boolean => {
            const signature: string = JSON.stringify(record);

            if (seen.has(signature)) {
                return false;
            }

            seen.add(signature);

            return true;
        });
    }

    /**
     * Announce that the query ran.
     */
    #emit(plan: string, started: number, records: number): void {
        Dispatcher.dispatch(new QueryExecuted(
            this.#connection.name,
            this.#table,
            plan,
            this.#constraints,
            this.#orders,
            this.#limit,
            Date.now() - started,
            records,
        ));
    }
}
