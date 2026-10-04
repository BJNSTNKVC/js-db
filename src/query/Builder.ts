import { MultipleRecordsFoundException, RecordsNotFoundException, SchemaException } from '../exceptions';
import { Columns } from './Columns';
import { Join } from './Join';
import { Grouping } from './Grouping';
import { Executor } from './Executor';
import { Writer } from './Writer';
import { Calendar } from '../schema/Calendar';
import { Enforcer } from '../schema/Enforcer';
import type { Connection } from '../database/Connection';
import type { ColumnSchema, TableSchema } from '../schema/types';
import type {
    Conjunction,
    Constraint,
    DateOperator,
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

const EQUALITIES: ReadonlySet<Operator> = new Set<Operator>(['=', '==', '===']);

const INEQUALITIES: ReadonlySet<Operator> = new Set<Operator>(['!=', '<>', '!==']);

const DATE_OPERATORS: ReadonlySet<unknown> = new Set<DateOperator>(['=', '!=', '<>', '<', '>', '<=', '>=']);

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
     * Constrain a date column to fall on, before or after a given day.
     */
    whereDate(column: Key<T>, value: Date | string): this;
    whereDate(column: Key<T>, operator: DateOperator, value: Date | string): this;
    whereDate(column: Key<T>, ...parameters: unknown[]): this {
        const resolved: { operator: DateOperator; value: unknown } = this.#dated(parameters);
        const day: Date = Calendar.read(resolved.value as Date | string);

        // A day is expressed as the range it covers, so an indexed column can still drive the scan
        // and a stored time of day does not have to match.
        const from: Date = Calendar.midnight(day.getFullYear(), day.getMonth(), day.getDate());
        const to: Date = new Date(Calendar.midnight(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1);

        if (resolved.operator === '=') {
            return this.#push({ type: 'between', column, from, to, conjunction: 'and', not: false });
        }

        if (resolved.operator === '!=' || resolved.operator === '<>') {
            const constraints: Constraint[] = [
                { type: 'basic', column, operator: '<', value: from, conjunction: 'and', not: false },
                { type: 'basic', column, operator: '>', value: to, conjunction: 'or', not: false },
            ];

            return this.#push({ type: 'nested', constraints, conjunction: 'and', not: false });
        }

        const bound: Date = resolved.operator === '>' || resolved.operator === '<=' ? to : from;

        return this.#push({ type: 'basic', column, operator: resolved.operator, value: bound, conjunction: 'and', not: false });
    }

    /**
     * Constrain the year of a date column.
     */
    whereYear(column: Key<T>, value: number | string): this;
    whereYear(column: Key<T>, operator: DateOperator, value: number | string): this;
    whereYear(column: Key<T>, ...parameters: unknown[]): this {
        return this.#part('and', column, 'year', parameters);
    }

    /**
     * Constrain the month of a date column, numbered from one.
     */
    whereMonth(column: Key<T>, value: number | string): this;
    whereMonth(column: Key<T>, operator: DateOperator, value: number | string): this;
    whereMonth(column: Key<T>, ...parameters: unknown[]): this {
        return this.#part('and', column, 'month', parameters);
    }

    /**
     * Constrain the day of the month of a date column.
     */
    whereDay(column: Key<T>, value: number | string): this;
    whereDay(column: Key<T>, operator: DateOperator, value: number | string): this;
    whereDay(column: Key<T>, ...parameters: unknown[]): this {
        return this.#part('and', column, 'day', parameters);
    }

    /**
     * Constrain the time of day of a date column, given as HH:MM:SS or HH:MM.
     */
    whereTime(column: Key<T>, value: string): this;
    whereTime(column: Key<T>, operator: DateOperator, value: string): this;
    whereTime(column: Key<T>, operator: string, value?: string): this {
        const resolved: { operator: DateOperator; value: unknown } = this.#dated(value === undefined ? [operator] : [operator, value]);
        const given: string = resolved.value as string;

        // Times compare as strings, so one given without seconds is padded to the stored shape.
        const time: string = /^\d{2}:\d{2}$/.test(given) ? `${given}:00` : given;

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
     * Constrain a JSON array to hold a value, or every one of an array of values.
     */
    whereJsonContains(column: Key<T>, value: unknown): this {
        return this.#push({ type: 'json-contains', column, value, conjunction: 'and', not: false });
    }

    /**
     * Constrain a JSON array to hold a value, or every one of an array of values, disjunctively.
     */
    orWhereJsonContains(column: Key<T>, value: unknown): this {
        return this.#push({ type: 'json-contains', column, value, conjunction: 'or', not: false });
    }

    /**
     * Constrain a JSON array to not hold a value, or not every one of an array of values.
     */
    whereJsonDoesntContain(column: Key<T>, value: unknown): this {
        return this.#push({ type: 'json-contains', column, value, conjunction: 'and', not: true });
    }

    /**
     * Constrain a JSON array to not hold a value, or not every one of an array of values, disjunctively.
     */
    orWhereJsonDoesntContain(column: Key<T>, value: unknown): this {
        return this.#push({ type: 'json-contains', column, value, conjunction: 'or', not: true });
    }

    /**
     * Constrain the number of elements a JSON array holds.
     */
    whereJsonLength(column: Key<T>, value: number): this;
    whereJsonLength(column: Key<T>, operator: Operator, value: number): this;
    whereJsonLength(column: Key<T>, operator: Operator | number, value?: number): this {
        return this.#length('and', column, operator, value);
    }

    /**
     * Constrain the number of elements a JSON array holds, disjunctively.
     */
    orWhereJsonLength(column: Key<T>, value: number): this;
    orWhereJsonLength(column: Key<T>, operator: Operator, value: number): this;
    orWhereJsonLength(column: Key<T>, operator: Operator | number, value?: number): this {
        return this.#length('or', column, operator, value);
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
            async (read: string[]): Promise<Record<string, unknown>[]> => {
                const query: Builder<T> = records.#qualifies(read)
                    ? records.clone().select(read.map((column: string): string => `${column} as ${column}`))
                    : records;

                return await query.#executor().records() as Record<string, unknown>[];
            },
            columns,
            new Map<string, string>(columns.map((column: string): [string, string] => [column, this.#qualifies([column]) ? Columns.named(column) : column])),
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
        if (Number.isFinite(value) && value >= 0) {
            this.#limit = Math.trunc(value);
        }

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
        this.#offset = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

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
    async find(key: IDBValidKey | null | undefined): Promise<T | null> {
        return this.#executor().find(key);
    }

    /**
     * Get the record with the given key, or fail.
     */
    async findOrFail(key: IDBValidKey | null | undefined): Promise<T> {
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
        if (this.#qualifies([column])) {
            return this.clone().select(`${column} as value`).value<V>('value');
        }

        const record: T | null = await this.clone().first();

        if (record === null) {
            return null;
        }

        return Columns.read(record as Record<string, unknown>, column) as V ?? null;
    }

    /**
     * Get a single column from every record matching the query.
     */
    async pluck<V = unknown>(column: Key<T>): Promise<V[]>;
    async pluck<V = unknown>(column: Key<T>, key: Key<T>): Promise<Record<string, V>>;
    async pluck<V = unknown>(column: Key<T>, key?: Key<T>): Promise<V[] | Record<string, V>> {
        if (key === undefined && this.#qualifies([column])) {
            return this.clone().select(`${column} as value`).pluck<V>('value');
        }

        if (key !== undefined && this.#qualifies([column, key])) {
            return this.clone().select(`${column} as value`, `${key} as key`).pluck<V>('value', 'key');
        }

        const records: Record<string, unknown>[] = await this.#executor().records() as Record<string, unknown>[];

        if (key === undefined) {
            return records.map((record: Record<string, unknown>): V => Columns.read(record, column) as V);
        }

        return Object.fromEntries(records.map((record: Record<string, unknown>): [string, V] => [String(Columns.read(record, key)), Columns.read(record, column) as V]));
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
        return this.#aggregated().#executor().count();
    }

    /**
     * Sum a column across the records matching the query.
     */
    async sum(column: Key<T>): Promise<number> {
        return (await this.#aggregated().#executor().numbers(column)).reduce((carry: number, value: number): number => carry + value, 0);
    }

    /**
     * Average a column across the records matching the query.
     */
    async avg(column: Key<T>): Promise<number | null> {
        const values: number[] = await this.#aggregated().#executor().numbers(column);

        if (values.length === 0) {
            return null;
        }

        return values.reduce((carry: number, value: number): number => carry + value, 0) / values.length;
    }

    /**
     * Get the smallest value of a column across the records matching the query.
     */
    async min(column: Key<T>): Promise<number | null> {
        return this.#aggregated().#executor().extreme(column, 'next');
    }

    /**
     * Get the largest value of a column across the records matching the query.
     */
    async max(column: Key<T>): Promise<number | null> {
        return this.#aggregated().#executor().extreme(column, 'prev');
    }

    /**
     * Get a single page of records, alongside the totals a pager needs.
     */
    async paginate(page: number = 1, perPage: number = 15): Promise<Paginated<T>> {
        this.#size('page size', perPage);

        page = Number.isInteger(page) && page >= 1 ? page : 1;

        const total: number = await this.count();
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
        this.#size('chunk size', size);

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
        this.#size('chunk size', size);

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
        const prepared: Record<string, unknown> = await this.#changes(values);

        return this.#executor().modify((record: Record<string, unknown>): Record<string, unknown> => ({ ...record, ...prepared }), Object.keys(prepared));
    }

    /**
     * Update the matching record, inserting it when there is none.
     */
    async updateOrInsert(attributes: Partial<T>, values: Partial<T> = {} as Partial<T>): Promise<boolean> {
        this.#executor().writable('updateOrInsert');

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
        return this.#executor().modify(null);
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
        const own: string = await this.#own(column);

        if (!Number.isFinite(amount)) {
            throw new TypeError(`Unable to step column [${own}] by [${String(amount)}], which is not a finite number.`);
        }

        const schema: TableSchema = await this.#connection.schema(this.#table);
        const strict: boolean = this.#connection.strict;
        const prepared: Record<string, unknown> = await this.#changes(extra);

        return this.#executor().modify((record: Record<string, unknown>): Record<string, unknown> => ({
            ...record,
            ...prepared,
            [own]: Enforcer.field(Number(record[own] ?? 0) + amount, own, schema, strict),
        }), [own, ...Object.keys(prepared)]);
    }

    /**
     * Prepare the changes an update writes, naming each column as this table stores it.
     */
    async #changes(values: Partial<T>): Promise<Record<string, unknown>> {
        const schema: TableSchema = await this.#connection.schema(this.#table);
        const changes: Record<string, unknown> = {};

        for (const [column, value] of Object.entries(values)) {
            changes[await this.#own(column)] = value;
        }

        return Writer.changes(changes, schema, this.#connection.strict);
    }

    /**
     * Name a column as this table stores it, refusing one that belongs to a table it joins.
     */
    async #own(column: string): Promise<string> {
        if (this.#joins.length === 0) {
            return column;
        }

        const { table, name }: { table: string | null; name: string } = Columns.split(column);

        if (table === this.#table) {
            return name;
        }

        if (table === null && !await this.#joinedColumn(name)) {
            return name;
        }

        throw new SchemaException(`Column [${column}] is not a column of table [${this.#table}], the only table a write through a join changes.`);
    }

    /**
     * Determine whether a column belongs to a joined table rather than to this one.
     */
    async #joinedColumn(column: string): Promise<boolean> {
        const declares: (schema: TableSchema) => boolean = (schema: TableSchema): boolean => schema.columns.some((declared: ColumnSchema): boolean => declared.name === column);

        if (declares(await this.#connection.schema(this.#table))) {
            return false;
        }

        for (const clause of this.#joins) {
            if (declares(await this.#connection.schema(clause.table))) {
                return true;
            }
        }

        return false;
    }

    /**
     * Determine whether any of the given columns names its table on a joined query, where the flat row does not hold it.
     */
    #qualifies(columns: string[]): boolean {
        return this.#joins.length > 0 && columns.some((column: string): boolean => Columns.qualified(column));
    }

    /**
     * Get a copy of the query an aggregate can run on, without its paging or its orders.
     */
    #aggregated(): Builder<T> {
        const query: Builder<T> = this.clone();

        query.#limit = null;
        query.#offset = 0;
        query.#orders = [];
        query.#random = false;

        return query;
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
     * Refuse a size that is not a whole number of at least 1.
     */
    #size(name: string, size: number): void {
        if (!Number.isInteger(size) || size < 1) {
            throw new SchemaException(`The ${name} [${size}] is not a whole number of at least 1.`);
        }
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
            const constraints: Constraint[] = Object.entries(column).map(
                ([key, held]: [string, unknown]): Constraint => this.#basic('and', false, key, '=', held),
            );

            return this.#push({ type: 'nested', constraints, conjunction, not });
        }

        // Resolved by how many arguments were passed rather than by an undefined value, so an explicit
        // operator is kept even when the value it compares against is undefined.
        const resolved: { operator: Operator; value: unknown } = parameters.length < 2
            ? { operator: '=', value: parameters[0] }
            : { operator: parameters[0] as Operator, value: parameters[1] };

        return this.#push(this.#basic(conjunction, not, column as string, resolved.operator, resolved.value));
    }

    /**
     * Build a comparison, which Laravel turns into a null check when it tests equality or inequality with null.
     */
    #basic(conjunction: Conjunction, not: boolean, column: string, operator: Operator, value: unknown): Constraint {
        if ((value === null || value === undefined) && (EQUALITIES.has(operator) || INEQUALITIES.has(operator))) {
            return { type: 'null', column, conjunction, not: not !== INEQUALITIES.has(operator) };
        }

        return { type: 'basic', column, operator, value, conjunction, not };
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
     * Add a constraint on one part of a date column, reading a whole number written as a string as that number.
     */
    #part(conjunction: Conjunction, column: Key<T>, part: DatePart, parameters: unknown[]): this {
        const resolved: { operator: DateOperator; value: unknown } = this.#dated(parameters);

        if (typeof resolved.value === 'string' && !/^\d+$/.test(resolved.value)) {
            throw new SchemaException(`The ${part} [${resolved.value}] is not a whole number.`);
        }

        const value: number = typeof resolved.value === 'string' ? Number(resolved.value) : resolved.value as number;

        return this.#push({ type: 'part', column, part, operator: resolved.operator, value, conjunction, not: false });
    }

    /**
     * Resolve the operator and value of a date constraint by how many arguments were passed, refusing an operator a date does not take.
     */
    #dated(parameters: unknown[]): { operator: DateOperator; value: unknown } {
        const resolved: { operator: unknown; value: unknown } = parameters.length < 2
            ? { operator: '=', value: parameters[0] }
            : { operator: parameters[0], value: parameters[1] };

        if (!DATE_OPERATORS.has(resolved.operator)) {
            throw new SchemaException(`The operator [${String(resolved.operator)}] does not compare dates.`);
        }

        return resolved as { operator: DateOperator; value: unknown };
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
     * Add a constraint on the length of a JSON array, allowing the operator to be left implicit.
     */
    #length(conjunction: Conjunction, column: Key<T>, operator: Operator | number, value?: number): this {
        const resolved: { operator: Operator; value: number } = value === undefined
            ? { operator: '=', value: operator as number }
            : { operator: operator as Operator, value };

        return this.#push({ type: 'json-length', column, operator: resolved.operator, value: resolved.value, conjunction, not: false });
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
