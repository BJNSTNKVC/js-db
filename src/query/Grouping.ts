import { Comparator } from './Comparator';
import { Predicate } from './Predicate';
import type { Aggregation, Aggregations, Conjunction, Constraint, Direction, Grouped, Key, Operator, Order } from './types';

type Records = () => Promise<Record<string, unknown>[]>;

export class Grouping<T, G extends (keyof T & string)[], A extends Aggregations = Record<string, never>> {
    /**
     * Fetch the records matching the query the grouping was opened from.
     */
    readonly #records: Records;

    /**
     * The columns the records are grouped by.
     */
    readonly #columns: G;

    /**
     * The aggregations computed for each group.
     */
    #aggregations: Aggregations = {};

    /**
     * The constraints the groups are filtered by.
     */
    #constraints: Constraint[] = [];

    /**
     * The orders the groups are sorted by.
     */
    #orders: Order[] = [];

    /**
     * The maximum number of groups returned.
     */
    #limit: number | null = null;

    /**
     * The number of groups skipped.
     */
    #offset: number = 0;

    /**
     * Create a new grouping.
     */
    constructor(records: Records, columns: G) {
        this.#records = records;
        this.#columns = columns;
    }

    /**
     * Compute the given aggregations for each group.
     */
    aggregate<N extends Aggregations>(aggregations: N): Grouping<T, G, N> {
        const grouping: Grouping<T, G, N> = new Grouping<T, G, N>(this.#records, this.#columns);

        grouping.#aggregations = aggregations;
        grouping.#constraints = this.#constraints;
        grouping.#orders = this.#orders;
        grouping.#limit = this.#limit;
        grouping.#offset = this.#offset;

        return grouping;
    }

    /**
     * Constrain the groups the query returns.
     */
    having(column: Key<Grouped<T, G, A>>, operator?: Operator | unknown, value?: unknown): this {
        return this.#constrain('and', column, operator, value);
    }

    /**
     * Add a disjunctive constraint on the groups the query returns.
     */
    orHaving(column: Key<Grouped<T, G, A>>, operator?: Operator | unknown, value?: unknown): this {
        return this.#constrain('or', column, operator, value);
    }

    /**
     * Sort the groups by a column or an aggregate.
     */
    orderBy(column: Key<Grouped<T, G, A>>, direction: Direction = 'asc'): this {
        this.#orders.push({ column, direction });

        return this;
    }

    /**
     * Limit the number of groups the query returns.
     */
    limit(value: number): this {
        this.#limit = value;

        return this;
    }

    /**
     * Skip the given number of groups.
     */
    offset(value: number): this {
        this.#offset = value;

        return this;
    }

    /**
     * Get every group matching the query.
     */
    async get(): Promise<Grouped<T, G, A>[]> {
        const grouped: Map<string, Record<string, unknown>[]> = this.#grouped(await this.#records());
        const rows: Record<string, unknown>[] = [];

        for (const members of grouped.values()) {
            rows.push(this.#row(members));
        }

        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(this.#constraints);
        const kept: Record<string, unknown>[] = rows.filter(matches);
        const sorted: Record<string, unknown>[] = this.#sorted(kept);
        const from: number = this.#offset;

        const paged: Record<string, unknown>[] = this.#limit === null
            ? sorted.slice(from)
            : sorted.slice(from, from + this.#limit);

        return paged as Grouped<T, G, A>[];
    }

    /**
     * Get the first group matching the query.
     */
    async first(): Promise<Grouped<T, G, A> | null> {
        return (await this.get())[0] ?? null;
    }

    /**
     * Count the groups matching the query.
     */
    async count(): Promise<number> {
        return (await this.get()).length;
    }

    /**
     * Collect the records into groups, keyed by their grouped column values.
     */
    #grouped(records: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
        const grouped: Map<string, Record<string, unknown>[]> = new Map<string, Record<string, unknown>[]>();

        for (const record of records) {
            const key: string = JSON.stringify(this.#columns.map((column: string): unknown => record[column]));
            const members: Record<string, unknown>[] | undefined = grouped.get(key);

            if (members === undefined) {
                grouped.set(key, [record]);

                continue;
            }

            members.push(record);
        }

        return grouped;
    }

    /**
     * Build the row for a group, carrying its columns and its aggregates.
     */
    #row(members: Record<string, unknown>[]): Record<string, unknown> {
        const row: Record<string, unknown> = {};
        const first: Record<string, unknown> = members[0] as Record<string, unknown>;

        for (const column of this.#columns) {
            row[column] = first[column];
        }

        for (const [alias, aggregation] of Object.entries(this.#aggregations)) {
            row[alias] = this.#aggregate(aggregation, members);
        }

        return row;
    }

    /**
     * Compute a single aggregate over the members of a group.
     */
    #aggregate(aggregation: Aggregation, members: Record<string, unknown>[]): number | null {
        if ('count' in aggregation) {
            return aggregation.count === '*'
                ? members.length
                : this.#values(aggregation.count, members).length;
        }

        const column: string = 'sum' in aggregation
            ? aggregation.sum
            : 'avg' in aggregation
                ? aggregation.avg
                : 'min' in aggregation ? aggregation.min : aggregation.max;

        const values: number[] = this.#values(column, members);

        if ('sum' in aggregation) {
            return values.reduce((carry: number, value: number): number => carry + value, 0);
        }

        if (values.length === 0) {
            return null;
        }

        if ('avg' in aggregation) {
            return values.reduce((carry: number, value: number): number => carry + value, 0) / values.length;
        }

        return 'min' in aggregation ? Math.min(...values) : Math.max(...values);
    }

    /**
     * Get the numeric values of a column across the members of a group.
     */
    #values(column: string, members: Record<string, unknown>[]): number[] {
        return members
            .map((member: Record<string, unknown>): unknown => member[column])
            .filter((value: unknown): boolean => value !== null && value !== undefined)
            .map((value: unknown): number => Number(value));
    }

    /**
     * Add a constraint on the groups the query returns.
     */
    #constrain(conjunction: Conjunction, column: string, operator?: Operator | unknown, value?: unknown): this {
        const resolved: { operator: Operator; value: unknown } = value === undefined
            ? { operator: '=', value: operator }
            : { operator: operator as Operator, value };

        this.#constraints.push({ type: 'basic', column, operator: resolved.operator, value: resolved.value, conjunction, not: false });

        return this;
    }

    /**
     * Sort the group rows by the requested orders.
     */
    #sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
        return Comparator.sort(rows, this.#orders, (row: Record<string, unknown>, column: string): unknown => row[column]);
    }
}
