import { CheckConstraintViolationException, NotNullConstraintViolationException } from '../exceptions';
import type { ColumnSchema, ColumnType, TableSchema } from './types';

const FALSY: ReadonlySet<string> = new Set<string>(['false', '0']);

export class Enforcer {
    /**
     * Coerce a value into its declared column type.
     */
    static coerce(value: unknown, type: ColumnType, strict: boolean): unknown {
        if (value === null || value === undefined) {
            return value;
        }

        switch (type) {
            case 'string':
                return String(value);

            case 'integer':
                return this.#numeric(value, strict, true);

            case 'float':
                return this.#numeric(value, strict, false);

            case 'boolean':
                return typeof value === 'string' && FALSY.has(value) ? false : Boolean(value);

            case 'decimal':
                return this.#scaled(value, strict);

            case 'enum':
                return String(value);

            case 'date':
            case 'datetime':
                return this.#temporal(value, strict);

            default:
                return this.#structured(value, strict);
        }
    }

    /**
     * Prepare a record for insertion, applying defaults, timestamps and coercion.
     */
    static insertable(record: Record<string, unknown>, schema: TableSchema, strict: boolean, at: Date): Record<string, unknown> {
        const prepared: Record<string, unknown> = { ...record };

        this.#stamp(prepared, schema, at, true);

        for (const column of schema.columns) {
            if (this.#generated(column, prepared)) {
                continue;
            }

            if (!Object.hasOwn(prepared, column.name) && column.hasDefault) {
                prepared[column.name] = column.default;
            }

            prepared[column.name] = this.#value(prepared[column.name], column, schema, strict);
        }

        return prepared;
    }

    /**
     * Prepare a partial record for update, touching timestamps and coercing provided columns.
     */
    static updatable(record: Record<string, unknown>, schema: TableSchema, strict: boolean, at: Date): Record<string, unknown> {
        const prepared: Record<string, unknown> = { ...record };

        this.#stamp(prepared, schema, at, false);

        for (const column of schema.columns) {
            if (!Object.hasOwn(prepared, column.name)) {
                continue;
            }

            prepared[column.name] = this.#value(prepared[column.name], column, schema, strict);
        }

        return prepared;
    }

    /**
     * Coerce a single column value, enforcing nullability.
     */
    static #value(value: unknown, column: ColumnSchema, schema: TableSchema, strict: boolean): unknown {
        const coerced: unknown = this.#accepted(this.coerce(value, column.type, strict), column, schema, strict);

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
     * Coerce a value into a whole number of a decimal column's smallest unit.
     */
    static #scaled(value: unknown, strict: boolean): unknown {
        const number: number = Number(value);

        if (Number.isNaN(number)) {
            if (strict) {
                throw new TypeError(`Unable to coerce [${String(value)}] into a number.`);
            }

            return null;
        }

        // A decimal column holds its smallest unit, so a fractional value would be silently lost.
        if (!Number.isInteger(number)) {
            if (strict) {
                throw new TypeError(`A decimal column stores a whole number of its smallest unit, so [${String(value)}] cannot be written. Scale it first, as in Math.round(19.99 * 100).`);
            }

            return Math.round(number);
        }

        return number;
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
     * Coerce a value into a number, truncating when the column is an integer.
     */
    static #numeric(value: unknown, strict: boolean, truncate: boolean): unknown {
        const number: number = Number(value);

        if (Number.isNaN(number)) {
            if (strict) {
                throw new TypeError(`Unable to coerce [${String(value)}] into a number.`);
            }

            return null;
        }

        return truncate ? Math.trunc(number) : number;
    }

    /**
     * Coerce a value into a date.
     */
    static #temporal(value: unknown, strict: boolean): unknown {
        const date: Date = value instanceof Date ? value : new Date(value as string | number);

        if (Number.isNaN(date.getTime())) {
            if (strict) {
                throw new TypeError(`Unable to coerce [${String(value)}] into a date.`);
            }

            return null;
        }

        return date;
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
