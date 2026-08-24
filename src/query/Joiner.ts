import { Predicate } from './Predicate';
import type { Conjunction, Constraint, JoinClause, JoinCondition } from './types';

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
     * Pair each row of the driving side with the rows of the other that satisfy the conditions.
     */
    static #matched(driving: Record<string, unknown>[], other: Record<string, unknown>[], clause: JoinClause, columns: string[]): Record<string, unknown>[] {
        const hashed: Map<unknown, Record<string, unknown>[]> | null = this.#hashable(clause) ? this.#hash(other, clause) : null;
        const matches: (row: Record<string, unknown>) => boolean = Predicate.compile(this.#constraints(clause));
        const joined: Record<string, unknown>[] = [];

        for (const row of driving) {
            const candidates: Record<string, unknown>[] = hashed === null
                ? other
                : hashed.get(row[(clause.conditions[0] as JoinCondition).first]) ?? [];

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
     * Determine whether the conditions reduce to a single equality, which a hash can serve.
     */
    static #hashable(clause: JoinClause): boolean {
        const condition: JoinCondition | undefined = clause.conditions[0];

        return clause.conditions.length === 1 && condition !== undefined && condition.operator === '=';
    }

    /**
     * Index the other side by the value its join column holds.
     */
    static #hash(records: Record<string, unknown>[], clause: JoinClause): Map<unknown, Record<string, unknown>[]> {
        const column: string = (clause.conditions[0] as JoinCondition).second;
        const hashed: Map<unknown, Record<string, unknown>[]> = new Map<unknown, Record<string, unknown>[]>();

        for (const record of records) {
            const key: unknown = record[column];
            const bucket: Record<string, unknown>[] | undefined = hashed.get(key);

            if (bucket === undefined) {
                hashed.set(key, [record]);

                continue;
            }

            bucket.push(record);
        }

        return hashed;
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
