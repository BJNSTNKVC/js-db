import type { Constraint, Operator } from './types'

const METACHARACTERS: RegExp = /[.*+?^${}()|[\]\\]/g

export class Predicate {
    /**
     * Compile a list of constraints into a record test.
     */
    static compile(constraints: Constraint[]): (record: Record<string, unknown>) => boolean {
        if (constraints.length === 0) {
            return (): boolean => true
        }

        const groups: Constraint[][] = this.#grouped(constraints)

        return (record: Record<string, unknown>): boolean => groups.some(
            (group: Constraint[]): boolean => group.every(
                (constraint: Constraint): boolean => this.#test(constraint, record),
            ),
        )
    }

    /**
     * Split the constraints into disjunctive groups, so and binds tighter than or.
     */
    static #grouped(constraints: Constraint[]): Constraint[][] {
        const groups: Constraint[][] = []

        for (const [index, constraint] of constraints.entries()) {
            if (index === 0 || constraint.conjunction === 'or') {
                groups.push([])
            }

            groups[groups.length - 1]?.push(constraint)
        }

        return groups
    }

    /**
     * Test a single constraint against a record.
     */
    static #test(constraint: Constraint, record: Record<string, unknown>): boolean {
        const held: unknown = constraint.type === 'nested' ? undefined : record[constraint.column]
        const result: boolean = this.#result(constraint, held, record)

        return constraint.not ? !result : result
    }

    /**
     * Resolve the constraint against the value it applies to.
     */
    static #result(constraint: Constraint, held: unknown, record: Record<string, unknown>): boolean {
        switch (constraint.type) {
            case 'basic':
                return this.#compare(held, constraint.operator, constraint.value)

            case 'in':
                return constraint.values.some((value: unknown): boolean => this.#compare(held, '==', value))

            case 'null':
                return held === null || held === undefined

            case 'between':
                return this.#compare(held, '>=', constraint.from) && this.#compare(held, '<=', constraint.to)

            default:
                return this.compile(constraint.constraints)(record)
        }
    }

    /**
     * Compare a held value against a given one under the operator.
     */
    static #compare(held: unknown, operator: Operator, given: unknown): boolean {
        if (operator === 'like' || operator === 'not like') {
            const matched: boolean = typeof held === 'string' && this.#pattern(String(given)).test(held)

            return operator === 'like' ? matched : !matched
        }

        const a: unknown = this.#comparable(held)
        const b: unknown = this.#comparable(given)

        switch (operator) {
            case '=':
            case '==':
                return a == b

            case '===':
                return a === b

            case '!=':
            case '<>':
                return a != b

            case '!==':
                return a !== b

            case '<':
                return (a as number) < (b as number)

            case '>':
                return (a as number) > (b as number)

            case '<=':
                return (a as number) <= (b as number)

            default:
                return (a as number) >= (b as number)
        }
    }

    /**
     * Reduce a value to something the comparison operators can order.
     */
    static #comparable(value: unknown): unknown {
        return value instanceof Date ? value.getTime() : value
    }

    /**
     * Translate a like pattern into a case insensitive regular expression.
     */
    static #pattern(pattern: string): RegExp {
        let source: string = ''

        for (let index: number = 0; index < pattern.length; index++) {
            const character: string = pattern[index] as string

            if (character === '\\' && (pattern[index + 1] === '%' || pattern[index + 1] === '_')) {
                source += (pattern[index + 1] as string).replace(METACHARACTERS, '\\$&')
                index++

                continue
            }

            if (character === '%') {
                source += '.*'

                continue
            }

            if (character === '_') {
                source += '.'

                continue
            }

            source += character.replace(METACHARACTERS, '\\$&')
        }

        return new RegExp(`^${source}$`, 'i')
    }
}
