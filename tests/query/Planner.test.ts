import { describe, expect, test } from 'vitest';
import { Planner } from '../../src/query/Planner';
import type { Conjunction, Constraint, Operator, Order, Plan } from '../../src/query/types';
import type { ColumnSchema, ColumnType, IndexSchema, TableSchema } from '../../src/schema/types';

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

describe('Planner ranges over a column that can hold any kind', (): void => {
    const loose: TableSchema = {
        ...users,
        indexes: [...users.indexes, { name: 'users_extra_index', columns: ['extra'], unique: false, multiEntry: false }],
    };

    test.each([
        ['<', 'x'],
        ['<=', 5],
        ['>', 'x'],
        ['>=', [9]],
        ['<', [9]],
    ] as [Operator, unknown][])('scans for %s %j on a JSON column', (operator: Operator, value: unknown): void => {
        const plan: Plan = Planner.plan([basic('tags', operator, value)], [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual([basic('tags', operator, value)]);
    });

    test.each([
        ['a', 'z'],
        [5, [9]],
        [[1], [9]],
        ['z', 1],
    ])('scans for a between %j and %j on a JSON column', (from: unknown, to: unknown): void => {
        const constraint: Constraint = { type: 'between', column: 'tags', from, to, conjunction: 'and', not: false };
        const plan: Plan = Planner.plan([constraint], [], users);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual([constraint]);
    });

    test('scans for a range on an indexed column no blueprint declares', (): void => {
        const plan: Plan = Planner.plan([basic('extra', '>=', 'x')], [], loose);

        expect(plan.source).toEqual('scan');
        expect(plan.residual).toEqual([basic('extra', '>=', 'x')]);
    });

    test('drives a range on another column while one on a JSON column is checked against each record', (): void => {
        const plan: Plan = Planner.plan([basic('tags', '>', 'x'), basic('age', '>=', 18)], [], users);

        expect(plan.index).toEqual('users_age_index');
        expect(plan.residual).toEqual([basic('tags', '>', 'x')]);
    });

    test.each([
        ['x'],
        [[9]],
        [[1, 'a', new Date(1)]],
    ])('trusts the index for equality with %j on a JSON column', (value: unknown): void => {
        const plan: Plan = Planner.plan([basic('tags', '=', value)], [], users);

        expect(plan.range).toEqual(IDBKeyRange.only(value));
        expect(plan.residual).toEqual([]);
        expect(Planner.plan([{ type: 'in', column: 'tags', values: [value], conjunction: 'and', not: false }], [], users).residual).toEqual([]);
    });

    test('trusts the index for a range on a column of one type', (): void => {
        expect(Planner.plan([basic('age', '>=', 18)], [], users).residual).toEqual([]);
        expect(Planner.plan([{ type: 'between', column: 'name', from: 'a', to: 'm', conjunction: 'and', not: false }], [], users).residual).toEqual([]);
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

describe('Planner on a multi-entry index', (): void => {
    const tagged: TableSchema = {
        ...users,
        indexes: [
            ...users.indexes.filter((index: IndexSchema): boolean => index.name !== 'users_tags_index'),
            { name: 'users_tags_index', columns: ['tags'], unique: false, multiEntry: true },
        ],
    };

    /**
     * Build a JSON contains constraint.
     */
    function contains(col: string, value: unknown, conjunction: Conjunction = 'and', not: boolean = false): Constraint {
        return { type: 'json-contains', column: col, value, conjunction, not };
    }

    test.each(['=', '==', '===', '>', '>=', '<', '<='] as Operator[])('keeps %s off the index, which holds elements rather than the array', (operator: Operator): void => {
        const constraints: Constraint[] = [basic('tags', operator, 'x')];

        expect(Planner.plan(constraints, [], tagged)).toMatchObject({ source: 'scan', range: null, values: null, residual: constraints });
    });

    test('keeps a whereIn and a between off the index', (): void => {
        expect(Planner.plan([{ type: 'in', column: 'tags', values: ['x', 'z'], conjunction: 'and', not: false }], [], tagged).source).toEqual('scan');
        expect(Planner.plan([{ type: 'between', column: 'tags', from: 'x', to: 'y', conjunction: 'and', not: false }], [], tagged).source).toEqual('scan');
    });

    test('keeps the order off the index, which would visit a record once per element', (): void => {
        expect(Planner.plan([], [order('tags')], tagged)).toMatchObject({ source: 'scan', ordered: false });
        expect(Planner.plan([], [order('tags', 'desc')], tagged)).toMatchObject({ source: 'scan', ordered: false });
    });

    test.each([
        ['a string', 'x'],
        ['a number', 3],
        ['zero', 0],
    ])('drives the index from a JSON contains of %s, checking it again against each record', (_: string, value: unknown): void => {
        const constraints: Constraint[] = [contains('tags', value)];

        expect(Planner.plan(constraints, [], tagged)).toEqual({
            source   : 'index',
            index    : 'users_tags_index',
            range    : IDBKeyRange.only(value),
            values   : null,
            direction: 'next',
            ordered  : false,
            residual : constraints,
        });
    });

    test('ranks a unique multi-entry index above a plain one', (): void => {
        const unique: TableSchema = { ...tagged, indexes: tagged.indexes.map((index: IndexSchema): IndexSchema => index.name === 'users_tags_index' ? { ...index, unique: true } : index) };

        expect(Planner.plan([basic('name', '=', 'John'), contains('tags', 'x')], [], unique).index).toEqual('users_tags_index');
        expect(Planner.plan([basic('name', '=', 'John'), contains('tags', 'x')], [], tagged).index).toEqual('users_name_index');
    });

    test('leaves the order to memory when a JSON contains drives the index', (): void => {
        expect(Planner.plan([contains('tags', 'x')], [order('tags')], tagged)).toMatchObject({ index: 'users_tags_index', ordered: false, direction: 'next' });
    });

    test('prefers the key path over the multi-entry index', (): void => {
        const plan: Plan = Planner.plan([contains('tags', 'x'), basic('id', '=', 7)], [], tagged);

        expect(plan.source).toEqual('key');
        expect(plan.residual).toEqual([contains('tags', 'x')]);
    });

    test.each([
        ['an array, which asks for every element', ['x', 'z']],
        ['a date, which a scan finds by identity alone', new Date(1)],
        ['NaN, which is no key', NaN],
        ['an infinite number', Infinity],
        ['a boolean', true],
        ['an object', { a: 1 }],
        ['null', null],
    ])('keeps a JSON contains of %s off the index', (_: string, value: unknown): void => {
        const constraints: Constraint[] = [contains('tags', value)];

        expect(Planner.plan(constraints, [], tagged)).toMatchObject({ source: 'scan', residual: constraints });
    });

    test('keeps a negated JSON contains off the index', (): void => {
        expect(Planner.plan([contains('tags', 'x', 'and', true)], [], tagged).source).toEqual('scan');
    });

    test('scans for a JSON contains joined by or', (): void => {
        expect(Planner.plan([basic('id', '=', 7), contains('tags', 'x', 'or')], [], tagged).source).toEqual('scan');
    });

    test('keeps a JSON contains on a path into the column off the index', (): void => {
        expect(Planner.plan([contains('tags->x', 'y')], [], tagged).source).toEqual('scan');
    });

    test('keeps a JSON contains off an index that is not multi-entry', (): void => {
        expect(Planner.plan([contains('tags', 'x')], [], users).source).toEqual('scan');
    });

    test('keeps a JSON contains off a compound index', (): void => {
        const compound: TableSchema = { ...users, indexes: [{ name: 'users_tags_name_index', columns: ['tags', 'name'], unique: false, multiEntry: true }] };

        expect(Planner.plan([contains('tags', 'x')], [], compound).source).toEqual('scan');
    });
});

describe('Planner.keyable', (): void => {
    test.each([
        ['an ArrayBuffer', new Uint8Array([1, 2]).buffer],
        ['an empty ArrayBuffer', new ArrayBuffer(0)],
        ['a Uint8Array', new Uint8Array([1, 2])],
        ['a typed array of wider elements', new Uint16Array([513])],
        ['a DataView', new DataView(new Uint8Array([1, 2]).buffer)],
        ['an array holding binary values', [new Uint8Array([1]), 'x', new DataView(new ArrayBuffer(1))]],
    ] as [string, unknown][])('accepts %s', (_name: string, value: unknown): void => {
        expect(Planner.keyable(value)).toEqual(true);
    });

    test.each([
        ['a boolean', true],
        ['an object', { a: 1 }],
        ['null', null],
        ['NaN', NaN],
        ['an array holding a boolean', [new Uint8Array([1]), true]],
    ] as [string, unknown][])('refuses %s', (_name: string, value: unknown): void => {
        expect(Planner.keyable(value)).toEqual(false);
    });
});

describe('Planner on binary keys', (): void => {
    const tokens: TableSchema = {
        table     : 'tokens',
        key       : 'id',
        increments: false,
        timestamps: false,
        columns   : [
            column('id', { type: 'json', primary: true }),
            column('data', { type: 'json' }),
            column('label', { type: 'string' }),
        ],
        indexes   : [
            { name: 'tokens_data_index', columns: ['data'], unique: false, multiEntry: false },
            { name: 'tokens_label_index', columns: ['label'], unique: false, multiEntry: false },
        ],
    };

    test('drives an equality on a binary key path from the key', (): void => {
        const plan: Plan = Planner.plan([basic('id', '=', new Uint8Array([1, 2]))], [], tokens);

        expect(plan.source).toEqual('key');
        expect(plan.range?.includes(new DataView(new Uint8Array([1, 2]).buffer))).toEqual(true);
        expect(plan.range?.includes(new Uint8Array([1, 3]))).toEqual(false);
        expect(plan.residual).toEqual([]);
    });

    test('looks up each distinct run of bytes a whereIn holds once', (): void => {
        const values: unknown[] = [new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer, new DataView(new Uint8Array([3]).buffer)];
        const plan: Plan = Planner.plan([{ type: 'in', column: 'id', values, conjunction: 'and', not: false }], [], tokens);

        expect(plan.source).toEqual('key');
        expect(plan.values).toEqual([values[0], values[2]]);
        expect(plan.residual).toEqual([]);
    });

    test('drives an equality with binary bytes on an index over a JSON column', (): void => {
        const plan: Plan = Planner.plan([basic('data', '=', new DataView(new Uint8Array([1]).buffer))], [], tokens);

        expect(plan.index).toEqual('tokens_data_index');
        expect(plan.residual).toEqual([]);
    });

    test('scans for a range of binary bytes on a JSON column', (): void => {
        const constraint: Constraint = basic('data', '>', new Uint8Array([1]));

        expect(Planner.plan([constraint], [], tokens).residual).toEqual([constraint]);
        expect(Planner.plan([constraint], [], tokens).source).toEqual('scan');
    });

    test('scans for binary bytes on a column of another type', (): void => {
        const constraint: Constraint = basic('label', '=', new Uint8Array([1]));

        expect(Planner.plan([constraint], [], tokens).source).toEqual('scan');
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
        ['date', new Date(5), new Date(5)],
    ] as [ColumnType, unknown, unknown][])('reads a %s column\'s value %o as %o', (type: ColumnType, value: unknown, expected: unknown): void => {
        expect(Planner.convert(value, type, 'UTC')).toEqual(expected);
    });

    test.each([
        ['date', '2024-01-15', new Date(2024, 0, 15), '2024-01-15T00:00:00.000Z', '2024-01-15T05:00:00.000Z'],
        ['datetime', '2024-01-15', new Date(2024, 0, 15), '2024-01-15T00:00:00.000Z', '2024-01-15T05:00:00.000Z'],
        ['datetime', '2024-01-15T10:00', new Date(2024, 0, 15, 10), '2024-01-15T10:00:00.000Z', '2024-01-15T15:00:00.000Z'],
        ['datetime', '2024-01-15 10:00', new Date(2024, 0, 15, 10), '2024-01-15T10:00:00.000Z', '2024-01-15T15:00:00.000Z'],
        ['date', '0099-01-01', new Date(new Date(99, 0, 1).setFullYear(99)), '0099-01-01T00:00:00.000Z', '0099-01-01T04:56:02.000Z'],
    ] as [ColumnType, string, Date, string, string][])('reads a %s column\'s value %o as a write does, in local time, in UTC and in a named timezone', (type: ColumnType, value: string, local: Date, utc: string, york: string): void => {
        expect(Planner.convert(value, type, 'local')).toEqual(local);
        expect((Planner.convert(value, type, 'UTC') as Date).toISOString()).toEqual(utc);
        expect((Planner.convert(value, type, 'America/New_York') as Date).toISOString()).toEqual(york);
    });

    test.each(['local', 'UTC', 'America/New_York'])('keeps a string with Z or an offset as the moment it names in %s', (timezone: string): void => {
        expect((Planner.convert('2024-01-15T10:00:00+02:00', 'datetime', timezone) as Date).toISOString()).toEqual('2024-01-15T08:00:00.000Z');
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
        ['date', '2024-02-30'],
        ['datetime', '2024-13-01'],
        ['datetime', true],
        ['datetime', { a: 1 }],
        ['string', 5],
        ['string', 'a'],
        ['enum', 'draft'],
        ['json', '{"a":1}'],
    ] as [ColumnType, unknown][])('leaves a %s column\'s value %o as given', (type: ColumnType, value: unknown): void => {
        for (const timezone of ['local', 'UTC', 'America/New_York']) {
            expect(Planner.convert(value, type, timezone)).toBe(value);
        }
    });
});

describe('Planner.prepare', (): void => {
    test.each(['=', '==', '!=', '<>', '<', '>', '<=', '>='] as Operator[])('converts the value compared by %s', (operator: Operator): void => {
        expect(Planner.prepare([basic('age', operator, '18')], types, 'UTC')).toEqual([basic('age', operator, 18)]);
    });

    test.each(['===', '!==', 'like', 'not like'] as Operator[])('keeps the value compared by %s as given', (operator: Operator): void => {
        expect(Planner.prepare([basic('age', operator, '18')], types, 'UTC')).toEqual([basic('age', operator, '18')]);
    });

    test('converts every value of a whereIn and both bounds of a between', (): void => {
        expect(Planner.prepare([
            { type: 'in', column: 'id', values: ['1', 2], conjunction: 'and', not: true },
            { type: 'between', column: 'born', from: '2024-01-01T00:00:00.000Z', to: 0, conjunction: 'or', not: false },
        ], types, 'UTC')).toEqual([
            { type: 'in', column: 'id', values: [1, 2], conjunction: 'and', not: true },
            { type: 'between', column: 'born', from: new Date('2024-01-01T00:00:00.000Z'), to: new Date(0), conjunction: 'or', not: false },
        ]);
    });

    test.each([
        ['local', new Date(2024, 0, 15)],
        ['UTC', new Date('2024-01-15T00:00:00.000Z')],
        ['America/New_York', new Date('2024-01-15T05:00:00.000Z')],
    ])('converts a date string in %s', (timezone: string, expected: Date): void => {
        expect(Planner.prepare([basic('born', '=', '2024-01-15')], types, timezone)).toEqual([basic('born', '=', expected)]);
    });

    test('converts inside a nested group', (): void => {
        const nested: Constraint = { type: 'nested', constraints: [basic('active', '=', 'true')], conjunction: 'and', not: true };

        expect(Planner.prepare([nested], types, 'UTC')).toEqual([{ ...nested, constraints: [basic('active', '=', true)] }]);
    });

    test('keeps the value given for a JSON path, which has no declared type, and compares it loosely', (): void => {
        expect(Planner.prepare([basic('tags->count', '=', '18')], types, 'UTC')).toEqual([basic('tags->count', '=', '18')]);
        expect(Planner.prepare([basic('missing->count', '=', '18')], types, 'UTC')).toEqual([basic('missing->count', '=', '18')]);
    });

    test('keeps the value given for an undeclared column, and compares it by kind', (): void => {
        expect(Planner.prepare([basic('missing', '=', '18')], types, 'UTC')).toEqual([{ ...basic('missing', '=', '18'), kinds: true }]);
    });

    test('marks every comparison on a JSON column to compare by kind', (): void => {
        const constraints: Constraint[] = [
            basic('tags', '<', '18'),
            basic('tags', '===', '18'),
            { type: 'in', column: 'tags', values: ['1', 2], conjunction: 'and', not: true },
            { type: 'between', column: 'tags', from: '1', to: 2, conjunction: 'or', not: false },
        ];

        expect(Planner.prepare(constraints, types, 'UTC')).toEqual(constraints.map((constraint: Constraint): Constraint => ({ ...constraint, kinds: true } as Constraint)));
    });

    test('leaves a comparison on a declared column of another type unmarked', (): void => {
        expect(Planner.prepare([basic('name', '=', 18), basic('age', '===', '18')], types, 'UTC')).toEqual([basic('name', '=', 18), basic('age', '===', '18')]);
    });

    test('keeps a value that fails to convert as given, and off the index', (): void => {
        const prepared: Constraint[] = Planner.prepare([basic('age', '<', '1.5')], types, 'UTC');

        expect(prepared).toEqual([basic('age', '<', '1.5')]);
        expect(Planner.plan(prepared, [], users)).toMatchObject({ source: 'scan', residual: prepared });
    });

    test('puts a converted value on the index', (): void => {
        expect(Planner.plan(Planner.prepare([basic('age', '<', '18')], types, 'UTC'), [], users).range).toEqual(IDBKeyRange.upperBound(18, true));
    });

    test('leaves constraints that carry no comparable value alone', (): void => {
        const constraints: Constraint[] = [
            { type: 'null', column: 'age', conjunction: 'and', not: false },
            { type: 'column', column: 'age', operator: '=', other: 'score', conjunction: 'and', not: false },
            { type: 'part', column: 'born', part: 'year', operator: '=', value: 2024, timezone: 'UTC', conjunction: 'and', not: false },
            { type: 'time', column: 'born', operator: '=', value: '09:30:00', timezone: 'UTC', conjunction: 'and', not: false },
            { type: 'json-contains', column: 'tags', value: '1', conjunction: 'and', not: false },
            { type: 'json-length', column: 'tags', operator: '=', value: 1, conjunction: 'and', not: false },
        ];

        expect(Planner.prepare(constraints, types, 'UTC')).toEqual(constraints);
    });
});
