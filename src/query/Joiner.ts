import { Columns } from './Columns';
import { Predicate } from './Predicate';
import type { Conjunction, Constraint, JoinClause, JoinCondition, Projection } from './types';

interface Hash {
    probe: string;
    rows: Map<unknown, Record<string, unknown>[]>;
}

export class Joiner {
    /**
     * Prefix every key of the given records with the table that owns it.
     */
    static qualify(records: Record<string, unknown>[], table: string): Record<string, unknown>[] {
        return records.map((record: Record<string, unknown>): Record<string, unknown> => {
            const qualified: Record<string, unknown> = {};

            for (const [column, value] of Object.entries(record)) {
                qualified[`${table}.${column}`] = value;
            }

            return qualified;
        });
    }

    /**
     * Join two sets of qualified records, carrying unmatched rows through where the type asks for it.
     */
    static join(left: Record<string, unknown>[], right: Record<string, unknown>[], clause: JoinClause, columns: string[]): Record<string, unknown>[] {
        if (clause.type === 'cross') {
            return left.flatMap((row: Record<string, unknown>): Record<string, unknown>[] =>
                right.map((match: Record<string, unknown>): Record<string, unknown> => ({ ...row, ...match })));
        }

        // A right join is a left join with the sides swapped, so the unmatched rows it keeps are the
        // ones the other form would have dropped.
        if (clause.type === 'right') {
            return this.#matched(right, left, clause, this.#columnsOf(left)).map(
                (row: Record<string, unknown>): Record<string, unknown> => row,
            );
        }

        return this.#matched(left, right, clause, columns);
    }

    /**
     * Qualify every column a constraint names with the table that owns it.
     */
    static qualified(constraint: Constraint, tables: Map<string, string[]>): Constraint {
        if (constraint.type === 'nested') {
            return { ...constraint, constraints: constraint.constraints.map((nested: Constraint): Constraint => this.qualified(nested, tables)) };
        }

        if (constraint.type === 'column') {
            return { ...constraint, column: Columns.resolve(constraint.column, tables), other: Columns.resolve(constraint.other, tables) };
        }

        return { ...constraint, column: Columns.resolve(constraint.column, tables) };
    }

    /**
     * Flatten qualified rows the way SQL does, letting later tables win a collision.
     */
    static flatten(rows: Record<string, unknown>[], tables: Map<string, string[]>, columns: readonly string[] | null): Record<string, unknown>[] {
        if (columns !== null) {
            return rows.map((row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
                columns.map((expression: string): [string, unknown] => {
                    const projection: Projection = Columns.parse(expression);

                    return [projection.alias, Columns.read(row, Columns.resolve(projection.column, tables))];
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
     * Pair each row of the driving side with the rows of the other that satisfy the conditions.
     */
    static #matched(driving: Record<string, unknown>[], other: Record<string, unknown>[], clause: JoinClause, columns: string[]): Record<string, unknown>[] {
        const hash: Hash | null = this.#hash(driving, other, clause);
        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(this.#constraints(clause));
        const joined: Record<string, unknown>[] = [];

        for (const row of driving) {
            const candidates: Record<string, unknown>[] = hash === null
                ? other
                : hash.rows.get(this.#key(Columns.read(row, hash.probe))) ?? [];

            const paired: Record<string, unknown>[] = candidates
                .map((candidate: Record<string, unknown>): Record<string, unknown> => ({ ...row, ...candidate }))
                .filter(matches);

            if (paired.length > 0) {
                joined.push(...paired);

                continue;
            }

            if (clause.type !== 'inner') {
                joined.push({ ...row, ...this.#absent(columns) });
            }
        }

        return joined;
    }

    /**
     * Index the other side by its join column, when a lookup there finds every row the conditions match.
     */
    static #hash(driving: Record<string, unknown>[], other: Record<string, unknown>[], clause: JoinClause): Hash | null {
        const sides: [string, string] | null = this.#sides(clause);

        if (sides === null) {
            return null;
        }

        const [probe, column]: [string, string] = sides;
        const probes: unknown[] = driving.map((row: Record<string, unknown>): unknown => this.#key(Columns.read(row, probe)));
        const keys: unknown[] = other.map((record: Record<string, unknown>): unknown => this.#key(Columns.read(record, column)));

        if (new Set([...probes, ...keys].filter((key: unknown): boolean => !this.#missing(key)).map((key: unknown): string => typeof key)).size > 1) {
            return null;
        }

        const rows: Map<unknown, Record<string, unknown>[]> = new Map<unknown, Record<string, unknown>[]>();

        for (const [index, record] of other.entries()) {
            const key: unknown = keys[index];

            if (this.#missing(key)) {
                continue;
            }

            const bucket: Record<string, unknown>[] | undefined = rows.get(key);

            if (bucket === undefined) {
                rows.set(key, [record]);

                continue;
            }

            bucket.push(record);
        }

        return { probe, rows };
    }

    /**
     * Get the column the driving side looks up by and the one the other side is indexed by, when the conditions reduce to a single equality between the joined table and the rest.
     */
    static #sides(clause: JoinClause): [string, string] | null {
        const condition: JoinCondition | undefined = clause.conditions[0];

        if (clause.conditions.length !== 1 || condition?.operator !== '=') {
            return null;
        }

        const joined: (column: string) => boolean = (column: string): boolean => column.startsWith(`${clause.table}.`);

        if (joined(condition.first) === joined(condition.second)) {
            return null;
        }

        const [inside, outside]: [string, string] = joined(condition.first) ? [condition.first, condition.second] : [condition.second, condition.first];

        return clause.type === 'right' ? [inside, outside] : [outside, inside];
    }

    /**
     * Reduce a join value to the form the comparison sees, so a date becomes its time.
     */
    static #key(value: unknown): unknown {
        return value instanceof Date ? value.getTime() : value;
    }

    /**
     * Determine whether a join value is null or missing, which matches nothing.
     */
    static #missing(value: unknown): boolean {
        return value === null || value === undefined;
    }

    /**
     * Compile the join conditions into constraints over the merged row.
     */
    static #constraints(clause: JoinClause): Constraint[] {
        return clause.conditions.map((condition: JoinCondition, index: number): Constraint => ({
            type       : 'column',
            column     : condition.first,
            operator   : condition.operator,
            other      : condition.second,
            conjunction: index === 0 ? 'and' : condition.conjunction as Conjunction,
            not        : false,
        }));
    }

    /**
     * Build the null columns SQL gives an unmatched row.
     */
    static #absent(columns: string[]): Record<string, unknown> {
        return Object.fromEntries(columns.map((column: string): [string, unknown] => [column, null]));
    }

    /**
     * Get every qualified column present across the given records.
     */
    static #columnsOf(records: Record<string, unknown>[]): string[] {
        const columns: Set<string> = new Set<string>();

        for (const record of records) {
            for (const column of Object.keys(record)) {
                columns.add(column);
            }
        }

        return [...columns];
    }
}
