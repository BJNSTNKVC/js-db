import { describe, expect, test } from 'vitest';
import { Predicate } from '../../src/query/Predicate';
import type { Conjunction, Constraint, Operator } from '../../src/query/types';

/**
 * Build a basic constraint.
 */
const basic = (column: string, operator: Operator, value: unknown, conjunction: Conjunction = 'and', not: boolean = false): Constraint => ({
    type: 'basic',
    column,
    operator,
    value,
    conjunction,
    not,
});

/**
 * Test a record against the given constraints.
 */
const matches = (constraints: Constraint[], record: Record<string, unknown>): boolean => Predicate.compile(constraints)(record);

describe('Predicate with no constraints', (): void => {
    test('matches every record', (): void => {
        expect(matches([], {})).toEqual(true);
        expect(matches([], { a: 1 })).toEqual(true);
    });
});

describe('Predicate operators', (): void => {
    test.each([
        ['=', 7, 7, true],
        ['=', 7, 8, false],
        ['==', '7', 7, true],
        ['===', '7', 7, false],
        ['===', 7, 7, true],
        ['!=', 7, 8, true],
        ['!=', '7', 7, false],
        ['<>', 7, 8, true],
        ['!==', '7', 7, true],
        ['!==', 7, 7, false],
        ['<', 7, 8, true],
        ['<', 8, 7, false],
        ['>', 8, 7, true],
        ['>', 7, 8, false],
        ['<=', 7, 7, true],
        ['<=', 8, 7, false],
        ['>=', 7, 7, true],
        ['>=', 6, 7, false],
    ] as [Operator, unknown, unknown, boolean][])('applies %s comparing %o to %o', (operator: Operator, held: unknown, given: unknown, expected: boolean): void => {
        expect(matches([basic('value', operator, given)], { value: held })).toEqual(expected);
    });

    test('compares dates by their time value', (): void => {
        const held: Date = new Date('2026-08-27T00:00:00.000Z');
        const same: Date = new Date('2026-08-27T00:00:00.000Z');
        const later: Date = new Date('2026-08-28T00:00:00.000Z');

        expect(matches([basic('at', '=', same)], { at: held })).toEqual(true);
        expect(matches([basic('at', '<', later)], { at: held })).toEqual(true);
        expect(matches([basic('at', '>', later)], { at: held })).toEqual(false);
    });

    test('negates a basic constraint', (): void => {
        expect(matches([basic('value', '=', 7, 'and', true)], { value: 7 })).toEqual(false);
        expect(matches([basic('value', '=', 7, 'and', true)], { value: 8 })).toEqual(true);
    });
});

describe('Predicate like', (): void => {
    test.each([
        ['John%', 'John Doe', true],
        ['John%', 'Johnny', true],
        ['John%', 'Mr John', false],
        ['%Doe', 'John Doe', true],
        ['%Doe', 'Doe John', false],
        ['%ohn%', 'John Doe', true],
        ['%xyz%', 'John Doe', false],
        ['J_hn', 'John', true],
        ['J_hn', 'Jhn', false],
        ['John', 'John', true],
        ['John', 'Johnny', false],
    ] as [string, string, boolean][])('matches pattern %s against %s', (pattern: string, held: string, expected: boolean): void => {
        expect(matches([basic('name', 'like', pattern)], { name: held })).toEqual(expected);
    });

    test('is case insensitive', (): void => {
        expect(matches([basic('name', 'like', 'john%')], { name: 'John Doe' })).toEqual(true);
    });

    test('escapes regular expression metacharacters', (): void => {
        expect(matches([basic('name', 'like', 'a.c')], { name: 'abc' })).toEqual(false);
        expect(matches([basic('name', 'like', 'a.c')], { name: 'a.c' })).toEqual(true);
        expect(matches([basic('name', 'like', 'a+c')], { name: 'a+c' })).toEqual(true);
    });

    test('treats an escaped wildcard as a literal', (): void => {
        expect(matches([basic('name', 'like', '100\\%')], { name: '100%' })).toEqual(true);
        expect(matches([basic('name', 'like', '100\\%')], { name: '100 percent' })).toEqual(false);
    });

    test('treats an escaped underscore as a literal', (): void => {
        expect(matches([basic('name', 'like', 'a\\_c')], { name: 'a_c' })).toEqual(true);
        expect(matches([basic('name', 'like', 'a\\_c')], { name: 'abc' })).toEqual(false);
    });

    test('keeps a trailing backslash literal', (): void => {
        expect(matches([basic('name', 'like', 'a\\')], { name: 'a\\' })).toEqual(true);
    });

    test('applies not like', (): void => {
        expect(matches([basic('name', 'not like', 'John%')], { name: 'John Doe' })).toEqual(false);
        expect(matches([basic('name', 'not like', 'John%')], { name: 'Jane Doe' })).toEqual(true);
    });

    test('does not match a null value', (): void => {
        expect(matches([basic('name', 'like', '%')], { name: null })).toEqual(false);
    });
});

describe('Predicate in', (): void => {
    test('matches a value present in the list', (): void => {
        expect(matches([{ type: 'in', column: 'role', values: ['admin', 'owner'], conjunction: 'and', not: false }], { role: 'owner' })).toEqual(true);
    });

    test('rejects a value absent from the list', (): void => {
        expect(matches([{ type: 'in', column: 'role', values: ['admin', 'owner'], conjunction: 'and', not: false }], { role: 'guest' })).toEqual(false);
    });

    test('rejects every value against an empty list', (): void => {
        expect(matches([{ type: 'in', column: 'role', values: [], conjunction: 'and', not: false }], { role: 'admin' })).toEqual(false);
    });

    test('compares dates by their time value', (): void => {
        const held: Date = new Date('2026-08-27T00:00:00.000Z');
        const same: Date = new Date('2026-08-27T00:00:00.000Z');

        expect(matches([{ type: 'in', column: 'at', values: [same], conjunction: 'and', not: false }], { at: held })).toEqual(true);
    });

    test('applies not in', (): void => {
        expect(matches([{ type: 'in', column: 'role', values: ['admin'], conjunction: 'and', not: true }], { role: 'admin' })).toEqual(false);
        expect(matches([{ type: 'in', column: 'role', values: ['admin'], conjunction: 'and', not: true }], { role: 'guest' })).toEqual(true);
    });
});

describe('Predicate null', (): void => {
    test.each([
        [{ value: null }, true],
        [{ value: undefined }, true],
        [{}, true],
        [{ value: 0 }, false],
        [{ value: '' }, false],
    ] as [Record<string, unknown>, boolean][])('tests %o for null', (record: Record<string, unknown>, expected: boolean): void => {
        expect(matches([{ type: 'null', column: 'value', conjunction: 'and', not: false }], record)).toEqual(expected);
    });

    test.each([
        [{ value: null }, false],
        [{ value: undefined }, false],
        [{}, false],
        [{ value: 0 }, true],
    ] as [Record<string, unknown>, boolean][])('tests %o for not null', (record: Record<string, unknown>, expected: boolean): void => {
        expect(matches([{ type: 'null', column: 'value', conjunction: 'and', not: true }], record)).toEqual(expected);
    });
});

describe('Predicate between', (): void => {
    test.each([
        [5, true],
        [1, true],
        [10, true],
        [0, false],
        [11, false],
    ] as [number, boolean][])('tests %o between 1 and 10', (held: number, expected: boolean): void => {
        expect(matches([{ type: 'between', column: 'age', from: 1, to: 10, conjunction: 'and', not: false }], { age: held })).toEqual(expected);
    });

    test('compares strings', (): void => {
        expect(matches([{ type: 'between', column: 'name', from: 'a', to: 'm', conjunction: 'and', not: false }], { name: 'john' })).toEqual(true);
        expect(matches([{ type: 'between', column: 'name', from: 'a', to: 'm', conjunction: 'and', not: false }], { name: 'zoe' })).toEqual(false);
    });

    test('compares dates by their time value', (): void => {
        const from: Date = new Date('2026-01-01T00:00:00.000Z');
        const to: Date = new Date('2026-12-31T00:00:00.000Z');

        expect(matches([{ type: 'between', column: 'at', from, to, conjunction: 'and', not: false }], { at: new Date('2026-08-27T00:00:00.000Z') })).toEqual(true);
        expect(matches([{ type: 'between', column: 'at', from, to, conjunction: 'and', not: false }], { at: new Date('2025-08-27T00:00:00.000Z') })).toEqual(false);
    });

    test('applies not between', (): void => {
        expect(matches([{ type: 'between', column: 'age', from: 1, to: 10, conjunction: 'and', not: true }], { age: 5 })).toEqual(false);
        expect(matches([{ type: 'between', column: 'age', from: 1, to: 10, conjunction: 'and', not: true }], { age: 20 })).toEqual(true);
    });

    test('does not match a null value', (): void => {
        expect(matches([{ type: 'between', column: 'age', from: 1, to: 10, conjunction: 'and', not: false }], { age: null })).toEqual(false);
    });
});

describe('Predicate conjunctions', (): void => {
    test('requires every and constraint', (): void => {
        const constraints: Constraint[] = [basic('a', '=', 1), basic('b', '=', 2)];

        expect(matches(constraints, { a: 1, b: 2 })).toEqual(true);
        expect(matches(constraints, { a: 1, b: 3 })).toEqual(false);
    });

    test('accepts either or branch', (): void => {
        const constraints: Constraint[] = [basic('a', '=', 1), basic('b', '=', 2, 'or')];

        expect(matches(constraints, { a: 1, b: 9 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 2 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 9 })).toEqual(false);
    });

    test('binds and tighter than or', (): void => {
        const constraints: Constraint[] = [
            basic('a', '=', 1),
            basic('b', '=', 2),
            basic('c', '=', 3, 'or'),
        ];

        expect(matches(constraints, { a: 1, b: 2, c: 9 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 9, c: 3 })).toEqual(true);
        expect(matches(constraints, { a: 1, b: 9, c: 9 })).toEqual(false);
    });

    test('binds and tighter than or across four constraints', (): void => {
        const constraints: Constraint[] = [
            basic('a', '=', 1),
            basic('b', '=', 2),
            basic('c', '=', 3, 'or'),
            basic('d', '=', 4),
        ];

        expect(matches(constraints, { a: 1, b: 2, c: 9, d: 9 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 9, c: 3, d: 4 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 9, c: 3, d: 9 })).toEqual(false);
    });

    test('ignores the conjunction of the first constraint', (): void => {
        expect(matches([basic('a', '=', 1, 'or')], { a: 1 })).toEqual(true);
        expect(matches([basic('a', '=', 1, 'or')], { a: 9 })).toEqual(false);
    });
});

describe('Predicate three valued logic', (): void => {
    test.each([
        ['=', false],
        ['!=', false],
        ['<>', false],
        ['>', false],
        ['<', false],
        ['like', false],
        ['not like', false],
    ] as [Operator, boolean][])('a null value satisfies neither %s nor its negation', (operator: Operator, expected: boolean): void => {
        expect(matches([basic('value', operator, 7)], { value: null })).toEqual(expected);
        expect(matches([basic('value', operator, 7, 'and', true)], { value: null })).toEqual(expected);
    });

    test('a null value satisfies neither in nor not in', (): void => {
        expect(matches([{ type: 'in', column: 'value', values: [7], conjunction: 'and', not: false }], { value: null })).toEqual(false);
        expect(matches([{ type: 'in', column: 'value', values: [7], conjunction: 'and', not: true }], { value: null })).toEqual(false);
    });

    test('a null value satisfies neither between nor not between', (): void => {
        expect(matches([{ type: 'between', column: 'value', from: 1, to: 10, conjunction: 'and', not: false }], { value: null })).toEqual(false);
        expect(matches([{ type: 'between', column: 'value', from: 1, to: 10, conjunction: 'and', not: true }], { value: null })).toEqual(false);
    });

    test('a missing column behaves the same as an explicit null', (): void => {
        expect(matches([basic('value', '!=', 7, 'and', false)], {})).toEqual(false);
    });

    test('the null constraint is the only way to match a null', (): void => {
        expect(matches([{ type: 'null', column: 'value', conjunction: 'and', not: false }], { value: null })).toEqual(true);
    });
});

describe('Predicate nested groups', (): void => {
    test('groups constraints so or does not leak', (): void => {
        const constraints: Constraint[] = [
            basic('active', '=', true),
            {
                type       : 'nested',
                conjunction: 'and',
                not        : false,
                constraints: [basic('role', '=', 'admin'), basic('role', '=', 'owner', 'or')],
            },
        ];

        expect(matches(constraints, { active: true, role: 'owner' })).toEqual(true);
        expect(matches(constraints, { active: false, role: 'owner' })).toEqual(false);
        expect(matches(constraints, { active: true, role: 'guest' })).toEqual(false);
    });

    test('nests two deep', (): void => {
        const constraints: Constraint[] = [
            {
                type       : 'nested',
                conjunction: 'and',
                not        : false,
                constraints: [
                    basic('a', '=', 1),
                    {
                        type       : 'nested',
                        conjunction: 'or',
                        not        : false,
                        constraints: [basic('b', '=', 2), basic('c', '=', 3)],
                    },
                ],
            },
        ];

        expect(matches(constraints, { a: 1, b: 9, c: 9 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 2, c: 3 })).toEqual(true);
        expect(matches(constraints, { a: 9, b: 2, c: 9 })).toEqual(false);
    });

    test('negates a nested group', (): void => {
        const constraints: Constraint[] = [
            {
                type       : 'nested',
                conjunction: 'and',
                not        : true,
                constraints: [basic('role', '=', 'admin')],
            },
        ];

        expect(matches(constraints, { role: 'admin' })).toEqual(false);
        expect(matches(constraints, { role: 'guest' })).toEqual(true);
    });

    test('matches every record against an empty group', (): void => {
        const constraints: Constraint[] = [
            { type: 'nested', conjunction: 'and', not: false, constraints: [] },
        ];

        expect(matches(constraints, { a: 1 })).toEqual(true);
    });
});
