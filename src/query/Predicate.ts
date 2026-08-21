import type { Constraint, Operator } from './types';

const METACHARACTERS: RegExp = /[.*+?^${}()|[\]\\]/g;

export class Predicate {
    /**
     * Compile a list of constraints into a record test.
     */
    static compile(constraints: Constraint[]): (record: Record<string, unknown>) => boolean {
        if (constraints.length === 0) {
            return (): boolean => true;
        }

        const groups: Constraint[][] = this.#grouped(constraints);

        return (record: Record<string, unknown>): boolean => groups.some(
            (group: Constraint[]): boolean => group.every(
                (constraint: Constraint): boolean => this.#test(constraint, record),
            ),
        );
    }

    /**
     * Split the constraints into disjunctive groups, so and binds tighter than or.
     */
    static #grouped(constraints: Constraint[]): Constraint[][] {
        const groups: Constraint[][] = [];

        for (const [index, constraint] of constraints.entries()) {
            if (index === 0 || constraint.conjunction === 'or') {
                groups.push([]);
            }

            groups[groups.length - 1]?.push(constraint);
        }

        return groups;
    }

    /**
     * Test a single constraint against a record.
     */
    static #test(constraint: Constraint, record: Record<string, unknown>): boolean {
        if (constraint.type === 'nested') {
            return this.#negate(constraint.not, this.compile(constraint.constraints)(record));
        }

        const held: unknown = record[constraint.column];

        if (constraint.type === 'null') {
            return this.#negate(constraint.not, held === null || held === undefined);
        }

        // SQL three valued logic: comparing against null is unknown, and negating unknown leaves it
        // unknown, so a null value satisfies neither a constraint nor its negation.
        if (held === null || held === undefined) {
            return false;
        }

        if (constraint.type === 'in') {
            return this.#negate(constraint.not, constraint.values.some((value: unknown): boolean => this.#compare(held, '==', value)));
        }

        if (constraint.type === 'between') {
            return this.#negate(constraint.not, this.#compare(held, '>=', constraint.from) && this.#compare(held, '<=', constraint.to));
        }

        return this.#negate(constraint.not, this.#compare(held, constraint.operator, constraint.value));
    }

    /**
     * Negate a result when the constraint asks for it.
     */
    static #negate(not: boolean, result: boolean): boolean {
        return not ? !result : result;
    }

    /**
     * Compare a held value against a given one under the operator.
     */
    static #compare(held: unknown, operator: Operator, given: unknown): boolean {
        if (operator === 'like' || operator === 'not like') {
            const matched: boolean = typeof held === 'string' && this.#pattern(String(given)).test(held);

            return operator === 'like' ? matched : !matched;
        }

        const a: unknown = this.#comparable(held);
        const b: unknown = this.#comparable(given);

        switch (operator) {
            case '=':
            case '==':
                return a == b;

            case '===':
                return a === b;

            case '!=':
            case '<>':
                return a != b;

            case '!==':
                return a !== b;

            case '<':
                return (a as number) < (b as number);

            case '>':
                return (a as number) > (b as number);

            case '<=':
                return (a as number) <= (b as number);

            default:
                return (a as number) >= (b as number);
        }
    }

    /**
     * Reduce a value to something the comparison operators can order.
     */
    static #comparable(value: unknown): unknown {
        return value instanceof Date ? value.getTime() : value;
    }

    /**
     * Translate a like pattern into a case insensitive regular expression.
     */
    static #pattern(pattern: string): RegExp {
        let source: string = '';

        for (let index: number = 0; index < pattern.length; index++) {
            const character: string = pattern[index] as string;

            if (character === '\\' && (pattern[index + 1] === '%' || pattern[index + 1] === '_')) {
                source += (pattern[index + 1] as string).replace(METACHARACTERS, '\\$&');
                index++;

                continue;
            }

            if (character === '%') {
                source += '.*';

                continue;
            }

            if (character === '_') {
                source += '.';

                continue;
            }

            source += character.replace(METACHARACTERS, '\\$&');
        }

        return new RegExp(`^${source}$`, 'i');
    }
}
