import type { Conjunction, JoinCondition, Operator } from './types';

export class Join {
    /**
     * The conditions the tables are joined on.
     */
    readonly #conditions: JoinCondition[] = [];

    /**
     * Join on a pair of columns.
     */
    on(first: string, second: string): this;
    on(first: string, operator: Operator, second: string): this;
    on(first: string, operator: string, second?: string): this {
        return this.#condition('and', first, operator, second);
    }

    /**
     * Join on a pair of columns, disjunctively.
     */
    orOn(first: string, second: string): this;
    orOn(first: string, operator: Operator, second: string): this;
    orOn(first: string, operator: string, second?: string): this {
        return this.#condition('or', first, operator, second);
    }

    /**
     * Get the conditions the tables are joined on.
     */
    conditions(): JoinCondition[] {
        return this.#conditions;
    }

    /**
     * Record a condition, allowing the operator to be left implicit.
     */
    #condition(conjunction: Conjunction, first: string, operator: string, second?: string): this {
        const resolved: { operator: Operator; second: string } = second === undefined
            ? { operator: '=', second: operator }
            : { operator: operator as Operator, second };

        this.#conditions.push({ first, operator: resolved.operator, second: resolved.second, conjunction });

        return this;
    }
}
