import { CheckConstraintViolationException, NotNullConstraintViolationException } from '../exceptions';
import { Calendar } from './Calendar';
import type { ColumnSchema, ColumnType, TableSchema } from './types';

const FALSY: ReadonlySet<string> = new Set<string>(['false', '0']);

const NUMERIC: RegExp = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const MOMENT: RegExp = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))?)?$/;

export class Enforcer {
    /**
     * Coerce a value into its declared column type, reading a calendar day or a time of day in the timezone.
     */
    static coerce(value: unknown, type: ColumnType, strict: boolean, timezone: string): unknown {
        if (value === null || value === undefined) {
            return value;
        }

        switch (type) {
            case 'string':
            case 'enum':
                return this.#text(value, strict);

            case 'integer':
                return this.#whole(value, strict, 'integer');

            case 'float':
                return this.#numeric(value, strict);

            case 'boolean':
                return typeof value === 'string' && FALSY.has(value) ? false : Boolean(value);

            case 'decimal':
                return this.#whole(value, strict, 'decimal');

            case 'date':
            case 'datetime':
                return this.#temporal(value, strict, timezone);

            default:
                return this.#structured(value, strict);
        }
    }

    /**
     * Prepare a record for insertion, applying defaults, timestamps and coercion.
     */
    static insertable(record: Record<string, unknown>, schema: TableSchema, strict: boolean, timezone: string, at: Date): Record<string, unknown> {
        const prepared: Record<string, unknown> = { ...record };

        this.#stamp(prepared, schema, at, true);

        for (const column of schema.columns) {
            if (this.#generated(column, prepared)) {
                continue;
            }

            if (!Object.hasOwn(prepared, column.name) && column.hasDefault) {
                prepared[column.name] = column.default;
            }

            prepared[column.name] = this.#value(prepared[column.name], column, schema, strict, timezone);
        }

        return prepared;
    }

    /**
     * Prepare a partial record for update, touching timestamps and coercing provided columns.
     */
    static updatable(record: Record<string, unknown>, schema: TableSchema, strict: boolean, timezone: string, at: Date): Record<string, unknown> {
        const prepared: Record<string, unknown> = { ...record };

        this.#stamp(prepared, schema, at, false);

        for (const column of schema.columns) {
            if (!Object.hasOwn(prepared, column.name)) {
                continue;
            }

            prepared[column.name] = this.#value(prepared[column.name], column, schema, strict, timezone);
        }

        return prepared;
    }

    /**
     * Coerce the value a write gives one column, enforcing nullability, or pass it through when the column is undeclared.
     */
    static field(value: unknown, name: string, schema: TableSchema, strict: boolean, timezone: string): unknown {
        const column: ColumnSchema | undefined = schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === name);

        return column === undefined ? value : this.#value(value, column, schema, strict, timezone);
    }

    /**
     * Coerce a single column value, enforcing nullability.
     */
    static #value(value: unknown, column: ColumnSchema, schema: TableSchema, strict: boolean, timezone: string): unknown {
        const coerced: unknown = this.#accepted(this.coerce(value, column.type, strict, timezone), column, schema, strict);

        if (coerced !== null && coerced !== undefined) {
            return coerced;
        }

        if (column.nullable) {
            return null;
        }

        if (strict) {
            throw new NotNullConstraintViolationException(schema.table, column.name);
        }

        return null;
    }

    /**
     * Reject a value an enumerated column does not accept.
     */
    static #accepted(value: unknown, column: ColumnSchema, schema: TableSchema, strict: boolean): unknown {
        if (column.values === null || value === null || value === undefined || column.values.includes(value as string)) {
            return value;
        }

        if (strict) {
            throw new CheckConstraintViolationException(schema.table, column.name, value, column.values);
        }

        // Loose, an unacceptable value is treated as absent, so the nullability rules decide from here.
        return null;
    }

    /**
     * Determine whether the column is a key the database generates.
     */
    static #generated(column: ColumnSchema, record: Record<string, unknown>): boolean {
        return column.primary && column.increments && !Object.hasOwn(record, column.name);
    }

    /**
     * Fill the timestamp columns the table declares.
     */
    static #stamp(record: Record<string, unknown>, schema: TableSchema, at: Date, creating: boolean): void {
        if (!schema.timestamps) {
            return;
        }

        if (creating && !Object.hasOwn(record, 'created_at')) {
            record['created_at'] = at;
        }

        if (!Object.hasOwn(record, 'updated_at')) {
            record['updated_at'] = at;
        }
    }

    /**
     * Coerce a value into a string, keeping a date as its ISO string.
     */
    static #text(value: unknown, strict: boolean): string | null {
        if (typeof value === 'string') {
            return value;
        }

        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }

        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString();
        }

        if (strict) {
            throw new TypeError(`Unable to coerce [${String(value)}] into a string.`);
        }

        return null;
    }

    /**
     * Coerce a value into a whole number, refusing a fraction under strict and rounding it when loose.
     */
    static #whole(value: unknown, strict: boolean, type: 'integer' | 'decimal'): number | null {
        const number: number | null = this.#numeric(value, strict);

        if (number === null || Number.isInteger(number)) {
            return number;
        }

        if (strict) {
            throw new TypeError(type === 'integer'
                ? `An integer column stores a whole number, so [${String(value)}] cannot be written. Round it first, as in Math.round(${String(value)}).`
                : `A decimal column stores a whole number of its smallest unit, so [${String(value)}] cannot be written. Scale it first, as in Math.round(19.99 * 100).`);
        }

        return Math.round(number);
    }

    /**
     * Coerce a value into a finite number, reading a blank string as null.
     */
    static #numeric(value: unknown, strict: boolean): number | null {
        if (typeof value === 'string' && value.trim() === '') {
            return null;
        }

        const number: number = this.#number(value);

        if (Number.isFinite(number)) {
            return number;
        }

        if (strict) {
            throw new TypeError(`Unable to coerce [${String(value)}] into a number.`);
        }

        return null;
    }

    /**
     * Read a number, a bigint within the safe integer range or a string in decimal notation, or NaN for anything else.
     */
    static #number(value: unknown): number {
        if (typeof value === 'number') {
            return value;
        }

        if (typeof value === 'bigint') {
            return Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
        }

        return typeof value === 'string' && NUMERIC.test(value.trim()) ? Number(value) : NaN;
    }

    /**
     * Coerce a value into a date, reading a blank string as null.
     */
    static #temporal(value: unknown, strict: boolean, timezone: string): Date | null {
        if (typeof value === 'string' && value.trim() === '') {
            return null;
        }

        const date: Date = this.#moment(value, timezone);

        if (!Number.isNaN(date.getTime())) {
            return date;
        }

        if (strict) {
            throw new TypeError(`Unable to coerce [${String(value)}] into a date.`);
        }

        return null;
    }

    /**
     * Read a date, a whole timestamp or an ISO 8601 string naming a real moment, one without an offset as that wall clock in the timezone, or an invalid date for anything else.
     */
    static #moment(value: unknown, timezone: string): Date {
        if (value instanceof Date) {
            return value;
        }

        if (typeof value === 'number') {
            return new Date(Number.isInteger(value) ? value : NaN);
        }

        const parts: RegExpExecArray | null = typeof value === 'string' ? MOMENT.exec(value) : null;

        if (parts === null || !this.#survives(parts)) {
            return new Date(NaN);
        }

        return parts[7] === undefined ? Calendar.read(value as string, timezone) : new Date((value as string).replace(' ', 'T'));
    }

    /**
     * Determine whether the parts of an ISO 8601 string name a moment that exists, rather than one that rolls over.
     */
    static #survives(parts: RegExpExecArray): boolean {
        const [year, month, day, hour, minute, second, , hours, minutes]: number[] = parts.slice(1).map((part: string | undefined): number => Number(part ?? 0)) as [number, number, number, number, number, number, number, number, number];
        const date: Date = Calendar.midnight(year, month - 1, day, 'UTC');

        return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && hours <= 23 && minutes <= 59;
    }

    /**
     * Coerce a value into a structure, parsing it when it arrives as a string.
     */
    static #structured(value: unknown, strict: boolean): unknown {
        if (typeof value !== 'string') {
            return value;
        }

        try {
            return JSON.parse(value);
        } catch {
            if (strict) {
                throw new TypeError(`Unable to coerce [${value}] into a structure.`);
            }

            return null;
        }
    }
}
