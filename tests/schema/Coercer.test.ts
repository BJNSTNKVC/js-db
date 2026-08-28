import { describe, expect, test } from 'vitest';
import { Coercer } from '../../src/schema/Coercer';
import { NotNullConstraintViolationException } from '../../src/exceptions';
import type { ColumnSchema, ColumnType, TableSchema } from '../../src/schema/types';

/**
 * Build a column schema with the given overrides.
 */
function column(name: string, type: ColumnType, overrides: Partial<ColumnSchema> = {}): ColumnSchema {
    return {
        name,
        type,
        nullable  : false,
        default   : undefined,
        hasDefault: false,
        primary   : false,
        increments: false,
        places    : null,
        values    : null,
        ...overrides,
    };
}

/**
 * Build a table schema from the given columns.
 */
function table(columns: ColumnSchema[], overrides: Partial<TableSchema> = {}): TableSchema {
    return {
        table     : 'users',
        key       : 'id',
        increments: true,
        timestamps: false,
        columns,
        indexes   : [],
        ...overrides,
    };
}

const at: Date = new Date('2026-08-27T21:00:00.000Z');

describe('Coercer.coerce', (): void => {
    test.each([
        ['string', 7, '7'],
        ['string', 'seven', 'seven'],
        ['integer', '7', 7],
        ['integer', 7.9, 7],
        ['integer', -7.9, -7],
        ['float', '7.5', 7.5],
        ['float', 7.5, 7.5],
        ['boolean', 1, true],
        ['boolean', 0, false],
        ['boolean', 'yes', true],
        ['boolean', '', false],
        ['json', { a: 1 }, { a: 1 }],
        ['json', '{"a":1}', { a: 1 }],
        ['json', '[1,2]', [1, 2]],
    ] as [ColumnType, unknown, unknown][])('coerces %s from %o', (type: ColumnType, value: unknown, expected: unknown): void => {
        expect(Coercer.coerce(value, type, true)).toEqual(expected);
    });

    test.each(['false', '0'])('treats the string %s as boolean false', (value: string): void => {
        expect(Coercer.coerce(value, 'boolean', true)).toEqual(false);
    });

    test.each(['date', 'datetime'] as ColumnType[])('coerces %s from an ISO string', (type: ColumnType): void => {
        const value: unknown = Coercer.coerce('2026-08-27T21:00:00.000Z', type, true);

        expect(value).toBeInstanceOf(Date);
        expect((value as Date).toISOString()).toEqual('2026-08-27T21:00:00.000Z');
    });

    test.each(['date', 'datetime'] as ColumnType[])('passes an existing Date through %s', (type: ColumnType): void => {
        expect(Coercer.coerce(at, type, true)).toEqual(at);
    });

    test('coerces datetime from a timestamp', (): void => {
        expect(Coercer.coerce(at.getTime(), 'datetime', true)).toEqual(at);
    });

    test.each([
        'string',
        'integer',
        'float',
        'boolean',
        'date',
        'datetime',
        'json',
    ] as ColumnType[])('passes null through %s', (type: ColumnType): void => {
        expect(Coercer.coerce(null, type, true)).toBeNull();
    });

    test.each([
        'string',
        'integer',
        'float',
        'boolean',
        'date',
        'datetime',
        'json',
    ] as ColumnType[])('passes undefined through %s', (type: ColumnType): void => {
        expect(Coercer.coerce(undefined, type, true)).toBeUndefined();
    });

    test.each([
        ['integer', 'abc'],
        ['float', 'abc'],
        ['date', 'not a date'],
        ['datetime', 'not a date'],
        ['json', '{not json}'],
    ] as [ColumnType, unknown][])('throws for an uncoercible %s under strict', (type: ColumnType, value: unknown): void => {
        expect((): unknown => Coercer.coerce(value, type, true)).toThrow(TypeError);
    });

    test.each([
        ['integer', 'abc'],
        ['float', 'abc'],
        ['date', 'not a date'],
        ['datetime', 'not a date'],
        ['json', '{not json}'],
    ] as [ColumnType, unknown][])('yields null for an uncoercible %s when loose', (type: ColumnType, value: unknown): void => {
        expect(Coercer.coerce(value, type, false)).toBeNull();
    });
});

describe('Coercer.insertable', (): void => {
    test('applies a default for an absent column', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Coercer.insertable({}, schema, true, at)).toEqual({ age: 18 });
    });

    test('keeps a provided value over the default', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Coercer.insertable({ age: 30 }, schema, true, at)).toEqual({ age: 30 });
    });

    test('coerces a provided value', (): void => {
        const schema: TableSchema = table([column('age', 'integer')]);

        expect(Coercer.insertable({ age: '30' }, schema, true, at)).toEqual({ age: 30 });
    });

    test('fills both timestamps', (): void => {
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Coercer.insertable({}, schema, true, at)).toEqual({ created_at: at, updated_at: at });
    });

    test('does not overwrite a provided timestamp', (): void => {
        const earlier: Date = new Date('2020-01-01T00:00:00.000Z');
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Coercer.insertable({ created_at: earlier }, schema, true, at)).toEqual({ created_at: earlier, updated_at: at });
    });

    test('does not fill timestamps for a table without them', (): void => {
        const schema: TableSchema = table([column('name', 'string')]);

        expect(Coercer.insertable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John' });
    });

    test('throws for an absent non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Coercer.insertable({}, schema, true, at)).toThrow(new NotNullConstraintViolationException('users', 'email'));
    });

    test('throws for an explicit null in a non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Coercer.insertable({ email: null }, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('writes null for an absent non nullable column when loose', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect(Coercer.insertable({}, schema, false, at)).toEqual({ email: null });
    });

    test('allows an absent nullable column', (): void => {
        const schema: TableSchema = table([column('email', 'string', { nullable: true })]);

        expect(Coercer.insertable({}, schema, true, at)).toEqual({ email: null });
    });

    test('skips the generated key', (): void => {
        const schema: TableSchema = table([column('id', 'integer', { primary: true, increments: true })]);

        expect(Coercer.insertable({}, schema, true, at)).toEqual({});
    });

    test('keeps an explicitly provided key', (): void => {
        const schema: TableSchema = table([column('id', 'integer', { primary: true, increments: true })]);

        expect(Coercer.insertable({ id: 7 }, schema, true, at)).toEqual({ id: 7 });
    });

    test('requires a non incrementing key', (): void => {
        const schema: TableSchema = table([column('id', 'string', { primary: true })], { increments: false });

        expect((): unknown => Coercer.insertable({}, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('passes undeclared columns through untouched', (): void => {
        const schema: TableSchema = table([]);

        expect(Coercer.insertable({ extra: 'kept' }, schema, true, at)).toEqual({ extra: 'kept' });
    });
});

describe('Coercer.updatable', (): void => {
    test('touches only the update timestamp', (): void => {
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Coercer.updatable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John', updated_at: at });
    });

    test('does not touch timestamps for a table without them', (): void => {
        const schema: TableSchema = table([column('name', 'string')]);

        expect(Coercer.updatable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John' });
    });

    test('coerces provided columns', (): void => {
        const schema: TableSchema = table([column('age', 'integer')]);

        expect(Coercer.updatable({ age: '30' }, schema, true, at)).toEqual({ age: 30 });
    });

    test('does not apply defaults for absent columns', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Coercer.updatable({}, schema, true, at)).toEqual({});
    });

    test('throws for an explicit null in a non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Coercer.updatable({ email: null }, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('writes null for a non nullable column when loose', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect(Coercer.updatable({ email: null }, schema, false, at)).toEqual({ email: null });
    });

    test('passes undeclared columns through untouched', (): void => {
        const schema: TableSchema = table([]);

        expect(Coercer.updatable({ extra: 'kept' }, schema, true, at)).toEqual({ extra: 'kept' });
    });

    test('honours an explicitly provided update timestamp', (): void => {
        const earlier: Date = new Date('2020-01-01T00:00:00.000Z');
        const schema: TableSchema = table([column('updated_at', 'datetime', { nullable: true })], { timestamps: true });

        expect(Coercer.updatable({ updated_at: earlier }, schema, true, at)).toEqual({ updated_at: earlier });
    });
});
