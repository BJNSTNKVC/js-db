import type { Constraint, DatePart, Operator } from './types';

type Truth = boolean | null;

interface LikeToken {
    kind: 'any' | 'one' | 'literal';
    value: string;
}

export class Predicate {
    /**
     * Compile a list of constraints into a record test.
     */
    static compile(constraints: readonly Constraint[]): (record: Record<string, unknown>) => boolean {
        const evaluate: (record: Record<string, unknown>) => Truth = this.#evaluator(constraints);

        return (record: Record<string, unknown>): boolean => evaluate(record) === true;
    }

    /**
     * Compile a list of constraints into a three valued record test.
     */
    static #evaluator(constraints: readonly Constraint[]): (record: Record<string, unknown>) => Truth {
        if (constraints.length === 0) {
            return (): Truth => true;
        }

        const groups: Constraint[][] = this.#grouped(constraints);

        return (record: Record<string, unknown>): Truth => {
            let disjunction: Truth = false;

            for (const group of groups) {
                const conjunction: Truth = this.#conjoin(group, record);

                if (conjunction === true) {
                    return true;
                }

                if (conjunction === null) {
                    disjunction = null;
                }
            }

            return disjunction;
        };
    }

    /**
     * Test a group of constraints joined by and, where false outweighs unknown.
     */
    static #conjoin(group: readonly Constraint[], record: Record<string, unknown>): Truth {
        let conjunction: Truth = true;

        for (const constraint of group) {
            const truth: Truth = this.#test(constraint, record);

            if (truth === false) {
                return false;
            }

            if (truth === null) {
                conjunction = null;
            }
        }

        return conjunction;
    }

    /**
     * Split the constraints into disjunctive groups, so and binds tighter than or.
     */
    static #grouped(constraints: readonly Constraint[]): Constraint[][] {
        const groups: Constraint[][] = [];

        for (const [index, constraint] of constraints.entries()) {
            if (index === 0 || constraint.conjunction === 'or') {
                groups.push([]);
            }

            groups.at(-1)?.push(constraint);
        }

        return groups;
    }

    /**
     * Test a single constraint against a record.
     */
    static #test(constraint: Constraint, record: Record<string, unknown>): Truth {
        if (constraint.type === 'nested') {
            return this.#negate(constraint.not, this.#evaluator(constraint.constraints)(record));
        }

        const held: unknown = record[constraint.column];

        if (constraint.type === 'null') {
            return this.#negate(constraint.not, this.#absent(held));
        }

        // SQL three valued logic: comparing against null is unknown, and negating unknown leaves it
        // unknown, so a null value satisfies neither a constraint nor its negation.
        if (this.#absent(held)) {
            return null;
        }

        if (constraint.type === 'column') {
            return this.#negate(constraint.not, this.#compared(held, constraint.operator, record[constraint.other]));
        }

        if (constraint.type === 'part') {
            const part: number | null = this.#part(held, constraint.part);

            return part === null ? null : this.#negate(constraint.not, part === constraint.value);
        }

        if (constraint.type === 'time') {
            const time: string | null = this.#time(held);

            return time === null ? null : this.#negate(constraint.not, this.#compare(time, constraint.operator, constraint.value));
        }

        if (constraint.type === 'in') {
            const found: boolean = constraint.values.some((value: unknown): boolean => this.#compare(held, '==', value) === true);

            if (!found && constraint.values.some((value: unknown): boolean => this.#absent(value))) {
                return null;
            }

            return this.#negate(constraint.not, found);
        }

        if (constraint.type === 'between') {
            const lower: Truth = this.#compared(held, '>=', constraint.from);
            const upper: Truth = this.#compared(held, '<=', constraint.to);

            return this.#negate(constraint.not, lower === false || upper === false ? false : lower && upper);
        }

        return this.#negate(constraint.not, this.#compared(held, constraint.operator, constraint.value));
    }

    /**
     * Read one part of a value that should hold a date.
     */
    static #part(held: unknown, part: DatePart): number | null {
        const date: Date | null = this.#date(held);

        if (date === null) {
            return null;
        }

        if (part === 'year') {
            return date.getFullYear();
        }

        return part === 'month' ? date.getMonth() + 1 : date.getDate();
    }

    /**
     * Read the time of day of a value that should hold a date, as a zero padded HH:MM:SS string.
     */
    static #time(held: unknown): string | null {
        const date: Date | null = this.#date(held);

        if (date === null) {
            return null;
        }

        return [date.getHours(), date.getMinutes(), date.getSeconds()]
            .map((part: number): string => String(part).padStart(2, '0'))
            .join(':');
    }

    /**
     * Read a value that should hold a date, or null when it does not.
     */
    static #date(held: unknown): Date | null {
        const date: Date = held instanceof Date ? held : new Date(held as string | number);

        return Number.isNaN(date.getTime()) ? null : date;
    }

    /**
     * Negate a result when the constraint asks for it, leaving unknown unknown.
     */
    static #negate(not: boolean, result: Truth): Truth {
        return not && result !== null ? !result : result;
    }

    /**
     * Determine whether a value is null or missing.
     */
    static #absent(value: unknown): boolean {
        return value === null || value === undefined;
    }

    /**
     * Compare a held value against a given one, which is unknown when the given one is null.
     */
    static #compared(held: unknown, operator: Operator, given: unknown): Truth {
        return this.#absent(given) ? null : this.#compare(held, operator, given);
    }

    /**
     * Compare a held value against a given one, where a pattern against anything but a string is unknown.
     */
    static #compare(held: unknown, operator: Operator, given: unknown): Truth {
        if (operator === 'like' || operator === 'not like') {
            if (typeof held !== 'string') {
                return null;
            }

            const matched: boolean = this.#like(String(given), held);

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

            if (current?.kind === 'any') {
                wildcard = token;
                resume = index;
                token++;

                continue;
            }

            // Lowercasing one character at a time rather than the whole subject, because a character
            // whose lower case is longer than itself would otherwise shift every index after it.
            if (current?.kind === 'one' || current?.value === (subject[index] as string).toLowerCase()) {
                token++;
                index++;

                continue;
            }

            if (wildcard === -1) {
                return false;
            }

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
