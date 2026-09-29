import { describe, expect, test } from 'vitest';
import { Planner } from '../../src/query/Planner';
import type { Conjunction, Constraint, Operator, Order, Plan } from '../../src/query/types';
import type { ColumnSchema, ColumnType, TableSchema } from '../../src/schema/types';

/**
 * Build a column schema with the given overrides.
 */
function column(name: string, overrides: Partial<ColumnSchema> = {}): ColumnSchema {
    return {
        name,
        type      : 'integer',
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

const users: TableSchema = {
    table     : 'users',
    key       : 'id',
    increments: true,
    timestamps: false,
    columns   : [
        column('id', { primary: true, increments: true }),
        column('email', { type: 'string' }),
        column('name', { type: 'string' }),
        column('age', { nullable: true }),
        column('score', { type: 'float' }),
        column('active', { type: 'boolean' }),
        column('born', { type: 'date' }),
        column('tags', { type: 'json' }),
    ],
    indexes   : [
        { name: 'users_email_unique', columns: ['email'], unique: true, multiEntry: false },
        { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
        { name: 'users_age_index', columns: ['age'], unique: false, multiEntry: false },
        { name: 'users_name_age_index', columns: ['name', 'age'], unique: false, multiEntry: false },
        { name: 'users_active_index', columns: ['active'], unique: false, multiEntry: false },
        { name: 'users_born_index', columns: ['born'], unique: false, multiEntry: false },
        { name: 'users_tags_index', columns: ['tags'], unique: false, multiEntry: false },
    ],
};

const types: ReadonlyMap<string, ColumnType> = new Map<string, ColumnType>(users.columns.map((schema: ColumnSchema): [string, ColumnType] => [schema.name, schema.type]));

/**
 * Build a basic constraint.
 */
function basic(col: string, operator: Operator, value: unknown, conjunction: Conjunction = 'and', not: boolean = false): Constraint {
    return {
        type: 'basic',
        column: col,
        operator,
        value,
        conjunction,
        not,
    };
}

/**
 * Build an order.
 */
function order(col: string, direction: 'asc' | 'desc' = 'asc'): Order {
    return { column: col, direction };
}

describe('Planner key ranges', (): void => {
    test('drives an equality on the key path from the key', (): void => {
        const plan: Plan = Planner.plan([basic('id', '=', 7)], [], users);

        expect(plan.source).toEqual('key');
        expect(plan.index).toBeNull();
        expect(plan.range).toEqual(IDBKeyRange.only(7));
        expect(plan.residual).toEqual([]);
    });

    test('drives an equality on a unique index', (): void => {
        const plan: Plan = Planner.plan([basic('email', '=', 'a@b.c')], [], users);

        expect(plan.source).toEqual('index');
        expect(plan.index).toEqual('users_email_unique');
        expect(plan.range).toEqual(IDBKeyRange.only('a@b.c'));
        expect(plan.residual).toEqual([]);
    });

    test('drives an equality on a plain index', (): void => {
        const plan: Plan = Planner.plan([basic('name', '=', 'John')], [], users);

        expect(plan.index).toEqual('users_name_index');
        expect(plan.range).toEqual(IDBKeyRange.only('John'));
    });

    test.each([
        ['>', IDBKeyRange.lowerBound(18, true)],
        ['>=', IDBKeyRange.lowerBound(18, false)],
        ['<', IDBKeyRange.upperBound(18, true)],
        ['<=', IDBKeyRange.upperBound(18, false)],
    ] as [Operator, IDBKeyRange][])('builds a range for %s', (operator: Operator, expected: IDBKeyRange): void => {
        expect(Planner.plan([basic('age', operator, 18)], [], users).range).toEqual(expected);
    });

    test('builds a bounded range for between', (): void => {
        const plan: Plan = Planner.plan([{ type: 'between', column: 'age', from: 18, to: 65, conjunction: 'and', not: false }], [], users);

        expect(plan.index).toEqual('users_age_index');
        expect(plan.range).toEqual(IDBKeyRange.bound(18, 65, false, false));
        expect(plan.residual).toEqual([]);
    });

    test('turns an indexed whereIn into point lookups', (): void => {
        const plan: Plan = Planner.plan([{ type: 'in', column: 'email', values: ['a@b.c', 'd@e.f'], conjunction: 'and', not: false }], [], users);

        expect(plan.source).toEqual('index');
        expect(plan.index).toEqual('users_email_unique');
        expect(plan.range).toBeNull();
        expect(plan.values).toEqual(['a@b.c', 'd@e.f']);
        expect(plan.residual).toEqual([]);
    });

    test('turns a whereIn on the key path into point lookups', (): void => {
        const plan: Plan = Planner.plan([{ type: 'in', column: 'id', values: [1, 2], conjunction: 'and', not: false }], [], users);

        expect(plan.source).toEqual('key');
        expect(plan.values).toEqual([1, 2]);
    });

    test.each([
        ['numbers', 'id', [1, 2, 1], [1, 2]],
        ['strings', 'email', ['a@b.c', 'a@b.c'], ['a@b.c']],
        ['dates', 'born', [new Date(1), new Date(2), new Date(1)], [new Date(1), new Date(2)]],
        ['arrays', 'tags', [[1, 'a'], [1, 'a'], [1, 'b']], [[1, 'a'], [1, 'b']]],
    ] as [string, string, unknown[], unknown[]][])('looks up repeated %s once', (_: string, col: string, values: unknown[], expected: unknown[]): void => {
        expect(Planner.plan([{ type: 'in', column: col, values, conjunction: 'and', not: false }], [], users).values).toEqual(expected);
    });

    test('plans a reversed between as an empty result rather than a range', (): void => {
        const plan: Plan = Planner.plan([{ type: 'between', column: 'age', from: 65, to: 18, conjunction: 'and', not: false }], [], users);

        expect(plan.index).toEqual('users_age_index');
        expect(plan.range).toBeNull();
        expect(plan.values).toEqual([]);
        expect(plan.residual).toEqual([]);
    });

    test('plans a between whose bounds meet as a range', (): void => {
        expect(Planner.plan([{ type: 'between', column: 'age', from: 18, to: 18, conjunction: 'and', not: false }], [], users).range).toEqual(IDBKeyRange.bound(18, 18, false, false));
    });

    test('drives an index from an array of keys', (): void => {
        expect(Planner.plan([basic('tags', '=', [1, 'a', new Date(1)])], [], users).range).toEqual(IDBKeyRange.only([1, 'a', new Date(1)]));
    });

    test('prefers the key path over an index', (): void => {
        const plan: Plan = Planner.plan([basic('email', '=', 'a@b.c'), basic('id', '=', 7)], [], users);

        expect(plan.source).toEqual('key');
        expect(plan.residual).toEqual([basic('email', '=', 'a@b.c')]);
    });

    test('prefers a unique index over a plain one', (): void => {
        const plan: Plan = Planner.plan([basic('name', '=', 'John'), basic('email', '=', 'a@b.c')], [], users);

        expect(plan.index).toEqual('users_email_unique');
        expect(plan.residual).toEqual([basic('name', '=', 'John')]);
    });

    test('breaks a tie between plain indexes leftmost first', (): void => {
        const plan: Plan = Planner.plan([basic('name', '=', 'John'), basic('age', '=', 30)], [], users);

        expect(plan.index).toEqual('users_name_index');
        expect(plan.residual).toEqual([basic('age', '=', 30)]);
    });
});

describe('Planner fallbacks to a scan', (): void => {
    test('scans for an unindexed column', (): void => {
        const constraints: Constraint[] = [basic('score', '=', 1)];
        const plan: Plan = Planner.plan(constraints, [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.index).toBeNull();
        expect(plan.range).toBeNull();
        expect(plan.residual).toEqual(constraints);
    });

    test('scans with no constraints at all', (): void => {
        const plan: Plan = Planner.plan([], [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual([]);
    });

    test('scans when a top level or is present, even alongside an indexed equality', (): void => {
        const constraints: Constraint[] = [basic('id', '=', 7), basic('email', '=', 'a@b.c', 'or')];
        const plan: Plan = Planner.plan(constraints, [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual(constraints);
        expect(plan.ordered).toEqual(false);
    });

    test.each(['!=', '<>', '!==', 'like', 'not like'] as Operator[])('scans for the non rangeable operator %s', (operator: Operator): void => {
        expect(Planner.plan([basic('id', operator, 7)], [], users).source).toEqual('scan');
    });

    test('scans for a negated constraint', (): void => {
        expect(Planner.plan([basic('id', '=', 7, 'and', true)], [], users).source).toEqual('scan');
    });

    test('scans for a null constraint', (): void => {
        expect(Planner.plan([{ type: 'null', column: 'id', conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('scans for a nested constraint', (): void => {
        expect(Planner.plan([{ type: 'nested', constraints: [basic('id', '=', 7)], conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test.each([null, undefined])('scans for an equality against %o, which is not a valid key', (value: unknown): void => {
        expect(Planner.plan([basic('id', '=', value)], [], users).source).toEqual('scan');
    });

    test('scans for a whereIn holding a value that is not a valid key', (): void => {
        expect(Planner.plan([{ type: 'in', column: 'id', values: [1, null], conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('scans for an empty whereIn', (): void => {
        expect(Planner.plan([{ type: 'in', column: 'id', values: [], conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('scans for a between holding a value that is not a valid key', (): void => {
        expect(Planner.plan([{ type: 'between', column: 'age', from: null, to: 65, conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('scans for a compound index, which cannot be driven by a single column', (): void => {
        const table: TableSchema = { ...users, indexes: [{ name: 'users_name_age_index', columns: ['name', 'age'], unique: false, multiEntry: false }] };

        expect(Planner.plan([basic('name', '=', 'John')], [], table).source).toEqual('scan');
    });

    test('scans for a path into a column, which no index covers', (): void => {
        const constraints: Constraint[] = [basic('email->domain', '=', 'b.c')];
        const plan: Plan = Planner.plan(constraints, [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual(constraints);
    });

    test('scans for a JSON contains, even on an indexed column', (): void => {
        expect(Planner.plan([{ type: 'json-contains', column: 'email', value: 'a@b.c', conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('scans for a JSON length, even on the key path', (): void => {
        expect(Planner.plan([{ type: 'json-length', column: 'id', operator: '=', value: 1, conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test('keeps an indexed constraint driving the scan alongside a path', (): void => {
        const plan: Plan = Planner.plan([basic('name->first', '=', 'John'), basic('email', '=', 'a@b.c')], [], users);

        expect(plan.index).toEqual('users_email_unique');
        expect(plan.residual).toEqual([basic('name->first', '=', 'John')]);
    });

    test.each([
        ['a boolean', true],
        ['an object', { a: 1 }],
        ['an invalid date', new Date('')],
        ['an infinite number', Infinity],
        ['NaN', NaN],
        ['an array holding a boolean', [1, true]],
    ])('keeps %s off an index that would take it as given', (_: string, value: unknown): void => {
        expect(Planner.plan([basic('tags', '=', value)], [], users)).toMatchObject({ source: 'scan', range: null, values: null });
        expect(Planner.plan([{ type: 'in', column: 'tags', values: ['a', value], conjunction: 'and', not: false }], [], users).source).toEqual('scan');
        expect(Planner.plan([{ type: 'between', column: 'tags', from: 'a', to: value, conjunction: 'and', not: false }], [], users).source).toEqual('scan');
    });

    test.each([true, false])('keeps the boolean %o off a boolean index, which never holds it', (value: boolean): void => {
        expect(Planner.plan([basic('active', '=', value)], [], users).source).toEqual('scan');
    });

    test.each([
        ['a string on an integer index', 'age', '18'],
        ['a fraction on an integer index', 'age', 1.5],
        ['a date on an integer index', 'age', new Date(1)],
        ['a number on a string index', 'name', 5],
        ['a timestamp on a date index', 'born', 0],
        ['a string on a date index', 'born', '2024-01-15'],
        ['a string on the key path', 'id', '7'],
    ])('keeps %s off the index, since only a value of the column\'s type compares there as it does in a scan', (_: string, col: string, value: unknown): void => {
        expect(Planner.plan([basic(col, '=', value)], [], users).source).toEqual('scan');
        expect(Planner.plan([basic(col, '===', value)], [], users).source).toEqual('scan');
    });

    test('scans a table with no key path when constrained on a missing column', (): void => {
        const table: TableSchema = { ...users, key: null, indexes: [] };

        expect(Planner.plan([basic('id', '=', 7)], [], table).source).toEqual('scan');
    });
});

describe('Planner ordering', (): void => {
    test('cursors an index to satisfy the order', (): void => {
        const plan: Plan = Planner.plan([], [order('name')], users);

        expect(plan.source).toEqual('index');
        expect(plan.index).toEqual('users_name_index');
        expect(plan.ordered).toEqual(true);
        expect(plan.direction).toEqual('next');
        expect(plan.range).toBeNull();
    });

    test('reverses the cursor for a descending order', (): void => {
        expect(Planner.plan([], [order('name', 'desc')], users).direction).toEqual('prev');
    });

    test('cursors the key path to satisfy an order on it', (): void => {
        const plan: Plan = Planner.plan([], [order('id')], users);

        expect(plan.source).toEqual('key');
        expect(plan.index).toBeNull();
        expect(plan.ordered).toEqual(true);
    });

    test('refuses to order by a nullable indexed column, since the index would drop nulls', (): void => {
        const plan: Plan = Planner.plan([], [order('age')], users);

        expect(plan.source).toEqual('scan');
        expect(plan.ordered).toEqual(false);
    });

    test('refuses to order by an unindexed column', (): void => {
        expect(Planner.plan([], [order('score')], users).ordered).toEqual(false);
    });

    test('refuses to order by a path into an indexed column', (): void => {
        expect(Planner.plan([], [order('name->first')], users).ordered).toEqual(false);
    });

    test('refuses to order by more than one column', (): void => {
        expect(Planner.plan([], [order('name'), order('id')], users).ordered).toEqual(false);
    });

    test('keeps the range and gives up the order when they want different indexes', (): void => {
        const plan: Plan = Planner.plan([basic('email', '=', 'a@b.c')], [order('name')], users);

        expect(plan.index).toEqual('users_email_unique');
        expect(plan.range).toEqual(IDBKeyRange.only('a@b.c'));
        expect(plan.ordered).toEqual(false);
    });

    test('satisfies both when the range and the order want the same index', (): void => {
        const plan: Plan = Planner.plan([basic('name', '>=', 'J')], [order('name', 'desc')], users);

        expect(plan.index).toEqual('users_name_index');
        expect(plan.range).toEqual(IDBKeyRange.lowerBound('J', false));
        expect(plan.ordered).toEqual(true);
        expect(plan.direction).toEqual('prev');
    });

    test('satisfies both on the key path', (): void => {
        const plan: Plan = Planner.plan([basic('id', '>=', 7)], [order('id')], users);

        expect(plan.source).toEqual('key');
        expect(plan.ordered).toEqual(true);
    });

    test('gives up the order for point lookups, which arrive in key order', (): void => {
        const plan: Plan = Planner.plan([{ type: 'in', column: 'name', values: ['a', 'b'], conjunction: 'and', not: false }], [order('name')], users);

        expect(plan.values).toEqual(['a', 'b']);
        expect(plan.ordered).toEqual(false);
    });
});

describe('Planner.describe', (): void => {
    test('describes a key plan', (): void => {
        expect(Planner.describe(Planner.plan([basic('id', '=', 7)], [], users))).toEqual('key');
    });

    test('describes an index plan', (): void => {
        expect(Planner.describe(Planner.plan([basic('email', '=', 'a@b.c')], [], users))).toEqual('index:users_email_unique');
    });

    test('describes a scan', (): void => {
        expect(Planner.describe(Planner.plan([], [], users))).toEqual('scan');
    });
});

describe('Planner.convert', (): void => {
    test.each([
        ['integer', 10, 10],
        ['integer', '10', 10],
        ['integer', ' -3 ', -3],
        ['integer', '1e3', 1000],
        ['decimal', '1999', 1999],
        ['float', '1.5', 1.5],
        ['float', 1.5, 1.5],
        ['boolean', 'true', true],
        ['boolean', 'false', false],
        ['boolean', '0', false],
        ['boolean', 'no', true],
        ['boolean', '', false],
        ['boolean', 1, true],
        ['boolean', 0, false],
        ['datetime', '2024-01-15T00:00:00.000Z', new Date('2024-01-15T00:00:00.000Z')],
        ['datetime', 0, new Date(0)],
        ['date', '2024-01-15', new Date('2024-01-15')],
        ['date', new Date(5), new Date(5)],
    ] as [ColumnType, unknown, unknown][])('reads a %s column\'s value %o as %o', (type: ColumnType, value: unknown, expected: unknown): void => {
        expect(Planner.convert(value, type)).toEqual(expected);
    });

    test.each([
        ['integer', ''],
        ['integer', '   '],
        ['integer', '1.5'],
        ['integer', 1.5],
        ['decimal', '0.5'],
        ['integer', 'x'],
        ['float', Infinity],
        ['float', true],
        ['float', new Date(1)],
        ['datetime', ''],
        ['datetime', 'garbage'],
        ['datetime', true],
        ['datetime', { a: 1 }],
        ['string', 5],
        ['string', 'a'],
        ['enum', 'draft'],
        ['json', '{"a":1}'],
    ] as [ColumnType, unknown][])('leaves a %s column\'s value %o as given', (type: ColumnType, value: unknown): void => {
        expect(Planner.convert(value, type)).toBe(value);
    });
});

describe('Planner.prepare', (): void => {
    test.each(['=', '==', '!=', '<>', '<', '>', '<=', '>='] as Operator[])('converts the value compared by %s', (operator: Operator): void => {
        expect(Planner.prepare([basic('age', operator, '18')], types)).toEqual([basic('age', operator, 18)]);
    });

    test.each(['===', '!==', 'like', 'not like'] as Operator[])('keeps the value compared by %s as given', (operator: Operator): void => {
        expect(Planner.prepare([basic('age', operator, '18')], types)).toEqual([basic('age', operator, '18')]);
    });

    test('converts every value of a whereIn and both bounds of a between', (): void => {
        expect(Planner.prepare([
            { type: 'in', column: 'id', values: ['1', 2], conjunction: 'and', not: true },
            { type: 'between', column: 'born', from: '2024-01-01T00:00:00.000Z', to: 0, conjunction: 'or', not: false },
        ], types)).toEqual([
            { type: 'in', column: 'id', values: [1, 2], conjunction: 'and', not: true },
            { type: 'between', column: 'born', from: new Date('2024-01-01T00:00:00.000Z'), to: new Date(0), conjunction: 'or', not: false },
        ]);
    });

    test('converts inside a nested group', (): void => {
        const nested: Constraint = { type: 'nested', constraints: [basic('active', '=', 'true')], conjunction: 'and', not: true };

        expect(Planner.prepare([nested], types)).toEqual([{ ...nested, constraints: [basic('active', '=', true)] }]);
    });

    test('keeps the value given for a JSON path, which has no declared type', (): void => {
        expect(Planner.prepare([basic('tags->count', '=', '18')], types)).toEqual([basic('tags->count', '=', '18')]);
    });

    test('keeps the value given for an undeclared column', (): void => {
        expect(Planner.prepare([basic('missing', '=', '18')], types)).toEqual([basic('missing', '=', '18')]);
    });

    test('keeps a value that fails to convert as given, and off the index', (): void => {
        const prepared: Constraint[] = Planner.prepare([basic('age', '<', '1.5')], types);

        expect(prepared).toEqual([basic('age', '<', '1.5')]);
        expect(Planner.plan(prepared, [], users)).toMatchObject({ source: 'scan', residual: prepared });
    });

    test('puts a converted value on the index', (): void => {
        expect(Planner.plan(Planner.prepare([basic('age', '<', '18')], types), [], users).range).toEqual(IDBKeyRange.upperBound(18, true));
    });

    test('leaves constraints that carry no comparable value alone', (): void => {
        const constraints: Constraint[] = [
            { type: 'null', column: 'age', conjunction: 'and', not: false },
            { type: 'column', column: 'age', operator: '=', other: 'score', conjunction: 'and', not: false },
            { type: 'part', column: 'born', part: 'year', value: 2024, conjunction: 'and', not: false },
            { type: 'time', column: 'born', operator: '=', value: '09:30:00', conjunction: 'and', not: false },
            { type: 'json-contains', column: 'tags', value: '1', conjunction: 'and', not: false },
            { type: 'json-length', column: 'tags', operator: '=', value: 1, conjunction: 'and', not: false },
        ];

        expect(Planner.prepare(constraints, types)).toEqual(constraints);
    });
});
