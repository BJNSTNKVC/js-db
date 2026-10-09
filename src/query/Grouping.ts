import { Binding } from './Binding';
import { Comparator } from './Comparator';
import { Predicate } from './Predicate';
import { Signature } from './Signature';
import type { Aggregation, Aggregations, Conjunction, Constraint, Direction, Grouped, Key, Operator, Order } from './types';

type Basic = Extract<Constraint, { type: 'basic' }>;

type Records = (columns: string[]) => Promise<Record<string, unknown>[]>;

type Placing = () => Promise<(column: string) => string | null>;

export class Grouping<T, G extends (keyof T & string)[], A extends Aggregations = Record<string, never>> {
    /**
     * Fetch the matching records, holding the given columns as given.
     */
    readonly #records: Records;

    /**
     * The columns the records are grouped by.
     */
    readonly #columns: G;

    /**
     * The name each grouped column takes in each group.
     */
    readonly #names: Map<string, string>;

    /**
     * Get a lookup from a column to the grouped name it matches.
     */
    readonly #placing: Placing;

    /**
     * The aggregations computed for each group.
     */
    #aggregations: Aggregations = {};

    /**
     * The constraints the groups are filtered by.
     */
    #constraints: Basic[] = [];

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
    constructor(records: Records, columns: G, names: Map<string, string>, placing: Placing = async (): Promise<(column: string) => string | null> => (): null => null) {
        this.#records = records;
        this.#columns = columns;
        this.#names = names;
        this.#placing = placing;
    }

    /**
     * Compute the given aggregations for each group.
     */
    aggregate<const N extends Aggregations>(aggregations: N): Grouping<T, G, N> {
        const grouping: Grouping<T, G, N> = new Grouping<T, G, N>(this.#records, this.#columns, this.#names, this.#placing);

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
    having(column: Key<Grouped<T, G, A>>, value: unknown): this;
    having(column: Key<Grouped<T, G, A>>, operator: Operator, value: unknown): this;
    having(column: Key<Grouped<T, G, A>>, ...parameters: unknown[]): this {
        return this.#constrain('and', column, parameters);
    }

    /**
     * Add a disjunctive constraint on the groups the query returns.
     */
    orHaving(column: Key<Grouped<T, G, A>>, value: unknown): this;
    orHaving(column: Key<Grouped<T, G, A>>, operator: Operator, value: unknown): this;
    orHaving(column: Key<Grouped<T, G, A>>, ...parameters: unknown[]): this {
        return this.#constrain('or', column, parameters);
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
        if (Number.isFinite(value) && value >= 0) {
            this.#limit = Math.trunc(value);
        }

        return this;
    }

    /**
     * Skip the given number of groups.
     */
    offset(value: number): this {
        this.#offset = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

        return this;
    }

    /**
     * Get every group matching the query.
     */
    async get(): Promise<Grouped<T, G, A>[]> {
        const grouped: Map<string, Record<string, unknown>[]> = this.#grouped(await this.#records(this.#read()));
        const placed: (column: string) => string | null = await this.#placing();
        const named: (column: string) => string = (column: string): string => this.#names.get(column) ?? placed(column) ?? column;
        const rows: Record<string, unknown>[] = [];

        for (const members of grouped.values()) {
            rows.push(this.#row(members));
        }

        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(this.#constraints.map((constraint: Basic): Basic => ({ ...constraint, column: named(constraint.column) })));
        const kept: Record<string, unknown>[] = rows.filter(matches);
        const sorted: Record<string, unknown>[] = this.#sorted(kept, this.#orders.map((order: Order): Order => ({ ...order, column: named(order.column) })));
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
     * Get every column the groups and aggregates read.
     */
    #read(): string[] {
        const aggregated: string[] = Object.values(this.#aggregations).map((aggregation: Aggregation): string => Object.values(aggregation)[0] as string);

        return [...this.#columns, ...aggregated.filter((column: string): boolean => column !== '*')];
    }

    /**
     * Collect the records into groups, keyed by their grouped column values.
     */
    #grouped(records: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
        const grouped: Map<string, Record<string, unknown>[]> = new Map<string, Record<string, unknown>[]>();

        for (const record of records) {
            const key: string = Signature.ofValues(this.#columns.map((column: string): unknown => record[column]));
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
            row[this.#names.get(column) as string] = first[column];
        }

        for (const [alias, aggregation] of Object.entries(this.#aggregations)) {
            row[alias] = this.#aggregate(aggregation, members);
        }

        return row;
    }

    /**
     * Compute a single aggregate over the members of a group.
     */
    #aggregate(aggregation: Aggregation, members: Record<string, unknown>[]): unknown {
        if ('count' in aggregation) {
            return aggregation.count === '*'
                ? members.length
                : this.#values(aggregation.count, members).length;
        }

        if ('min' in aggregation || 'max' in aggregation) {
            return this.#extreme(this.#values('min' in aggregation ? aggregation.min : aggregation.max, members), 'min' in aggregation);
        }

        const values: number[] = this.#values('sum' in aggregation ? aggregation.sum : aggregation.avg, members)
            .map((value: unknown): number => Number(value));

        const sum: number = values.reduce((carry: number, value: number): number => carry + value, 0);

        if ('sum' in aggregation) {
            return sum;
        }

        return values.length === 0 ? null : sum / values.length;
    }

    /**
     * Get the least or greatest of the values, or null for none.
     */
    #extreme(values: unknown[], least: boolean): unknown {
        if (values.length === 0) {
            return null;
        }

        return values.reduce((carry: unknown, value: unknown): unknown => {
            const compared: number = Comparator.compare(value, carry);

            return (least ? compared < 0 : compared > 0) ? value : carry;
        });
    }

    /**
     * Get the non-null values a column holds across a group.
     */
    #values(column: string, members: Record<string, unknown>[]): unknown[] {
        return members
            .map((member: Record<string, unknown>): unknown => member[column])
            .filter((value: unknown): boolean => value !== null && value !== undefined);
    }

    /**
     * Add a constraint on the groups the query returns.
     */
    #constrain(conjunction: Conjunction, column: string, parameters: unknown[]): this {
        // Resolved by how many arguments were passed rather than
        // by an undefined value, so an explicit operator is kept
        // even when the value it compares against is undefined.
        const resolved: { operator: Operator; value: unknown } = parameters.length < 2
            ? { operator: '=', value: parameters[0] }
            : { operator: parameters[0] as Operator, value: parameters[1] };

        this.#constraints.push({ type: 'basic', column, operator: resolved.operator, value: Binding.scalar(resolved.value), conjunction, not: false });

        return this;
    }

    /**
     * Sort the group rows by the given orders.
     */
    #sorted(rows: Record<string, unknown>[], orders: Order[]): Record<string, unknown>[] {
        return Comparator.sort(rows, orders, (row: Record<string, unknown>, column: string): unknown => row[column]);
    }
}
