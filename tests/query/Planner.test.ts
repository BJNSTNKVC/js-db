import { describe, expect, test } from 'vitest';
import { Planner } from '../../src/query/Planner';
import type { Conjunction, Constraint, Operator, Order, Plan } from '../../src/query/types';
import type { ColumnSchema, TableSchema } from '../../src/schema/types';

/**
 * Build a column schema with the given overrides.
 */
const column = (name: string, overrides: Partial<ColumnSchema> = {}): ColumnSchema => ({
    name,
    type      : 'integer',
    nullable  : false,
    default   : undefined,
    hasDefault: false,
    primary   : false,
    increments: false,
    places    : null,
    ...overrides,
});

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
    ],
    indexes   : [
        { name: 'users_email_unique', columns: ['email'], unique: true, multiEntry: false },
        { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
        { name: 'users_age_index', columns: ['age'], unique: false, multiEntry: false },
        { name: 'users_name_age_index', columns: ['name', 'age'], unique: false, multiEntry: false },
    ],
};

/**
 * Build a basic constraint.
 */
const basic = (col: string, operator: Operator, value: unknown, conjunction: Conjunction = 'and', not: boolean = false): Constraint => ({
    type: 'basic',
    column: col,
    operator,
    value,
    conjunction,
    not,
});

/**
 * Build an order.
 */
const order = (col: string, direction: 'asc' | 'desc' = 'asc'): Order => ({ column: col, direction });

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
