import { QueryExecuted } from '../events';
import { Dispatcher } from '../events/Dispatcher';
import { RecordsNotFoundException, SchemaException, UniqueConstraintViolationException } from '../exceptions';
import { Request } from '../database/Request';
import { Coercer } from '../schema/Coercer';
import { Columns } from './Columns';
import { Comparator } from './Comparator';
import { Join } from './Join';
import { Joiner } from './Joiner';
import { Planner } from './Planner';
import { Grouping } from './Grouping';
import { Predicate } from './Predicate';
import { Signature } from './Signature';
import type { Connection } from '../database/Connection';
import type { ColumnSchema, IndexSchema, TableSchema } from '../schema/types';
import type { Conjunction, Constraint, Direction, JoinClause, JoinType, Key, Operator, Order, Plan, Projection } from './types';

type Nested<T> = (query: Builder<T>) => void;

type Joining = (join: Join) => void;

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
     * The tables joined onto this one.
     */
    #joins: JoinClause[] = [];

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
     * Constrain a column to one of the given values, disjunctively.
     */
    orWhereIn(column: Key<T>, values: unknown[]): this {
        return this.#push({ type: 'in', column, values, conjunction: 'or', not: false });
    }

    /**
     * Constrain a column to none of the given values.
     */
    whereNotIn(column: Key<T>, values: unknown[]): this {
        return this.#push({ type: 'in', column, values, conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to none of the given values, disjunctively.
     */
    orWhereNotIn(column: Key<T>, values: unknown[]): this {
        return this.#push({ type: 'in', column, values, conjunction: 'or', not: true });
    }

    /**
     * Constrain a column to be null.
     */
    whereNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to be null, disjunctively.
     */
    orWhereNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'or', not: false });
    }

    /**
     * Constrain a column to not be null.
     */
    whereNotNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to not be null, disjunctively.
     */
    orWhereNotNull(column: Key<T>): this {
        return this.#push({ type: 'null', column, conjunction: 'or', not: true });
    }

    /**
     * Constrain a column to fall between two values, inclusive.
     */
    whereBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to fall between two values, disjunctively.
     */
    orWhereBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'or', not: false });
    }

    /**
     * Constrain a column to fall outside two values.
     */
    whereNotBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'and', not: true });
    }

    /**
     * Constrain a column to fall outside two values, disjunctively.
     */
    orWhereNotBetween(column: Key<T>, values: [unknown, unknown]): this {
        return this.#push({ type: 'between', column, from: values[0], to: values[1], conjunction: 'or', not: true });
    }

    /**
     * Constrain a column to match a pattern.
     */
    whereLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'like', value: pattern, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to match a pattern, disjunctively.
     */
    orWhereLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'like', value: pattern, conjunction: 'or', not: false });
    }

    /**
     * Constrain a column to not match a pattern.
     */
    whereNotLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'not like', value: pattern, conjunction: 'and', not: false });
    }

    /**
     * Constrain a column to not match a pattern, disjunctively.
     */
    orWhereNotLike(column: Key<T>, pattern: string): this {
        return this.#push({ type: 'basic', column, operator: 'not like', value: pattern, conjunction: 'or', not: false });
    }

    /**
     * Join another table, keeping only the rows that match.
     */
    join<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: Operator | string, second?: string): Builder<R> {
        return this.#join<R>('inner', table, first, operator, second);
    }

    /**
     * Join another table, keeping every row of this one.
     */
    leftJoin<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: Operator | string, second?: string): Builder<R> {
        return this.#join<R>('left', table, first, operator, second);
    }

    /**
     * Join another table, keeping every row of it.
     */
    rightJoin<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: Operator | string, second?: string): Builder<R> {
        return this.#join<R>('right', table, first, operator, second);
    }

    /**
     * Pair every row of this table with every row of another.
     */
    crossJoin<R = Record<string, unknown>>(table: string): Builder<R> {
        this.#joins.push({ table, type: 'cross', conditions: [] });

        return this as unknown as Builder<R>;
    }

    /**
     * Constrain a column against another column of the same row.
     */
    whereColumn(column: Key<T>, operator: Operator | string, other?: string): this {
        return this.#compared('and', column, operator, other);
    }

    /**
     * Constrain a column against another column of the same row, disjunctively.
     */
    orWhereColumn(column: Key<T>, operator: Operator | string, other?: string): this {
        return this.#compared('or', column, operator, other);
    }

    /**
     * Project only the given columns, which may alias what they select.
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
        clone.#joins = [...this.#joins];

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
        const started: number = performance.now();
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
        const started: number = performance.now();
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
        return this.#extreme(column, 'next');
    }

    /**
     * Get the largest value of a column across the records matching the query.
     */
    async max(column: Key<T>): Promise<number | null> {
        return this.#extreme(column, 'prev');
    }

    /**
     * Get the value at one end of a column's range.
     */
    async #extreme(column: Key<T>, direction: IDBCursorDirection): Promise<number | null> {
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

        const values: number[] = await this.#numbers(column);

        if (values.length === 0) {
            return null;
        }

        // Reduced rather than spread, since Math.min(...values) throws past roughly 100k arguments.
        return values.reduce((carry: number, value: number): number => direction === 'next'
            ? Math.min(carry, value)
            : Math.max(carry, value));
    }

    /**
     * Get the single column index that can answer an unconstrained extreme, if there is one.
     */
    async #sole(column: Key<T>): Promise<IndexSchema | null> {
        if (this.#joins.length > 0 || this.#constraints.length > 0) {
            return null;
        }

        const schema: TableSchema = await this.#connection.schema(this.#table);

        return schema.indexes.find((index: IndexSchema): boolean => index.columns.length === 1
            && index.columns[0] === column
            && !index.multiEntry) ?? null;
    }

    /**
     * Walk the records matching the query in chunks.
     */
    async chunk(size: number, callback: (records: T[], page: number) => unknown): Promise<boolean> {
        // A joined row is synthesised and has no key of its own, so its pages are sliced from the
        // materialised result rather than fetched back by key.
        if (this.#joins.length > 0) {
            const rows: T[] = await this.#records();

            for (let index: number = 0; index < rows.length; index += size) {
                if (await callback(rows.slice(index, index + size), Math.floor(index / size) + 1) === false) {
                    return false;
                }
            }

            return true;
        }

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
        const started: number = performance.now();

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
        const started: number = performance.now();
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
        const started: number = performance.now();

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
        const started: number = performance.now();

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
        const started: number = performance.now();
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
     * Add a constraint comparing two columns, allowing the operator to be left implicit.
     */
    #compared(conjunction: Conjunction, column: Key<T>, operator: Operator | string, other?: string): this {
        const resolved: { operator: Operator; other: string } = other === undefined
            ? { operator: '=', other: operator }
            : { operator: operator as Operator, other };

        return this.#push({ type: 'column', column, operator: resolved.operator, other: resolved.other, conjunction, not: false });
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
    async #store(mode: IDBTransactionMode, table: string = this.#table): Promise<IDBObjectStore> {
        if (this.#transaction !== null) {
            return this.#transaction.objectStore(table);
        }

        const database: IDBDatabase = await this.#connection.open();

        await this.#connection.schema(table);

        return database.transaction(table, mode).objectStore(table);
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
     * Record a join, accepting either the column shorthand or a closure of conditions.
     */
    #join<R>(type: JoinType, table: string, first: string | Joining, operator?: Operator | string, second?: string): Builder<R> {
        const clause: Join = new Join();

        if (typeof first === 'function') {
            first(clause);
        } else {
            clause.on(first, operator as Operator | string, second);
        }

        this.#joins.push({ table, type, conditions: clause.conditions() });

        return this as unknown as Builder<R>;
    }

    /**
     * Get the columns of every table the query reads, keyed by table.
     */
    async #tables(): Promise<Map<string, string[]>> {
        const tables: Map<string, string[]> = new Map<string, string[]>();
        const names: string[] = [this.#table, ...this.#joins.map((clause: JoinClause): string => clause.table)];

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
            this.#table,
        );

        for (const clause of this.#joins) {
            const other: IDBObjectStore = await this.#store('readonly', clause.table);
            const records: Record<string, unknown>[] = await Request.settle(other.getAll() as IDBRequest<Record<string, unknown>[]>);
            const columns: string[] = (tables.get(clause.table) as string[]).map((column: string): string => `${clause.table}.${column}`);

            rows = Joiner.join(rows, Joiner.qualify(records, clause.table), clause, columns);
        }

        const constraints: Constraint[] = this.#constraints.map((constraint: Constraint): Constraint => this.#qualified(constraint, tables));
        const orders: Order[] = this.#orders.map((order: Order): Order => ({ ...order, column: Columns.resolve(order.column, tables) }));
        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(constraints);

        const kept: Record<string, unknown>[] = rows.filter(matches);
        const sorted: Record<string, unknown>[] = Comparator.sort(kept, orders, (row: Record<string, unknown>, column: string): unknown => row[column]);
        const from: number = this.#offset;
        const paged: Record<string, unknown>[] = this.#limit === null ? sorted.slice(from) : sorted.slice(from, from + this.#limit);

        this.#emit('join', started, paged.length);

        return this.#flatten(paged, tables);
    }

    /**
     * Qualify every column a constraint names with the table that owns it.
     */
    #qualified(constraint: Constraint, tables: Map<string, string[]>): Constraint {
        if (constraint.type === 'nested') {
            return { ...constraint, constraints: constraint.constraints.map((nested: Constraint): Constraint => this.#qualified(nested, tables)) };
        }

        if (constraint.type === 'column') {
            return { ...constraint, column: Columns.resolve(constraint.column, tables), other: Columns.resolve(constraint.other, tables) };
        }

        return { ...constraint, column: Columns.resolve(constraint.column, tables) };
    }

    /**
     * Flatten qualified rows the way SQL does, letting later tables win a collision.
     */
    #flatten(rows: Record<string, unknown>[], tables: Map<string, string[]>): Record<string, unknown>[] {
        if (this.#columns !== null) {
            return rows.map((row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
                (this.#columns as string[]).map((expression: string): [string, unknown] => {
                    const projection: Projection = Columns.parse(expression);

                    return [projection.alias, row[Columns.resolve(projection.column, tables)]];
                }),
            ));
        }

        const order: string[] = [...tables.keys()];

        return rows.map((row: Record<string, unknown>): Record<string, unknown> => {
            const flat: Record<string, unknown> = {};

            for (const table of order) {
                for (const column of tables.get(table) as string[]) {
                    if (Object.hasOwn(row, `${table}.${column}`)) {
                        flat[column] = row[`${table}.${column}`];
                    }
                }
            }

            return flat;
        });
    }

    /**
     * Run the query, collecting the matching records and their keys.
     */
    async #matched(): Promise<{ records: T[]; keys: IDBValidKey[] }> {
        if (this.#joins.length > 0) {
            const rows: Record<string, unknown>[] = await this.#joined();

            return { records: rows as T[], keys: [] };
        }

        const schema: TableSchema = await this.#connection.schema(this.#table);
        const plan: Plan = Planner.plan(this.#constraints, this.#orders, schema);
        const store: IDBObjectStore = await this.#store('readonly');
        const started: number = performance.now();
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
        // A joined query has already projected, since only there can a column need qualifying.
        const projected: T[] = this.#columns === null || this.#joins.length > 0
            ? records
            : records.map((record: T): T => Object.fromEntries(
                (this.#columns as string[]).map((expression: string): [string, unknown] => {
                    const projection: Projection = Columns.parse(expression);

                    return [projection.alias, (record as Record<string, unknown>)[projection.column]];
                }),
            ) as T);

        if (!this.#distinct) {
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
            performance.now() - started,
            records,
        ));
    }
}
