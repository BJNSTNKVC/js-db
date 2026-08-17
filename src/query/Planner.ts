import type { ColumnSchema, IndexSchema, TableSchema } from '../schema/types'
import type { Constraint, Operator, Order, Plan } from './types'

const RANGEABLE: readonly Operator[] = ['=', '==', '===', '>', '>=', '<', '<=']

interface Candidate {
    constraint: Constraint
    source: 'key' | 'index'
    index: string | null
    rank: number
    range: IDBKeyRange | null
    values: unknown[] | null
}

export class Planner {
    /**
     * Compile the constraints and orders into an execution plan.
     */
    static plan(constraints: Constraint[], orders: Order[], schema: TableSchema): Plan {
        const candidate: Candidate | null = this.#disjunctive(constraints) ? null : this.#candidate(constraints, schema)
        const ordering: Candidate | null = this.#disjunctive(constraints) ? null : this.#ordering(orders, schema)

        if (candidate === null) {
            return this.#ordered(constraints, orders, ordering)
        }

        const aligned: boolean = ordering !== null
            && ordering.source === candidate.source
            && ordering.index === candidate.index
            && candidate.values === null

        return {
            source   : candidate.source,
            index    : candidate.index,
            range    : candidate.range,
            values   : candidate.values,
            direction: aligned ? this.#direction(orders) : 'next',
            ordered  : aligned,
            residual : constraints.filter((constraint: Constraint): boolean => constraint !== candidate.constraint),
        }
    }

    /**
     * Describe a plan for the query log.
     */
    static describe(plan: Plan): string {
        if (plan.source === 'scan') {
            return 'scan'
        }

        return plan.source === 'key' ? 'key' : `index:${plan.index}`
    }

    /**
     * Build the plan for a query no constraint could drive.
     */
    static #ordered(constraints: Constraint[], orders: Order[], ordering: Candidate | null): Plan {
        if (ordering === null) {
            return { source: 'scan', index: null, range: null, values: null, direction: 'next', ordered: false, residual: constraints }
        }

        return {
            source   : ordering.source,
            index    : ordering.index,
            range    : null,
            values   : null,
            direction: this.#direction(orders),
            ordered  : true,
            residual : constraints,
        }
    }

    /**
     * Determine whether any top level constraint is disjunctive.
     */
    static #disjunctive(constraints: Constraint[]): boolean {
        return constraints.some((constraint: Constraint, index: number): boolean => index > 0 && constraint.conjunction === 'or')
    }

    /**
     * Get the most selective constraint able to drive the scan.
     */
    static #candidate(constraints: Constraint[], schema: TableSchema): Candidate | null {
        let best: Candidate | null = null

        for (const constraint of constraints) {
            const candidate: Candidate | null = this.#candidacy(constraint, schema)

            if (candidate !== null && (best === null || candidate.rank < best.rank)) {
                best = candidate
            }
        }

        return best
    }

    /**
     * Assess whether a single constraint can drive the scan.
     */
    static #candidacy(constraint: Constraint, schema: TableSchema): Candidate | null {
        if (constraint.type === 'nested' || constraint.type === 'null' || constraint.not) {
            return null
        }

        const target: { source: 'key' | 'index'; index: string | null; rank: number } | null = this.#target(constraint.column, schema)

        if (target === null) {
            return null
        }

        if (constraint.type === 'in') {
            if (constraint.values.length === 0 || !constraint.values.every((value: unknown): boolean => this.#keyable(value))) {
                return null
            }

            return { constraint, ...target, range: null, values: constraint.values }
        }

        if (constraint.type === 'between') {
            if (!this.#keyable(constraint.from) || !this.#keyable(constraint.to)) {
                return null
            }

            return { constraint, ...target, range: IDBKeyRange.bound(constraint.from as IDBValidKey, constraint.to as IDBValidKey, false, false), values: null }
        }

        if (!RANGEABLE.includes(constraint.operator) || !this.#keyable(constraint.value)) {
            return null
        }

        return { constraint, ...target, range: this.#range(constraint.operator, constraint.value as IDBValidKey), values: null }
    }

    /**
     * Resolve the column to the key path or a single column index.
     */
    static #target(column: string, schema: TableSchema): { source: 'key' | 'index'; index: string | null; rank: number } | null {
        if (schema.key === column) {
            return { source: 'key', index: null, rank: 0 }
        }

        const index: IndexSchema | undefined = schema.indexes.find(
            (candidate: IndexSchema): boolean => candidate.columns.length === 1 && candidate.columns[0] === column,
        )

        if (index === undefined) {
            return null
        }

        return { source: 'index', index: index.name, rank: index.unique ? 1 : 2 }
    }

    /**
     * Get the index able to satisfy the requested order without dropping records.
     */
    static #ordering(orders: Order[], schema: TableSchema): Candidate | null {
        const order: Order | undefined = orders[0]

        if (orders.length !== 1 || order === undefined) {
            return null
        }

        const target: { source: 'key' | 'index'; index: string | null; rank: number } | null = this.#target(order.column, schema)

        if (target === null) {
            return null
        }

        const column: ColumnSchema | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === order.column)

        if (column !== undefined && column.nullable) {
            return null
        }

        return { constraint: { type: 'null', column: order.column, conjunction: 'and', not: false }, ...target, range: null, values: null }
    }

    /**
     * Get the cursor direction the orders ask for.
     */
    static #direction(orders: Order[]): IDBCursorDirection {
        return orders[0]?.direction === 'desc' ? 'prev' : 'next'
    }

    /**
     * Build the key range for a comparison operator.
     */
    static #range(operator: Operator, value: IDBValidKey): IDBKeyRange {
        switch (operator) {
            case '>':
                return IDBKeyRange.lowerBound(value, true)

            case '>=':
                return IDBKeyRange.lowerBound(value, false)

            case '<':
                return IDBKeyRange.upperBound(value, true)

            case '<=':
                return IDBKeyRange.upperBound(value, false)

            default:
                return IDBKeyRange.only(value)
        }
    }

    /**
     * Determine whether the value may be used as an IndexedDB key.
     */
    static #keyable(value: unknown): boolean {
        return value !== null && value !== undefined
    }
}
