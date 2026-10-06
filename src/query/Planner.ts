import { Calendar } from '../schema/Calendar';
import { Columns } from './Columns';
import type { ColumnSchema, ColumnType, IndexSchema, TableSchema } from '../schema/types';
import type { Constraint, Operator, Order, Plan } from './types';

const RANGEABLE: ReadonlySet<Operator> = new Set<Operator>(['=', '==', '===', '>', '>=', '<', '<=']);

const CONVERTED: ReadonlySet<Operator> = new Set<Operator>(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

const FALSY: ReadonlySet<string> = new Set<string>(['false', '0']);

interface Candidate {
    constraint: Constraint;
    source: 'key' | 'index';
    index: string | null;
    rank: number;
    range: IDBKeyRange | null;
    values: unknown[] | null;
    rechecked: boolean;
}

export class Planner {
    /**
     * Compile the constraints and orders into an execution plan, walking none of the excluded sources, each named by its index or null for the key path.
     */
    static plan(constraints: readonly Constraint[], orders: readonly Order[], schema: TableSchema, excluded: ReadonlySet<string | null> = new Set<string | null>()): Plan {
        const candidate: Candidate | null = this.#disjunctive(constraints) ? null : this.#candidate(constraints, schema, excluded);
        const ordering: Candidate | null = this.#disjunctive(constraints) ? null : this.#ordering(orders, schema, excluded);

        if (candidate === null) {
            return this.#ordered(constraints, orders, ordering);
        }

        const aligned: boolean = ordering !== null
            && ordering.source === candidate.source
            && ordering.index === candidate.index
            && candidate.values === null;

        return {
            source   : candidate.source,
            index    : candidate.index,
            range    : candidate.range,
            values   : candidate.values,
            direction: aligned ? this.#direction(orders) : 'next',
            ordered  : aligned,
            residual : constraints.filter((constraint: Constraint): boolean => constraint !== candidate.constraint || candidate.rechecked),
        };
    }

    /**
     * Convert the values the constraints compare with declared columns into those columns' types, reading dates in the timezone.
     */
    static prepare(constraints: readonly Constraint[], types: ReadonlyMap<string, ColumnType>, timezone: string): Constraint[] {
        return constraints.map((constraint: Constraint): Constraint => this.#prepared(constraint, types, timezone));
    }

    /**
     * Convert a value into the given column type, reading a date in the timezone, or leave it as given when it does not convert cleanly.
     */
    static convert(value: unknown, type: ColumnType, timezone: string): unknown {
        if (value === null || value === undefined) {
            return value;
        }

        switch (type) {
            case 'integer':
            case 'decimal':
                return this.#number(value, false) ?? value;

            case 'float':
                return this.#number(value, true) ?? value;

            case 'boolean':
                return typeof value === 'string' && FALSY.has(value) ? false : Boolean(value);

            case 'date':
            case 'datetime':
                return this.#date(value, timezone) ?? value;

            default:
                return value;
        }
    }

    /**
     * Determine whether the value may be used as an IndexedDB key.
     */
    static keyable(value: unknown): boolean {
        if (typeof value === 'number') {
            return Number.isFinite(value);
        }

        if (value instanceof Date) {
            return !Number.isNaN(value.getTime());
        }

        return typeof value === 'string' || (Array.isArray(value) && value.every((element: unknown): boolean => this.keyable(element)));
    }

    /**
     * Describe a plan for the query log.
     */
    static describe(plan: Plan): string {
        if (plan.source === 'scan') {
            return 'scan';
        }

        return plan.source === 'key' ? 'key' : `index:${plan.index}`;
    }

    /**
     * Build the plan for a query no constraint could drive.
     */
    static #ordered(constraints: readonly Constraint[], orders: readonly Order[], ordering: Candidate | null): Plan {
        if (ordering === null) {
            return { source: 'scan', index: null, range: null, values: null, direction: 'next', ordered: false, residual: [...constraints] };
        }

        return {
            source   : ordering.source,
            index    : ordering.index,
            range    : null,
            values   : null,
            direction: this.#direction(orders),
            ordered  : true,
            residual : [...constraints],
        };
    }

    /**
     * Determine whether any top level constraint is disjunctive.
     */
    static #disjunctive(constraints: readonly Constraint[]): boolean {
        return constraints.some((constraint: Constraint, index: number): boolean => index > 0 && constraint.conjunction === 'or');
    }

    /**
     * Get the most selective constraint able to drive the scan.
     */
    static #candidate(constraints: readonly Constraint[], schema: TableSchema, excluded: ReadonlySet<string | null>): Candidate | null {
        let best: Candidate | null = null;

        for (const constraint of constraints) {
            const candidate: Candidate | null = this.#candidacy(constraint, schema, excluded);

            if (candidate !== null && (best === null || candidate.rank < best.rank)) {
                best = candidate;
            }
        }

        return best;
    }

    /**
     * Assess whether a single constraint can drive the scan.
     */
    static #candidacy(constraint: Constraint, schema: TableSchema, excluded: ReadonlySet<string | null>): Candidate | null {
        if (constraint.type === 'nested' || constraint.type === 'null' || constraint.type === 'column' || constraint.type === 'part' || constraint.type === 'time' || constraint.not) {
            return null;
        }

        // A value a path reaches inside a JSON column is never indexed, so a path always runs as a residual.
        if (constraint.type === 'json-length' || Columns.path(constraint.column).path.length > 0) {
            return null;
        }

        if (constraint.type === 'json-contains') {
            return this.#contained(constraint, schema, excluded);
        }

        const target: { source: 'key' | 'index'; index: string | null; rank: number } | null = this.#target(constraint.column, schema, excluded);

        if (target === null) {
            return null;
        }

        const type: ColumnType | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === constraint.column)?.type;

        if (constraint.type === 'in') {
            if (constraint.values.length === 0 || !constraint.values.every((value: unknown): boolean => this.#fits(value, type))) {
                return null;
            }

            return { constraint, ...target, range: null, values: this.#distinct(constraint.values), rechecked: false };
        }

        if (constraint.type === 'between') {
            if (!this.#fits(constraint.from, type) || !this.#fits(constraint.to, type)) {
                return null;
            }

            if (indexedDB.cmp(constraint.from, constraint.to) > 0) {
                return { constraint, ...target, range: null, values: [], rechecked: false };
            }

            return { constraint, ...target, range: IDBKeyRange.bound(constraint.from as IDBValidKey, constraint.to as IDBValidKey, false, false), values: null, rechecked: false };
        }

        if (!RANGEABLE.has(constraint.operator) || !this.#fits(constraint.value, type)) {
            return null;
        }

        return { constraint, ...target, range: this.#range(constraint.operator, constraint.value as IDBValidKey), values: null, rechecked: false };
    }

    /**
     * Assess whether a JSON contains can drive the scan through the multi entry index over its column.
     */
    static #contained(constraint: Extract<Constraint, { type: 'json-contains' }>, schema: TableSchema, excluded: ReadonlySet<string | null>): Candidate | null {
        const index: IndexSchema | undefined = schema.indexes.find(
            (candidate: IndexSchema): boolean => candidate.multiEntry && candidate.columns.length === 1 && candidate.columns[0] === constraint.column && !excluded.has(candidate.name),
        );

        if (index === undefined || !this.#element(constraint.value)) {
            return null;
        }

        // A multi entry index holds a value that is not an array as an entry of its own, though a
        // scan finds no element in it, so the constraint is checked again against each record.
        return {
            constraint,
            source   : 'index',
            index    : index.name,
            rank     : index.unique ? 1 : 2,
            range    : IDBKeyRange.only(constraint.value as IDBValidKey),
            values   : null,
            rechecked: true,
        };
    }

    /**
     * Determine whether a value is an element the index finds exactly where a scan does, which compares elements strictly.
     */
    static #element(value: unknown): boolean {
        return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    }

    /**
     * Resolve the column to the key path or a single column index that holds one entry per record, unless that source is excluded.
     */
    static #target(column: string, schema: TableSchema, excluded: ReadonlySet<string | null>): { source: 'key' | 'index'; index: string | null; rank: number } | null {
        if (schema.key === column && !excluded.has(null)) {
            return { source: 'key', index: null, rank: 0 };
        }

        const index: IndexSchema | undefined = schema.indexes.find(
            (candidate: IndexSchema): boolean => candidate.columns.length === 1 && candidate.columns[0] === column && !candidate.multiEntry && !excluded.has(candidate.name),
        );

        if (index === undefined) {
            return null;
        }

        return { source: 'index', index: index.name, rank: index.unique ? 1 : 2 };
    }

    /**
     * Get the index able to satisfy the requested order without dropping records.
     */
    static #ordering(orders: readonly Order[], schema: TableSchema, excluded: ReadonlySet<string | null>): Candidate | null {
        const order: Order | undefined = orders[0];

        if (orders.length !== 1 || order === undefined) {
            return null;
        }

        const target: { source: 'key' | 'index'; index: string | null; rank: number } | null = this.#target(order.column, schema, excluded);

        if (target === null) {
            return null;
        }

        const column: ColumnSchema | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === order.column);

        if (column?.nullable) {
            return null;
        }

        return { constraint: { type: 'null', column: order.column, conjunction: 'and', not: false }, ...target, range: null, values: null, rechecked: false };
    }

    /**
     * Get the cursor direction the orders ask for.
     */
    static #direction(orders: readonly Order[]): IDBCursorDirection {
        return orders[0]?.direction === 'desc' ? 'prev' : 'next';
    }

    /**
     * Build the key range for a comparison operator.
     */
    static #range(operator: Operator, value: IDBValidKey): IDBKeyRange {
        switch (operator) {
            case '>':
                return IDBKeyRange.lowerBound(value, true);

            case '>=':
                return IDBKeyRange.lowerBound(value, false);

            case '<':
                return IDBKeyRange.upperBound(value, true);

            case '<=':
                return IDBKeyRange.upperBound(value, false);

            default:
                return IDBKeyRange.only(value);
        }
    }

    /**
     * Drop the values that repeat an earlier one, comparing them as keys.
     */
    static #distinct(values: readonly unknown[]): unknown[] {
        const positions: number[] = values
            .map((_: unknown, position: number): number => position)
            .sort((a: number, b: number): number => indexedDB.cmp(values[a], values[b]) || a - b);

        const repeated: Set<number> = new Set<number>(positions.filter(
            (position: number, rank: number): boolean => rank > 0 && indexedDB.cmp(values[positions[rank - 1] as number], values[position]) === 0,
        ));

        return values.filter((_: unknown, position: number): boolean => !repeated.has(position));
    }

    /**
     * Convert the values a single constraint compares, when its column is declared.
     */
    static #prepared(constraint: Constraint, types: ReadonlyMap<string, ColumnType>, timezone: string): Constraint {
        if (constraint.type === 'nested') {
            return { ...constraint, constraints: this.prepare(constraint.constraints, types, timezone) };
        }

        if (constraint.type !== 'basic' && constraint.type !== 'in' && constraint.type !== 'between') {
            return constraint;
        }

        const type: ColumnType | undefined = types.get(constraint.column);

        if (type === undefined) {
            return constraint;
        }

        if (constraint.type === 'in') {
            return { ...constraint, values: constraint.values.map((value: unknown): unknown => this.convert(value, type, timezone)) };
        }

        if (constraint.type === 'between') {
            return { ...constraint, from: this.convert(constraint.from, type, timezone), to: this.convert(constraint.to, type, timezone) };
        }

        return CONVERTED.has(constraint.operator) ? { ...constraint, value: this.convert(constraint.value, type, timezone) } : constraint;
    }

    /**
     * Read a value as a finite number, and a whole one unless fractions are allowed, or null when it is not one.
     */
    static #number(value: unknown, fractional: boolean): number | null {
        const number: number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

        return Number.isFinite(number) && (fractional || Number.isInteger(number)) ? number : null;
    }

    /**
     * Read a value as a valid date, a YYYY-MM-DD string, alone or with a time but no offset, in the timezone, or null when it is not one.
     */
    static #date(value: unknown, timezone: string): Date | null {
        if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
            return null;
        }

        const date: Date = value instanceof Date ? value : Calendar.read(value, timezone);

        return Number.isNaN(date.getTime()) ? null : date;
    }

    /**
     * Determine whether a value is a key of the type its column stores, which an index compares as a scan does.
     */
    static #fits(value: unknown, type: ColumnType | undefined): boolean {
        switch (type) {
            case 'integer':
            case 'decimal':
                return Number.isInteger(value);

            case 'float':
                return typeof value === 'number' && Number.isFinite(value);

            case 'date':
            case 'datetime':
                return value instanceof Date && this.keyable(value);

            case 'string':
            case 'enum':
                return typeof value === 'string';

            case 'boolean':
                return false;

            default:
                return this.keyable(value);
        }
    }
}
