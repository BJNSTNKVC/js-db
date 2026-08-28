import type { Constraint, DatePart, Operator } from './types';

interface LikeToken {
    kind: 'any' | 'one' | 'literal';
    value: string;
}

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

        if (constraint.type === 'column') {
            const other: unknown = record[constraint.other];

            if (other === null || other === undefined) {
                return false;
            }

            return this.#negate(constraint.not, this.#compare(held, constraint.operator, other));
        }

        if (constraint.type === 'part') {
            return this.#negate(constraint.not, this.#part(held, constraint.part) === constraint.value);
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
     * Read one part of a value that should hold a date.
     */
    static #part(held: unknown, part: DatePart): number | null {
        const date: Date = held instanceof Date ? held : new Date(held as string | number);

        if (Number.isNaN(date.getTime())) {
            return null;
        }

        if (part === 'year') {
            return date.getFullYear();
        }

        // Numbered from one, as SQL does, rather than from zero as JavaScript does.
        return part === 'month' ? date.getMonth() + 1 : date.getDate();
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
            const matched: boolean = typeof held === 'string' && this.#like(String(given), held);

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
     * Determine whether a subject matches a like pattern.
     */
    static #like(pattern: string, subject: string): boolean {
        const tokens: LikeToken[] = this.#tokens(pattern);

        let token: number = 0;
        let index: number = 0;
        let wildcard: number = -1;
        let resume: number = 0;

        // A greedy walk carrying a single backtrack point. The regular expression this replaces
        // compiled `%%%%%` into `.*.*.*.*.*`, and adjacent unbounded stars made the engine retry
        // every division of the subject between them, which is exponential in the number of stars.
        while (index < subject.length) {
            const current: LikeToken | undefined = tokens[token];

            if (current !== undefined && current.kind === 'any') {
                wildcard = token;
                resume = index;
                token++;

                continue;
            }

            // Lowercasing one character at a time rather than the whole subject, because a character
            // whose lower case is longer than itself would otherwise shift every index after it.
            if (current !== undefined && (current.kind === 'one' || current.value === (subject[index] as string).toLowerCase())) {
                token++;
                index++;

                continue;
            }

            if (wildcard === -1) {
                return false;
            }

            // The last wildcard gives up one more character and the walk resumes from there.
            token = wildcard + 1;
            resume++;
            index = resume;
        }

        // Only trailing wildcards may be left over, since they match an empty remainder.
        while (tokens[token]?.kind === 'any') {
            token++;
        }

        return token === tokens.length;
    }

    /**
     * Reduce a like pattern to the tokens it matches by.
     */
    static #tokens(pattern: string): LikeToken[] {
        const tokens: LikeToken[] = [];

        for (let index: number = 0; index < pattern.length; index++) {
            const character: string = pattern[index] as string;

            // A backslash escapes a wildcard, so a pattern can match a literal % or _.
            if (character === '\\' && (pattern[index + 1] === '%' || pattern[index + 1] === '_')) {
                tokens.push({ kind: 'literal', value: (pattern[index + 1] as string).toLowerCase() });
                index++;

                continue;
            }

            if (character === '%') {
                // A run of wildcards matches exactly what one matches, so the extras are dropped
                // rather than kept as backtrack points that could never change the outcome.
                if (tokens.at(-1)?.kind !== 'any') {
                    tokens.push({ kind: 'any', value: '' });
                }

                continue;
            }

            if (character === '_') {
                tokens.push({ kind: 'one', value: '' });

                continue;
            }

            tokens.push({ kind: 'literal', value: character.toLowerCase() });
        }

        return tokens;
    }
}
