import { MultipleRecordsFoundException, RecordsNotFoundException } from '../exceptions';
import { Join } from './Join';
import { Grouping } from './Grouping';
import { Executor } from './Executor';
import { Writer } from './Writer';
import type { Connection } from '../database/Connection';
import type { TableSchema } from '../schema/types';
import type {
    Conjunction,
    Constraint,
    DatePart,
    Direction,
    JoinClause,
    JoinType,
    Key,
    Operator,
    Order,
    Paginated,
    Query
} from './types';

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
     * Whether the query returns its records in a random order, setting its orders aside.
     */
    #random: boolean = false;

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
    where(column: Partial<T> | Nested<T>): this;
    where(column: Key<T>, value: unknown): this;
    where(column: Key<T>, operator: Operator, value: unknown): this;
    where(column: Column<T>, ...parameters: unknown[]): this {
        return this.#constrain('and', false, column, parameters);
    }

    /**
     * Add a disjunctive constraint to the query.
     */
    orWhere(column: Partial<T> | Nested<T>): this;
    orWhere(column: Key<T>, value: unknown): this;
    orWhere(column: Key<T>, operator: Operator, value: unknown): this;
    orWhere(column: Column<T>, ...parameters: unknown[]): this {
        return this.#constrain('or', false, column, parameters);
    }

    /**
     * Add a negated constraint to the query.
     */
    whereNot(column: Partial<T> | Nested<T>): this;
    whereNot(column: Key<T>, value: unknown): this;
    whereNot(column: Key<T>, operator: Operator, value: unknown): this;
    whereNot(column: Column<T>, ...parameters: unknown[]): this {
        return this.#constrain('and', true, column, parameters);
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
     * Constrain a date column to fall on a given day.
     */
    whereDate(column: Key<T>, value: Date | string): this {
        const day: Date = new Date(value);

        // A day is expressed as the range it covers, so an indexed column can still drive the scan
        // and a stored time of day does not have to match.
        const from: Date = new Date(day.getFullYear(), day.getMonth(), day.getDate());
        const to: Date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);

        return this.#push({ type: 'between', column, from, to: new Date(to.getTime() - 1), conjunction: 'and', not: false });
    }

    /**
     * Constrain a date column to fall in a given year.
     */
    whereYear(column: Key<T>, value: number): this {
        return this.#part('and', column, 'year', value);
    }

    /**
     * Constrain a date column to fall in a given month, numbered from one.
     */
    whereMonth(column: Key<T>, value: number): this {
        return this.#part('and', column, 'month', value);
    }

    /**
     * Constrain a date column to fall on a given day of the month.
     */
    whereDay(column: Key<T>, value: number): this {
        return this.#part('and', column, 'day', value);
    }

    /**
     * Constrain the time of day of a date column, given as HH:MM:SS or HH:MM.
     */
    whereTime(column: Key<T>, value: string): this;
    whereTime(column: Key<T>, operator: Operator, value: string): this;
    whereTime(column: Key<T>, operator: string, value?: string): this {
        const resolved: { operator: Operator; value: string } = value === undefined
            ? { operator: '=', value: operator }
            : { operator: operator as Operator, value };

        // Times compare as strings, so one given without seconds is padded to the stored shape.
        const time: string = /^\d{2}:\d{2}$/.test(resolved.value) ? `${resolved.value}:00` : resolved.value;

        return this.#push({ type: 'time', column, operator: resolved.operator, value: time, conjunction: 'and', not: false });
    }

    /**
     * Constrain the query to records where any of the columns meets the comparison.
     */
    whereAny(columns: Key<T>[], value: unknown): this;
    whereAny(columns: Key<T>[], operator: Operator, value: unknown): this;
    whereAny(columns: Key<T>[], ...parameters: unknown[]): this {
        return this.#across('or', false, columns, parameters);
    }

    /**
     * Constrain the query to records where every one of the columns meets the comparison.
     */
    whereAll(columns: Key<T>[], value: unknown): this;
    whereAll(columns: Key<T>[], operator: Operator, value: unknown): this;
    whereAll(columns: Key<T>[], ...parameters: unknown[]): this {
        return this.#across('and', false, columns, parameters);
    }

    /**
     * Constrain the query to records where none of the columns meets the comparison.
     */
    whereNone(columns: Key<T>[], value: unknown): this;
    whereNone(columns: Key<T>[], operator: Operator, value: unknown): this;
    whereNone(columns: Key<T>[], ...parameters: unknown[]): this {
        return this.#across('or', true, columns, parameters);
    }

    /**
     * Join another table, keeping only the rows that match.
     */
    join<R = Record<string, unknown>>(table: string, first: Joining): Builder<R>;
    join<R = Record<string, unknown>>(table: string, first: string, second: string): Builder<R>;
    join<R = Record<string, unknown>>(table: string, first: string, operator: Operator, second: string): Builder<R>;
    join<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: string, second?: string): Builder<R> {
        return this.#join<R>('inner', table, first, operator, second);
    }

    /**
     * Join another table, keeping every row of this one.
     */
    leftJoin<R = Record<string, unknown>>(table: string, first: Joining): Builder<R>;
    leftJoin<R = Record<string, unknown>>(table: string, first: string, second: string): Builder<R>;
    leftJoin<R = Record<string, unknown>>(table: string, first: string, operator: Operator, second: string): Builder<R>;
    leftJoin<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: string, second?: string): Builder<R> {
        return this.#join<R>('left', table, first, operator, second);
    }

    /**
     * Join another table, keeping every row of it.
     */
    rightJoin<R = Record<string, unknown>>(table: string, first: Joining): Builder<R>;
    rightJoin<R = Record<string, unknown>>(table: string, first: string, second: string): Builder<R>;
    rightJoin<R = Record<string, unknown>>(table: string, first: string, operator: Operator, second: string): Builder<R>;
    rightJoin<R = Record<string, unknown>>(table: string, first: string | Joining, operator?: string, second?: string): Builder<R> {
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
    whereColumn(column: Key<T>, other: string): this;
    whereColumn(column: Key<T>, operator: Operator, other: string): this;
    whereColumn(column: Key<T>, operator: string, other?: string): this {
        return this.#compared('and', column, operator, other);
    }

    /**
     * Constrain a column against another column of the same row, disjunctively.
     */
    orWhereColumn(column: Key<T>, other: string): this;
    orWhereColumn(column: Key<T>, operator: Operator, other: string): this;
    orWhereColumn(column: Key<T>, operator: string, other?: string): this {
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
        records.#random = false;
        records.#limit = null;
        records.#offset = 0;

        return new Grouping<T, G>(
            async (): Promise<Record<string, unknown>[]> => await records.#executor().records() as Record<string, unknown>[],
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
     * Return the records in a random order, setting aside any other order until reordered.
     */
    inRandomOrder(): this {
        this.#random = true;

        return this;
    }

    /**
     * Clear every order, including a random one, and sort by a column when one is given.
     */
    reorder(column?: Key<T>, direction: Direction = 'asc'): this {
        this.#orders = [];
        this.#random = false;

        return column === undefined ? this : this.orderBy(column, direction);
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
     * Apply the callback when the value is falsy.
     */
    unless(value: unknown, callback: (query: this, value: unknown) => void): this {
        return this.when(!value, (query: this): void => callback(query, value));
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
        clone.#random = this.#random;
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
        console.log(this.#query());

        return this;
    }

    /**
     * Describe the plan the query would run under.
     */
    async explain(): Promise<string> {
        return this.#executor().explain();
    }

    /**
     * Get every record matching the query.
     */
    async get(): Promise<T[]> {
        const executor: Executor<T> = this.#executor();

        return executor.shape(await executor.records());
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
     * Get the one record matching the query, failing when there is not exactly one.
     */
    async sole(): Promise<T> {
        const records: T[] = await this.clone().limit(2).get();

        if (records.length === 0) {
            throw new RecordsNotFoundException(`No records found in table [${this.#table}].`);
        }

        if (records.length > 1) {
            throw new MultipleRecordsFoundException(this.#table);
        }

        return records[0] as T;
    }

    /**
     * Get the record with the given key.
     */
    async find(key: IDBValidKey): Promise<T | null> {
        return this.#executor().find(key);
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
        const records: Record<string, unknown>[] = await this.#executor().records() as Record<string, unknown>[];

        if (key === undefined) {
            return records.map((record: Record<string, unknown>): V => record[column] as V);
        }

        return Object.fromEntries(records.map((record: Record<string, unknown>): [string, V] => [String(record[key]), record[column] as V]));
    }

    /**
     * Determine whether any record matches the query.
     */
    async exists(): Promise<boolean> {
        return (await this.clone().limit(1).#executor().records()).length > 0;
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
        return this.#executor().count();
    }

    /**
     * Sum a column across the records matching the query.
     */
    async sum(column: Key<T>): Promise<number> {
        return (await this.#executor().numbers(column)).reduce((carry: number, value: number): number => carry + value, 0);
    }

    /**
     * Average a column across the records matching the query.
     */
    async avg(column: Key<T>): Promise<number | null> {
        const values: number[] = await this.#executor().numbers(column);

        if (values.length === 0) {
            return null;
        }

        return values.reduce((carry: number, value: number): number => carry + value, 0) / values.length;
    }

    /**
     * Get the smallest value of a column across the records matching the query.
     */
    async min(column: Key<T>): Promise<number | null> {
        return this.#executor().extreme(column, 'next');
    }

    /**
     * Get the largest value of a column across the records matching the query.
     */
    async max(column: Key<T>): Promise<number | null> {
        return this.#executor().extreme(column, 'prev');
    }

    /**
     * Get a single page of records, alongside the totals a pager needs.
     */
    async paginate(page: number = 1, perPage: number = 15): Promise<Paginated<T>> {
        // Counted from a copy without the paging, since the total is what the query matches rather
        // than what this page returns.
        const counted: Builder<T> = this.clone();

        counted.#limit = null;
        counted.#offset = 0;

        const total: number = await counted.count();
        const data: T[] = await this.clone().forPage(page, perPage).get();

        return {
            data,
            total,
            perPage,
            currentPage: page,
            lastPage   : Math.max(1, Math.ceil(total / perPage)),
        };
    }

    /**
     * Walk the records matching the query in chunks.
     */
    async chunk(size: number, callback: (records: T[], page: number) => unknown): Promise<boolean> {
        const executor: Executor<T> = this.#executor();

        // A joined row is synthesised and has no key of its own, so its pages are sliced from the
        // materialised result rather than fetched back by key.
        if (this.#joins.length > 0) {
            const rows: T[] = await executor.records();

            for (let index: number = 0; index < rows.length; index += size) {
                if (await callback(rows.slice(index, index + size), Math.floor(index / size) + 1) === false) {
                    return false;
                }
            }

            return true;
        }

        const keys: IDBValidKey[] = await executor.keys();
        let page: number = 0;

        for (let index: number = 0; index < keys.length; index += size) {
            const records: T[] = await executor.fetch(keys.slice(index, index + size));

            // Every record on a page may have stopped matching since the keys were taken. A callback
            // never receives an empty page, so the page number counts only the pages delivered.
            if (records.length === 0) {
                continue;
            }

            if (await callback(executor.shape(records), ++page) === false) {
                return false;
            }
        }

        return true;
    }

    /**
     * Walk the records matching the query as an async iterable.
     */
    async *lazy(size: number = 100): AsyncGenerator<T, void, undefined> {
        const executor: Executor<T> = this.#executor();

        // A joined row is synthesised and has no key to fetch it back by, so there is nothing to
        // page over and the materialised result is yielded as it stands.
        if (this.#joins.length > 0) {
            yield* await executor.records();

            return;
        }

        const keys: IDBValidKey[] = await executor.keys();

        // Only the keys are held for the whole walk. Each page of records is fetched when the caller
        // reaches it, and released once consumed.
        for (let index: number = 0; index < keys.length; index += size) {
            yield* executor.shape(await executor.fetch(keys.slice(index, index + size)));
        }
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
        return this.#executor().insert(Array.isArray(records) ? records : [records]);
    }

    /**
     * Insert one or more records, skipping any the unique indexes reject.
     */
    async insertOrIgnore(records: Partial<T> | Partial<T>[]): Promise<number> {
        return this.#executor().insert(Array.isArray(records) ? records : [records], true);
    }

    /**
     * Insert a record and get the key the database gave it.
     */
    async insertGetId(record: Partial<T>): Promise<IDBValidKey> {
        return this.#executor().insertGetId(record);
    }

    /**
     * Update every record matching the query.
     */
    async update(values: Partial<T>): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const prepared: Record<string, unknown> = Writer.changes(values as Record<string, unknown>, schema, this.#connection.strict);

        return this.#executor().modify((cursor: IDBCursorWithValue): void => {
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
        return this.#executor().upsert(values, (Array.isArray(uniqueBy) ? uniqueBy : [uniqueBy]) as string[], update);
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
        return this.#executor().modify((cursor: IDBCursorWithValue): void => {
            cursor.delete();
        });
    }

    /**
     * Delete every record in the table.
     */
    async truncate(): Promise<void> {
        return this.#executor().truncate();
    }

    /**
     * Add the given amount to a column of every record matching the query.
     */
    async #step(column: Key<T>, amount: number, extra: Partial<T>): Promise<number> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const prepared: Record<string, unknown> = Writer.changes(extra as Record<string, unknown>, schema, this.#connection.strict);

        return this.#executor().modify((cursor: IDBCursorWithValue): void => {
            const record: Record<string, unknown> = { ...cursor.value as Record<string, unknown> };
            const current: number = Number(record[column] ?? 0);

            cursor.update({ ...record, ...prepared, [column]: current + amount });
        });
    }

    /**
     * Get the state of the query as a snapshot the executor can read.
     */
    #query(): Query {
        return {
            table      : this.#table,
            transaction: this.#transaction,
            constraints: this.#constraints,
            orders     : this.#orders,
            random     : this.#random,
            limit      : this.#limit,
            offset     : this.#offset,
            columns    : this.#columns,
            distinct   : this.#distinct,
            joins      : this.#joins,
        };
    }

    /**
     * Get an executor for the query as it stands.
     */
    #executor(): Executor<T> {
        return new Executor<T>(this.#connection, this.#query());
    }

    /**
     * Add a constraint of the given shape to the query.
     */
    #constrain(conjunction: Conjunction, not: boolean, column: Column<T>, parameters: unknown[]): this {
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

        // Resolved by how many arguments were passed rather than by an undefined value, so an explicit
        // operator is kept even when the value it compares against is undefined.
        const resolved: { operator: Operator; value: unknown } = parameters.length < 2
            ? { operator: '=', value: parameters[0] }
            : { operator: parameters[0] as Operator, value: parameters[1] };

        return this.#push({ type: 'basic', column: column as string, operator: resolved.operator, value: resolved.value, conjunction, not });
    }

    /**
     * Add a nested group applying the same comparison to each of the columns.
     */
    #across(joiner: Conjunction, not: boolean, columns: Key<T>[], parameters: unknown[]): this {
        const nested: Builder<T> = new Builder<T>(this.#connection, this.#table, this.#transaction);

        for (const column of columns) {
            nested.#constrain(joiner, false, column, parameters);
        }

        return this.#push({ type: 'nested', constraints: nested.#constraints, conjunction: 'and', not });
    }

    /**
     * Add a constraint on one part of a date column.
     */
    #part(conjunction: Conjunction, column: Key<T>, part: DatePart, value: number): this {
        return this.#push({ type: 'part', column, part, value, conjunction, not: false });
    }

    /**
     * Add a constraint comparing two columns, allowing the operator to be left implicit.
     */
    #compared(conjunction: Conjunction, column: Key<T>, operator: string, other?: string): this {
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
     * Record a join, accepting either the column shorthand or a closure of conditions.
     */
    #join<R>(type: JoinType, table: string, first: string | Joining, operator?: string, second?: string): Builder<R> {
        const clause: Join = new Join();

        if (typeof first === 'function') {
            first(clause);
        } else if (second === undefined) {
            clause.on(first, operator as string);
        } else {
            clause.on(first, operator as Operator, second);
        }

        this.#joins.push({ table, type, conditions: clause.conditions() });

        return this as unknown as Builder<R>;
    }
}
