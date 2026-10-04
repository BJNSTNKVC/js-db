import { describe, expect, test } from 'vitest';
import { Enforcer } from '../../src/schema/Enforcer';
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

describe('Enforcer.coerce', (): void => {
    test.each([
        ['string', 7, '7'],
        ['string', 'seven', 'seven'],
        ['integer', '7', 7],
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
        expect(Enforcer.coerce(value, type, true)).toEqual(expected);
    });

    test.each(['false', '0'])('treats the string %s as boolean false', (value: string): void => {
        expect(Enforcer.coerce(value, 'boolean', true)).toEqual(false);
    });

    test.each(['date', 'datetime'] as ColumnType[])('coerces %s from an ISO string', (type: ColumnType): void => {
        const value: unknown = Enforcer.coerce('2026-08-27T21:00:00.000Z', type, true);

        expect(value).toBeInstanceOf(Date);
        expect((value as Date).toISOString()).toEqual('2026-08-27T21:00:00.000Z');
    });

    test.each(['date', 'datetime'] as ColumnType[])('passes an existing Date through %s', (type: ColumnType): void => {
        expect(Enforcer.coerce(at, type, true)).toEqual(at);
    });

    test('coerces datetime from a timestamp', (): void => {
        expect(Enforcer.coerce(at.getTime(), 'datetime', true)).toEqual(at);
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
        expect(Enforcer.coerce(null, type, true)).toBeNull();
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
        expect(Enforcer.coerce(undefined, type, true)).toBeUndefined();
    });

    test.each([
        ['integer', 'abc'],
        ['float', 'abc'],
        ['date', 'not a date'],
        ['datetime', 'not a date'],
        ['json', '{not json}'],
    ] as [ColumnType, unknown][])('throws for an uncoercible %s under strict', (type: ColumnType, value: unknown): void => {
        expect((): unknown => Enforcer.coerce(value, type, true)).toThrow(TypeError);
    });

    test.each([
        ['integer', 'abc'],
        ['float', 'abc'],
        ['date', 'not a date'],
        ['datetime', 'not a date'],
        ['json', '{not json}'],
    ] as [ColumnType, unknown][])('yields null for an uncoercible %s when loose', (type: ColumnType, value: unknown): void => {
        expect(Enforcer.coerce(value, type, false)).toBeNull();
    });
});

const NUMBERS: ColumnType[] = ['integer', 'float', 'decimal'];

const WHOLE: ColumnType[] = ['integer', 'decimal'];

const TEMPORAL: ColumnType[] = ['date', 'datetime'];

const BLANKS: string[] = ['', ' ', '\t\n', ' '];

describe('Enforcer.coerce into a number column', (): void => {
    describe.each(NUMBERS)('%s', (type: ColumnType): void => {
        test.each(BLANKS)('reads the blank string %j as null under strict', (value: string): void => {
            expect(Enforcer.coerce(value, type, true)).toBeNull();
        });

        test.each(BLANKS)('reads the blank string %j as null when loose', (value: string): void => {
            expect(Enforcer.coerce(value, type, false)).toBeNull();
        });

        test.each([
            [' 12 ', 12],
            ['+5', 5],
            ['-5', -5],
            ['1e3', 1000],
            ['1E3', 1000],
            ['5.', 5],
            [12, 12],
            [10n, 10],
            [-(2n ** 53n - 1n), -(2 ** 53 - 1)],
        ] as [unknown, number][])('accepts %o', (value: unknown, expected: number): void => {
            expect(Enforcer.coerce(value, type, true)).toEqual(expected);
            expect(Enforcer.coerce(value, type, false)).toEqual(expected);
        });

        test('keeps a negative zero', (): void => {
            expect(Object.is(Enforcer.coerce('-0', type, true), -0)).toEqual(true);
        });

        test.each([
            [[]],
            [[5]],
            [['5']],
            [{}],
            [true],
            [false],
            [Number.NaN],
            [Number.POSITIVE_INFINITY],
            [Number.NEGATIVE_INFINITY],
            ['NaN'],
            ['Infinity'],
            ['-Infinity'],
            ['0x10'],
            ['0b11'],
            ['0o7'],
            ['12abc'],
            ['1 2'],
            ['.'],
            ['e3'],
            [2n ** 53n],
            [new Date('2024-01-15T10:00:00.000Z')],
        ] as [unknown][])('refuses %o under strict', (value: unknown): void => {
            expect((): unknown => Enforcer.coerce(value, type, true)).toThrow(TypeError);
        });

        test.each([
            [[]],
            [[5]],
            [{}],
            [true],
            [Number.POSITIVE_INFINITY],
            ['0x10'],
            [2n ** 53n],
            [new Date('2024-01-15T10:00:00.000Z')],
        ] as [unknown][])('writes null in place of %o when loose', (value: unknown): void => {
            expect(Enforcer.coerce(value, type, false)).toBeNull();
        });
    });

    test('names the value it refuses', (): void => {
        expect((): unknown => Enforcer.coerce(true, 'integer', true)).toThrow(new TypeError('Unable to coerce [true] into a number.'));
    });

    test('names an infinite value it refuses in a decimal column as a number it cannot hold', (): void => {
        expect((): unknown => Enforcer.coerce(Number.POSITIVE_INFINITY, 'decimal', true)).toThrow(new TypeError('Unable to coerce [Infinity] into a number.'));
    });

    test.each(['.5', 0.5])('accepts the fraction %o in a float column', (value: unknown): void => {
        expect(Enforcer.coerce(value, 'float', true)).toEqual(0.5);
    });
});

describe('Enforcer.coerce a fraction into a whole number column', (): void => {
    describe.each(WHOLE)('%s', (type: ColumnType): void => {
        test.each([1.9, -7.9, 7.9, '1.9', '-1.5', 0.5, '.5'])('refuses %o under strict', (value: unknown): void => {
            expect((): unknown => Enforcer.coerce(value, type, true)).toThrow(TypeError);
        });

        test.each([
            [7.9, 8],
            [-7.9, -8],
            ['1.9', 2],
            [1.5, 2],
            [-1.5, -1],
            [2.5, 3],
            [-2.5, -2],
            [0.4, 0],
        ] as [unknown, number][])('rounds %o to %o when loose', (value: unknown, expected: number): void => {
            expect(Enforcer.coerce(value, type, false)).toEqual(expected);
        });
    });

    test('tells an integer column to round its value first', (): void => {
        expect((): unknown => Enforcer.coerce('1.9', 'integer', true)).toThrow(
            new TypeError('An integer column stores a whole number, so [1.9] cannot be written. Round it first, as in Math.round(1.9).'),
        );
    });

    test('rounds a fractional integer exactly as a decimal column does', (): void => {
        const values: number[] = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, -1.49, 1.49];

        expect(values.map((value: number): unknown => Enforcer.coerce(value, 'integer', false))).toEqual(
            values.map((value: number): unknown => Enforcer.coerce(value, 'decimal', false)),
        );
    });
});

describe('Enforcer.coerce into a string column', (): void => {
    describe.each(['string', 'enum'] as ColumnType[])('%s', (type: ColumnType): void => {
        test.each([
            ['seven', 'seven'],
            ['', ''],
            [7, '7'],
            [-1.5, '-1.5'],
            [true, 'true'],
            [false, 'false'],
            [10n, '10'],
        ] as [unknown, string][])('stores %o as %o', (value: unknown, expected: string): void => {
            expect(Enforcer.coerce(value, type, true)).toEqual(expected);
            expect(Enforcer.coerce(value, type, false)).toEqual(expected);
        });

        test('stores a date as its ISO string', (): void => {
            expect(Enforcer.coerce(new Date('2024-01-15T10:00:00.000Z'), type, true)).toEqual('2024-01-15T10:00:00.000Z');
        });

        test.each([
            [[]],
            [[5]],
            [['a', 'b']],
            [{}],
            [{ a: 1 }],
            [Number.NaN],
            [Number.POSITIVE_INFINITY],
            [new Date(Number.NaN)],
        ] as [unknown][])('refuses %o under strict', (value: unknown): void => {
            expect((): unknown => Enforcer.coerce(value, type, true)).toThrow(TypeError);
        });

        test.each([
            [[]],
            [[5]],
            [{}],
            [Number.NaN],
            [new Date(Number.NaN)],
        ] as [unknown][])('writes null in place of %o when loose', (value: unknown): void => {
            expect(Enforcer.coerce(value, type, false)).toBeNull();
        });
    });

    test('names the value it refuses', (): void => {
        expect((): unknown => Enforcer.coerce({}, 'string', true)).toThrow(new TypeError('Unable to coerce [[object Object]] into a string.'));
    });
});

describe('Enforcer.coerce into a date column', (): void => {
    describe.each(TEMPORAL)('%s', (type: ColumnType): void => {
        test.each(BLANKS)('reads the blank string %j as null under strict', (value: string): void => {
            expect(Enforcer.coerce(value, type, true)).toBeNull();
        });

        test.each([
            ['2024-01-15T10:00:00.000Z', '2024-01-15T10:00:00.000Z'],
            ['2024-01-15T10:00:00Z', '2024-01-15T10:00:00.000Z'],
            ['2024-01-15T10:00Z', '2024-01-15T10:00:00.000Z'],
            ['2024-01-15T10:00:00.123+02:00', '2024-01-15T08:00:00.123Z'],
            ['2024-01-15T10:00:00.123456Z', '2024-01-15T10:00:00.123Z'],
            ['2024-01-15T00:30:00-05:30', '2024-01-15T06:00:00.000Z'],
            ['2024-02-29', '2024-02-29T00:00:00.000Z'],
            ['2024-01-15', '2024-01-15T00:00:00.000Z'],
            ['2024-12-31T23:59:59Z', '2024-12-31T23:59:59.000Z'],
            [1705312800000, '2024-01-15T10:00:00.000Z'],
            [0, '1970-01-01T00:00:00.000Z'],
            [-1, '1969-12-31T23:59:59.999Z'],
        ] as [unknown, string][])('accepts %o', (value: unknown, expected: string): void => {
            expect((Enforcer.coerce(value, type, true) as Date).toISOString()).toEqual(expected);
        });

        test.each([
            ['2024-01-15T10:00', [2024, 0, 15, 10, 0, 0]],
            ['2024-01-15T10:00:30', [2024, 0, 15, 10, 0, 30]],
            ['2024-01-15 10:00:30', [2024, 0, 15, 10, 0, 30]],
            ['2024-01-15 10:00', [2024, 0, 15, 10, 0, 0]],
        ] as [string, [number, number, number, number, number, number]][])('reads %o in local time', (value: string, parts: [number, number, number, number, number, number]): void => {
            expect(Enforcer.coerce(value, type, true)).toEqual(new Date(...parts));
        });

        test.each([
            ['1'],
            ['0'],
            [true],
            [false],
            [[5]],
            [{}],
            ['2024-02-30'],
            ['2023-02-29'],
            ['2024-04-31T10:00:00Z'],
            ['2024-13-01'],
            ['2024-00-10'],
            ['2024-01-00'],
            ['2024-01-15T24:00:00Z'],
            ['2024-01-15T10:60:00Z'],
            ['2024-01-15T10:00:60Z'],
            ['2024-01-15T10:00:00+24:00'],
            ['2024-01-15T10:00:00+02:60'],
            ['2024-01-15T10:00:00+0200'],
            ['2024-01-15T10'],
            ['2024-01-15t10:00:00z'],
            ['2024'],
            ['2024-01'],
            ['20240115'],
            ['01/15/2024'],
            ['Jan 15 2024'],
            ['Mon, 15 Jan 2024 10:00:00 GMT'],
            ['+002024-01-15'],
            [' 2024-01-15'],
            [1.5],
            [Number.NaN],
            [Number.POSITIVE_INFINITY],
            [8.64e15 + 1],
            [new Date(Number.NaN)],
            [10n],
        ] as [unknown][])('refuses %o under strict', (value: unknown): void => {
            expect((): unknown => Enforcer.coerce(value, type, true)).toThrow(TypeError);
        });

        test.each([
            ['1'],
            [true],
            [[5]],
            ['2024-02-30'],
            ['01/15/2024'],
            [1.5],
            [10n],
        ] as [unknown][])('writes null in place of %o when loose', (value: unknown): void => {
            expect(Enforcer.coerce(value, type, false)).toBeNull();
        });

        test('passes the very date it was given', (): void => {
            expect(Enforcer.coerce(at, type, true)).toBe(at);
        });
    });

    test('names the value it refuses', (): void => {
        expect((): unknown => Enforcer.coerce('2024-02-30', 'datetime', true)).toThrow(new TypeError('Unable to coerce [2024-02-30] into a date.'));
    });
});

describe('Enforcer blank strings', (): void => {
    describe.each([...NUMBERS, ...TEMPORAL])('%s', (type: ColumnType): void => {
        test('writes null for a blank string in a nullable column on insert', (): void => {
            const schema: TableSchema = table([column('value', type, { nullable: true })]);

            expect(Enforcer.insertable({ value: ' ' }, schema, true, at)).toEqual({ value: null });
        });

        test('writes null for a blank string in a nullable column on update', (): void => {
            const schema: TableSchema = table([column('value', type, { nullable: true })]);

            expect(Enforcer.updatable({ value: '' }, schema, true, at)).toEqual({ value: null });
        });

        test('throws for a blank string in a required column on insert under strict', (): void => {
            const schema: TableSchema = table([column('value', type)]);

            expect((): unknown => Enforcer.insertable({ value: '' }, schema, true, at)).toThrow(new NotNullConstraintViolationException('users', 'value'));
        });

        test('throws for a blank string in a required column on update under strict', (): void => {
            const schema: TableSchema = table([column('value', type)]);

            expect((): unknown => Enforcer.updatable({ value: ' ' }, schema, true, at)).toThrow(new NotNullConstraintViolationException('users', 'value'));
        });

        test('writes null for a blank string in a required column when loose', (): void => {
            const schema: TableSchema = table([column('value', type)]);

            expect(Enforcer.insertable({ value: '' }, schema, false, at)).toEqual({ value: null });
            expect(Enforcer.updatable({ value: '' }, schema, false, at)).toEqual({ value: null });
        });
    });

    test('keeps a blank string in a string column', (): void => {
        const schema: TableSchema = table([column('value', 'string')]);

        expect(Enforcer.insertable({ value: ' ' }, schema, true, at)).toEqual({ value: ' ' });
    });
});

describe('Enforcer.field', (): void => {
    test('coerces a value for a declared column', (): void => {
        const schema: TableSchema = table([column('visits', 'integer')]);

        expect(Enforcer.field(2.5, 'visits', schema, false)).toEqual(3);
    });

    test('refuses a value the column cannot hold under strict', (): void => {
        const schema: TableSchema = table([column('visits', 'integer')]);

        expect((): unknown => Enforcer.field(2.5, 'visits', schema, true)).toThrow(TypeError);
    });

    test('enforces nullability', (): void => {
        const schema: TableSchema = table([column('visits', 'integer')]);

        expect((): unknown => Enforcer.field(Number.NaN, 'visits', schema, true)).toThrow(TypeError);
        expect((): unknown => Enforcer.field(null, 'visits', schema, true)).toThrow(NotNullConstraintViolationException);
        expect(Enforcer.field(Number.NaN, 'visits', schema, false)).toBeNull();
    });

    test('passes a value for an undeclared column through untouched', (): void => {
        expect(Enforcer.field('kept', 'extra', table([]), true)).toEqual('kept');
    });
});

describe('Enforcer.insertable', (): void => {
    test('applies a default for an absent column', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Enforcer.insertable({}, schema, true, at)).toEqual({ age: 18 });
    });

    test('keeps a provided value over the default', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Enforcer.insertable({ age: 30 }, schema, true, at)).toEqual({ age: 30 });
    });

    test('coerces a provided value', (): void => {
        const schema: TableSchema = table([column('age', 'integer')]);

        expect(Enforcer.insertable({ age: '30' }, schema, true, at)).toEqual({ age: 30 });
    });

    test('fills both timestamps', (): void => {
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Enforcer.insertable({}, schema, true, at)).toEqual({ created_at: at, updated_at: at });
    });

    test('does not overwrite a provided timestamp', (): void => {
        const earlier: Date = new Date('2020-01-01T00:00:00.000Z');
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Enforcer.insertable({ created_at: earlier }, schema, true, at)).toEqual({ created_at: earlier, updated_at: at });
    });

    test('does not fill timestamps for a table without them', (): void => {
        const schema: TableSchema = table([column('name', 'string')]);

        expect(Enforcer.insertable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John' });
    });

    test('throws for an absent non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Enforcer.insertable({}, schema, true, at)).toThrow(new NotNullConstraintViolationException('users', 'email'));
    });

    test('throws for an explicit null in a non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Enforcer.insertable({ email: null }, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('writes null for an absent non nullable column when loose', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect(Enforcer.insertable({}, schema, false, at)).toEqual({ email: null });
    });

    test('allows an absent nullable column', (): void => {
        const schema: TableSchema = table([column('email', 'string', { nullable: true })]);

        expect(Enforcer.insertable({}, schema, true, at)).toEqual({ email: null });
    });

    test('skips the generated key', (): void => {
        const schema: TableSchema = table([column('id', 'integer', { primary: true, increments: true })]);

        expect(Enforcer.insertable({}, schema, true, at)).toEqual({});
    });

    test('keeps an explicitly provided key', (): void => {
        const schema: TableSchema = table([column('id', 'integer', { primary: true, increments: true })]);

        expect(Enforcer.insertable({ id: 7 }, schema, true, at)).toEqual({ id: 7 });
    });

    test('requires a non incrementing key', (): void => {
        const schema: TableSchema = table([column('id', 'string', { primary: true })], { increments: false });

        expect((): unknown => Enforcer.insertable({}, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('passes undeclared columns through untouched', (): void => {
        const schema: TableSchema = table([]);

        expect(Enforcer.insertable({ extra: 'kept' }, schema, true, at)).toEqual({ extra: 'kept' });
    });
});

describe('Enforcer.updatable', (): void => {
    test('touches only the update timestamp', (): void => {
        const schema: TableSchema = table([
            column('created_at', 'datetime', { nullable: true }),
            column('updated_at', 'datetime', { nullable: true }),
        ], { timestamps: true });

        expect(Enforcer.updatable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John', updated_at: at });
    });

    test('does not touch timestamps for a table without them', (): void => {
        const schema: TableSchema = table([column('name', 'string')]);

        expect(Enforcer.updatable({ name: 'John' }, schema, true, at)).toEqual({ name: 'John' });
    });

    test('coerces provided columns', (): void => {
        const schema: TableSchema = table([column('age', 'integer')]);

        expect(Enforcer.updatable({ age: '30' }, schema, true, at)).toEqual({ age: 30 });
    });

    test('does not apply defaults for absent columns', (): void => {
        const schema: TableSchema = table([column('age', 'integer', { hasDefault: true, default: 18 })]);

        expect(Enforcer.updatable({}, schema, true, at)).toEqual({});
    });

    test('throws for an explicit null in a non nullable column under strict', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect((): unknown => Enforcer.updatable({ email: null }, schema, true, at)).toThrow(NotNullConstraintViolationException);
    });

    test('writes null for a non nullable column when loose', (): void => {
        const schema: TableSchema = table([column('email', 'string')]);

        expect(Enforcer.updatable({ email: null }, schema, false, at)).toEqual({ email: null });
    });

    test('passes undeclared columns through untouched', (): void => {
        const schema: TableSchema = table([]);

        expect(Enforcer.updatable({ extra: 'kept' }, schema, true, at)).toEqual({ extra: 'kept' });
    });

    test('honours an explicitly provided update timestamp', (): void => {
        const earlier: Date = new Date('2020-01-01T00:00:00.000Z');
        const schema: TableSchema = table([column('updated_at', 'datetime', { nullable: true })], { timestamps: true });

        expect(Enforcer.updatable({ updated_at: earlier }, schema, true, at)).toEqual({ updated_at: earlier });
    });
});
