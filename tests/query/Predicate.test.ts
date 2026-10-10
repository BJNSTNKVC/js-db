import { afterEach, describe, expect, test, vi } from 'vitest';
import { Predicate } from '../../src/query/Predicate';
import type { Conjunction, Constraint, DatePart, Operator } from '../../src/query/types';

/**
 * Build a basic constraint.
 */
function basic(column: string, operator: Operator, value: unknown, conjunction: Conjunction = 'and', not: boolean = false): Constraint {
    return {
        type: 'basic',
        column,
        operator,
        value,
        conjunction,
        not,
    };
}

/**
 * Build a nested group of constraints.
 */
function nested(constraints: Constraint[], not: boolean = false, conjunction: Conjunction = 'and'): Constraint {
    return {
        type: 'nested',
        constraints,
        conjunction,
        not,
    };
}

/**
 * Test a record against the given constraints.
 */
function matches(constraints: Constraint[], record: Record<string, unknown>): boolean {
    return Predicate.compile(constraints)(record);
}

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

    test.each([
        [null],
        [undefined],
    ])('%s in the list leaves in and not in unknown unless the value is found', (absent: null | undefined): void => {
        const within: Constraint[] = [{ type: 'in', column: 'role', values: ['admin', absent], conjunction: 'and', not: false }];
        const outside: Constraint[] = [{ type: 'in', column: 'role', values: ['admin', absent], conjunction: 'and', not: true }];

        expect(matches(within, { role: 'admin' })).toEqual(true);
        expect(matches(outside, { role: 'admin' })).toEqual(false);
        expect(matches(within, { role: 'guest' })).toEqual(false);
        expect(matches(outside, { role: 'guest' })).toEqual(false);
    });

    test.each([
        [null, 10, 20, 5],
        [1, null, 0, 5],
        [undefined, 10, 20, 5],
    ] as [unknown, unknown, number, number][])('a between from %s to %s is false for %s and unknown for %s', (from: unknown, to: unknown, outside: number, inside: number): void => {
        const within: Constraint[] = [{ type: 'between', column: 'age', from, to, conjunction: 'and', not: false }];
        const beyond: Constraint[] = [{ type: 'between', column: 'age', from, to, conjunction: 'and', not: true }];

        expect(matches(within, { age: outside })).toEqual(false);
        expect(matches(beyond, { age: outside })).toEqual(true);
        expect(matches(within, { age: inside })).toEqual(false);
        expect(matches(beyond, { age: inside })).toEqual(false);
    });

    test('a between with two null bounds is unknown', (): void => {
        expect(matches([{ type: 'between', column: 'age', from: null, to: null, conjunction: 'and', not: false }], { age: 5 })).toEqual(false);
        expect(matches([{ type: 'between', column: 'age', from: null, to: null, conjunction: 'and', not: true }], { age: 5 })).toEqual(false);
    });

    test.each([
        [25],
        [true],
        [new Date(2026, 0, 1)],
        [{ name: 'John' }],
    ])('%o satisfies neither like nor not like, even negated', (held: unknown): void => {
        expect(matches([basic('value', 'like', '%')], { value: held })).toEqual(false);
        expect(matches([basic('value', 'not like', '%')], { value: held })).toEqual(false);
        expect(matches([basic('value', 'like', '%', 'and', true)], { value: held })).toEqual(false);
        expect(matches([nested([basic('value', 'not like', '%')], true)], { value: held })).toEqual(false);
    });

    test('a column comparison by like is unknown when the held column is not a string', (): void => {
        const constraints: Constraint[] = [{ type: 'column', column: 'a', operator: 'not like', other: 'b', conjunction: 'and', not: false }];

        expect(matches(constraints, { a: 35, b: '2%' })).toEqual(false);
        expect(matches(constraints, { a: '35', b: '2%' })).toEqual(true);
    });

    test.each(
        (['=', '==', '===', '!=', '<>', '!==', '<', '>=', 'like', 'not like'] as Operator[]).flatMap(
            (operator: Operator): [Operator, null | undefined][] => [[operator, null], [operator, undefined]],
        ),
    )('comparing by %s against %s is unknown, even negated', (operator: Operator, absent: null | undefined): void => {
        expect(matches([basic('value', operator, absent)], { value: 'John' })).toEqual(false);
        expect(matches([basic('value', operator, absent, 'and', true)], { value: 'John' })).toEqual(false);
        expect(matches([nested([basic('value', operator, absent)], true)], { value: 'John' })).toEqual(false);
    });

    test('a missing column behaves the same as an explicit null', (): void => {
        expect(matches([basic('value', '!=', 7, 'and', false)], {})).toEqual(false);
    });

    test('the null constraint is the only way to match a null', (): void => {
        expect(matches([{ type: 'null', column: 'value', conjunction: 'and', not: false }], { value: null })).toEqual(true);
    });

    test('negating a group leaves a null comparison unknown', (): void => {
        expect(matches([nested([basic('age', '>', 26)], true)], { age: null })).toEqual(false);
        expect(matches([nested([basic('age', '>', 26)], true)], {})).toEqual(false);
        expect(matches([nested([basic('age', '>', 26)], true)], { age: 20 })).toEqual(true);
    });

    test('negating a group leaves a null column comparison unknown', (): void => {
        const constraints: Constraint[] = [
            nested([{ type: 'column', column: 'a', operator: '>', other: 'b', conjunction: 'and', not: false }], true),
        ];

        expect(matches(constraints, { a: 1, b: null })).toEqual(false);
        expect(matches(constraints, { a: 1, b: 2 })).toEqual(true);
    });

    test('negating a group leaves the date part of a value that holds no date unknown', (): void => {
        const constraints: Constraint[] = [
            nested([{ type: 'part', column: 'at', part: 'year', operator: '=', value: 2026, timezone: 'local', conjunction: 'and', not: false }], true),
        ];

        expect(matches(constraints, { at: 'never' })).toEqual(false);
        expect(matches(constraints, { at: new Date(2025, 0, 1) })).toEqual(true);
    });

    test('negating a group leaves the time of a value that holds no date unknown', (): void => {
        const constraints: Constraint[] = [
            nested([{ type: 'time', column: 'at', operator: '=', value: '09:30:00', timezone: 'local', conjunction: 'and', not: false }], true),
        ];

        expect(matches(constraints, { at: 'never' })).toEqual(false);
        expect(matches(constraints, { at: new Date(2026, 0, 1, 18, 45) })).toEqual(true);
    });

    test('unknown and false is false, so its negation is true', (): void => {
        const constraints: Constraint[] = [nested([basic('age', '>', 26), basic('role', '=', 'admin')], true)];

        expect(matches(constraints, { age: null, role: 'member' })).toEqual(true);
        expect(matches(constraints, { age: null, role: 'admin' })).toEqual(false);
    });

    test('unknown or true is true, so its negation is false', (): void => {
        const group: Constraint[] = [basic('age', '>', 26), basic('role', '=', 'admin', 'or')];

        expect(matches([nested(group)], { age: null, role: 'admin' })).toEqual(true);
        expect(matches([nested(group, true)], { age: null, role: 'admin' })).toEqual(false);
    });

    test('unknown or false is unknown, so neither it nor its negation matches', (): void => {
        const group: Constraint[] = [basic('age', '>', 26), basic('role', '=', 'admin', 'or')];

        expect(matches([nested(group)], { age: null, role: 'member' })).toEqual(false);
        expect(matches([nested(group, true)], { age: null, role: 'member' })).toEqual(false);
    });

    test('a null constraint inside a negated group is never unknown', (): void => {
        const constraints: Constraint[] = [nested([{ type: 'null', column: 'age', conjunction: 'and', not: false }], true)];

        expect(matches(constraints, { age: null })).toEqual(false);
        expect(matches(constraints, { age: 30 })).toEqual(true);
    });

    test('a not null constraint inside a negated group is never unknown', (): void => {
        const constraints: Constraint[] = [nested([{ type: 'null', column: 'age', conjunction: 'and', not: true }], true)];

        expect(matches(constraints, { age: null })).toEqual(true);
        expect(matches(constraints, { age: 30 })).toEqual(false);
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

    test('keeps unknown unknown through a double negation', (): void => {
        const constraints: Constraint[] = [nested([nested([basic('age', '>', 26)], true)], true)];

        expect(matches(constraints, { age: null })).toEqual(false);
        expect(matches(constraints, { age: 30 })).toEqual(true);
        expect(matches(constraints, { age: 20 })).toEqual(false);
    });

    test('excludes a record whose null makes a negated disjunction unknown', (): void => {
        const constraints: Constraint[] = [nested([basic('age', '>', 26), basic('score', '>', 26, 'or')], true)];

        expect(matches(constraints, { age: null, score: 10 })).toEqual(false);
        expect(matches(constraints, { age: null, score: 30 })).toEqual(false);
        expect(matches(constraints, { age: 20, score: 10 })).toEqual(true);
    });

    test('lets a true branch outside a group rescue an unknown one', (): void => {
        const constraints: Constraint[] = [nested([basic('age', '>', 26)], true), basic('role', '=', 'admin', 'or')];

        expect(matches(constraints, { age: null, role: 'admin' })).toEqual(true);
        expect(matches(constraints, { age: null, role: 'member' })).toEqual(false);
    });

    test('matches every record against an empty group', (): void => {
        const constraints: Constraint[] = [
            { type: 'nested', conjunction: 'and', not: false, constraints: [] },
        ];

        expect(matches(constraints, { a: 1 })).toEqual(true);
    });
});

describe('Predicate like patterns cannot be made to backtrack', (): void => {
    /**
     * Time a single like comparison in milliseconds.
     */
    function elapsed(pattern: string, subject: string): number {
        const started: number = performance.now();

        matches([basic('body', 'like', pattern)], { body: subject });

        return performance.now() - started;
    }

    test('stays fast for a run of wildcards that cannot match', (): void => {
        // The regular expression this replaced compiled these into .*.*.*.*.* and took 17 seconds.
        expect(elapsed('%%%%%z', 'a'.repeat(200))).toBeLessThan(1000);
    });

    test('stays fast for wildcards separated by single character matches', (): void => {
        // Collapsing a run of wildcards alone would not have saved this shape.
        expect(elapsed('%_%_%_%_%_z', 'a'.repeat(200))).toBeLessThan(1000);
    });

    test('a run of wildcards matches what a single one matches', (): void => {
        expect(matches([basic('body', 'like', '%%%world')], { body: 'hello world' })).toEqual(true);
        expect(matches([basic('body', 'like', '%%%world')], { body: 'hello there' })).toEqual(false);
    });
});

describe('Predicate like matching', (): void => {
        /**
     * Determine whether a subject matches a pattern.
     */
    function like(pattern: string, subject: string): boolean {
        return matches([basic('body', 'like', pattern)], { body: subject });
    }

    test.each([
        ['a.c', 'a.c', true],
        ['a.c', 'abc', false],
        ['.*', 'anything', false],
        ['(a|b)', 'a', false],
        ['[a-z]', 'a', false],
        ['a{1,2}', 'aa', false],
        ['a+', 'aa', false],
        ['a$', 'a', false],
    ] as [string, string, boolean][])('treats %s as a literal against %s', (pattern: string, subject: string, expected: boolean): void => {
        expect(like(pattern, subject)).toEqual(expected);
    });

    test('anchors at both ends', (): void => {
        expect(like('world', 'hello world')).toEqual(false);
        expect(like('%world', 'hello world')).toEqual(true);
        expect(like('hello%', 'hello world')).toEqual(true);
    });

    test('matches an underscore against exactly one character', (): void => {
        expect(like('a_c', 'abc')).toEqual(true);
        expect(like('a_c', 'ac')).toEqual(false);
        expect(like('a_c', 'abbc')).toEqual(false);
    });

    test('ignores case on both sides', (): void => {
        expect(like('HELLO%', 'hello world')).toEqual(true);
        expect(like('%WORLD', 'HELLO WORLD')).toEqual(true);
    });

    test('matches a wildcard across a newline', (): void => {
        expect(like('%world', 'hello\nworld')).toEqual(true);
        expect(like('a_c', 'a\nc')).toEqual(true);
    });

    test('matches an empty subject only against wildcards', (): void => {
        expect(like('%', '')).toEqual(true);
        expect(like('%%%', '')).toEqual(true);
        expect(like('_', '')).toEqual(false);
        expect(like('', '')).toEqual(true);
        expect(like('', 'a')).toEqual(false);
    });

    test('matches a wildcard between literals', (): void => {
        expect(like('h%d', 'hello world')).toEqual(true);
        expect(like('h%z', 'hello world')).toEqual(false);
    });
});

describe('Predicate JSON paths', (): void => {
    /**
     * Build a null constraint.
     */
    function isNull(column: string, not: boolean = false): Constraint {
        return { type: 'null', column, conjunction: 'and', not };
    }

    const record: Record<string, unknown> = {
        settings: { theme: 'dark', rank: 3, layout: { sidebar: { width: 240 } }, tags: ['a', 'b'], note: null },
        label   : 'dark',
    };

    test('reads one level into a column', (): void => {
        expect(matches([basic('settings->theme', '=', 'dark')], record)).toEqual(true);
        expect(matches([basic('settings->theme', '=', 'light')], record)).toEqual(false);
        expect(matches([basic('settings->rank', '>', 2)], record)).toEqual(true);
    });

    test('reads several levels into a column', (): void => {
        expect(matches([basic('settings->layout->sidebar->width', '=', 240)], record)).toEqual(true);
        expect(matches([basic('settings->layout->sidebar->width', '<', 240)], record)).toEqual(false);
    });

    test('reads a missing step as null', (): void => {
        expect(matches([isNull('settings->layout->header->height')], record)).toEqual(true);
        expect(matches([isNull('settings->layout->header->height', true)], record)).toEqual(false);
        expect(matches([basic('settings->layout->header->height', '=', 1)], record)).toEqual(false);
        expect(matches([basic('settings->layout->header->height', '=', 1, 'and', true)], record)).toEqual(false);
    });

    test('reads a path into a column that is absent or null as null', (): void => {
        expect(matches([isNull('missing->theme')], record)).toEqual(true);
        expect(matches([isNull('settings->note->text')], record)).toEqual(true);
    });

    test('never steps into a value that is not a plain object', (): void => {
        expect(matches([isNull('settings->tags->0')], record)).toEqual(true);
        expect(matches([isNull('settings->tags->length')], record)).toEqual(true);
        expect(matches([isNull('label->length')], record)).toEqual(true);
        expect(matches([isNull('settings->rank->toFixed')], record)).toEqual(true);
    });

    test.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('never resolves %s to the prototype', (segment: string): void => {
        expect(matches([isNull(`settings->${segment}`, true)], record)).toEqual(false);
        expect(matches([isNull(segment, true)], record)).toEqual(false);
        expect(matches([basic(`settings->${segment}->name`, '=', 'Object')], record)).toEqual(false);
    });

    test('reads a __proto__ key that parsing made an own property as the data it holds', (): void => {
        const parsed: Record<string, unknown> = JSON.parse('{ "settings": { "__proto__": { "admin": true } } }');

        expect(matches([basic('settings->__proto__->admin', '=', true)], parsed)).toEqual(true);
        expect(matches([basic('settings->admin', '=', true)], parsed)).toEqual(false);
    });

    test('compares a path against another column', (): void => {
        const compared: (column: string, other: string) => Constraint = (column: string, other: string): Constraint => {
            return { type: 'column', column, operator: '=', other, conjunction: 'and', not: false };
        };

        expect(matches([compared('settings->theme', 'label')], record)).toEqual(true);
        expect(matches([compared('label', 'settings->theme')], record)).toEqual(true);
        expect(matches([compared('label', 'settings->missing')], record)).toEqual(false);
    });
});

describe('Predicate JSON contains', (): void => {
    /**
     * Build a JSON contains constraint.
     */
    function contains(column: string, value: unknown, not: boolean = false): Constraint {
        return { type: 'json-contains', column, value, conjunction: 'and', not };
    }

    const record: Record<string, unknown> = { tags: ['php', 'js', 3, null], settings: { roles: ['admin'] }, name: 'php', empty: [] };

    test('matches a scalar the array holds', (): void => {
        expect(matches([contains('tags', 'php')], record)).toEqual(true);
        expect(matches([contains('tags', 3)], record)).toEqual(true);
        expect(matches([contains('tags', 'go')], record)).toEqual(false);
    });

    test('compares strictly', (): void => {
        expect(matches([contains('tags', '3')], record)).toEqual(false);
    });

    test('matches an array of values only when the array holds every one', (): void => {
        expect(matches([contains('tags', ['php', 'js'])], record)).toEqual(true);
        expect(matches([contains('tags', ['php', 'go'])], record)).toEqual(false);
        expect(matches([contains('tags', [])], record)).toEqual(true);
    });

    test('reads the array through a path', (): void => {
        expect(matches([contains('settings->roles', 'admin')], record)).toEqual(true);
        expect(matches([contains('settings->roles', 'owner')], record)).toEqual(false);
    });

    test('negates', (): void => {
        expect(matches([contains('tags', 'go', true)], record)).toEqual(true);
        expect(matches([contains('tags', 'php', true)], record)).toEqual(false);
        expect(matches([contains('tags', ['php', 'go'], true)], record)).toEqual(true);
        expect(matches([contains('empty', 'php', true)], record)).toEqual(true);
    });

    test('never finds an object, which would need structural equality', (): void => {
        expect(matches([contains('items', { id: 1 })], { items: [{ id: 1 }] })).toEqual(false);
    });

    test.each([
        ['a string', 'name'],
        ['an object', 'settings'],
        ['a missing value', 'missing'],
    ])('treats %s as unknown, satisfying neither contains nor its negation', (_label: string, column: string): void => {
        expect(matches([contains(column, 'php')], record)).toEqual(false);
        expect(matches([contains(column, 'php', true)], record)).toEqual(false);
    });
});

describe('Predicate JSON length', (): void => {
    /**
     * Build a JSON length constraint.
     */
    function length(column: string, operator: Operator, value: number, not: boolean = false): Constraint {
        return { type: 'json-length', column, operator, value, conjunction: 'and', not };
    }

    const record: Record<string, unknown> = { tags: ['a', 'b', 'c'], settings: { roles: [] }, name: 'abc' };

    test.each([
        ['=', 3, true],
        ['=', 2, false],
        ['==', 3, true],
        ['===', 3, true],
        ['!=', 3, false],
        ['<>', 2, true],
        ['!==', 2, true],
        ['<', 4, true],
        ['<', 3, false],
        ['<=', 3, true],
        ['>', 2, true],
        ['>', 3, false],
        ['>=', 3, true],
        ['>=', 4, false],
    ] as [Operator, number, boolean][])('compares the length with %s %s', (operator: Operator, value: number, expected: boolean): void => {
        expect(matches([length('tags', operator, value)], record)).toEqual(expected);
    });

    test('reads the array through a path', (): void => {
        expect(matches([length('settings->roles', '=', 0)], record)).toEqual(true);
    });

    test('negates', (): void => {
        expect(matches([length('tags', '=', 3, true)], record)).toEqual(false);
        expect(matches([length('tags', '=', 2, true)], record)).toEqual(true);
    });

    test.each([
        ['a string', 'name'],
        ['an object', 'settings'],
        ['a missing value', 'missing'],
    ])('treats %s as unknown, satisfying neither the comparison nor its negation', (_label: string, column: string): void => {
        expect(matches([length(column, '>=', 0)], record)).toEqual(false);
        expect(matches([length(column, '>=', 0, true)], record)).toEqual(false);
    });

    test('treats a comparison against null as unknown', (): void => {
        expect(matches([length('tags', '=', null as unknown as number)], record)).toEqual(false);
        expect(matches([length('tags', '=', null as unknown as number, true)], record)).toEqual(false);
    });
});

describe('Predicate comparing arrays and objects', (): void => {
    /**
     * Test a value against a basic constraint and against its negation.
     */
    function both(held: unknown, operator: Operator, given: unknown): [boolean, boolean] {
        return [matches([basic('value', operator, given)], { value: held }), matches([basic('value', operator, given, 'and', true)], { value: held })];
    }

    /**
     * Build a where in constraint.
     */
    function within(values: unknown[], not: boolean = false): Constraint {
        return { type: 'in', column: 'value', values, conjunction: 'and', not };
    }

    /**
     * Build a between constraint.
     */
    function between(from: unknown, to: unknown, not: boolean = false): Constraint {
        return { type: 'between', column: 'value', from, to, conjunction: 'and', not };
    }

    test.each([
        [['x'], 'x'],
        [['x', 'z'], 'x,z'],
        [[9], 9],
        [[9], '9'],
        [[], ''],
        [{ a: 1 }, '[object Object]'],
        [{}, '[object Object]'],
        [[true], true],
        [[new Date(1)], new Date(1)],
    ])('never finds %o equal to the scalar %o, in either order', (structure: unknown, scalar: unknown): void => {
        for (const operator of ['=', '==', '==='] as Operator[]) {
            expect(both(structure, operator, scalar)).toEqual([false, true]);
            expect(both(scalar, operator, structure)).toEqual([false, true]);
        }

        for (const operator of ['!=', '<>', '!=='] as Operator[]) {
            expect(both(structure, operator, scalar)).toEqual([true, false]);
            expect(both(scalar, operator, structure)).toEqual([true, false]);
        }
    });

    test.each([
        [[9], [9]],
        [[], []],
        [{}, {}],
        [{ a: 1, b: [2] }, { b: [2], a: 1 }],
        [[[1, [2]], 'y'], [[1, [2]], 'y']],
        [[true, { a: null }], [true, { a: null }]],
        [[new Date(1)], [new Date(1)]],
    ])('finds %o equal to %o by content', (held: unknown, given: unknown): void => {
        for (const operator of ['=', '==', '==='] as Operator[]) {
            expect(both(held, operator, given)).toEqual([true, false]);
        }

        for (const operator of ['!=', '<>', '!=='] as Operator[]) {
            expect(both(held, operator, given)).toEqual([false, true]);
        }
    });

    test.each([
        [[1], ['1']],
        [[9], [9, 1]],
        [[1, 2], [2, 1]],
        [[], {}],
        [['a', 'x'], { a: 'x' }],
        [{ a: 1 }, { a: '1' }],
        [{ a: 1 }, { a: 1, b: undefined }],
        [[true], [1]],
    ])('finds %o and %o different, by kind at every depth', (held: unknown, given: unknown): void => {
        expect(both(held, '=', given)).toEqual([false, true]);
        expect(both(held, '==', given)).toEqual([false, true]);
        expect(both(held, '!=', given)).toEqual([true, false]);
    });

    test.each([
        [[9], '<', [10], true],
        [[10], '>', [9], true],
        [[9], '<', [9, 1], true],
        [[], '<', [0], true],
        [[9], '<=', [9], true],
        [[9], '>=', [9], true],
        [[9, 1], '>=', [10], false],
        [['b'], '>', ['a', 'z'], true],
        [[1], '<', ['0'], true],
        [[new Date(5)], '>', [new Date(1)], true],
        [[[1]], '>', ['z'], true],
    ] as [unknown[], Operator, unknown[], boolean][])('orders %j %s %j as IndexedDB orders keys', (held: unknown[], operator: Operator, given: unknown[], expected: boolean): void => {
        expect(both(held, operator, given)).toEqual([expected, !expected]);
    });

    test.each([
        [['x'], 'x'],
        [['a'], 'z'],
        [[9], 9],
        [[], ''],
        [[], 1e9],
        [[new Date(1)], new Date(0)],
        [[0], new Date(9)],
    ] as [unknown[], unknown][])('ranks the array %j above the scalar %j, as IndexedDB and MySQL rank kinds', (array: unknown[], scalar: unknown): void => {
        expect(both(array, '>', scalar)).toEqual([true, false]);
        expect(both(array, '>=', scalar)).toEqual([true, false]);
        expect(both(array, '<', scalar)).toEqual([false, true]);
        expect(both(scalar, '<', array)).toEqual([true, false]);
        expect(both(scalar, '>=', array)).toEqual([false, true]);
    });

    test.each([
        [{ a: 1 }, 'z'],
        [{ a: 1 }, 9],
        [{ a: 1 }, { a: 1 }],
        [{ a: 1 }, [1]],
        [[true], [false]],
        [[true], 'z'],
        [[1, { a: 1 }], [2]],
        [[9], true],
        [[9], NaN],
    ])('treats ordering %o against %o as unknown, satisfying neither a comparison nor its negation, in either order', (first: unknown, second: unknown): void => {
        for (const operator of ['<', '>', '<=', '>='] as Operator[]) {
            expect(both(first, operator, second)).toEqual([false, false]);
            expect(both(second, operator, first)).toEqual([false, false]);
            expect(matches([nested([basic('value', operator, second)], true)], { value: first })).toEqual(false);
        }
    });

    test('finds an array or an object in a where in list only by content', (): void => {
        expect(matches([within(['x'])], { value: ['x'] })).toEqual(false);
        expect(matches([within(['x'], true)], { value: ['x'] })).toEqual(true);
        expect(matches([within(['x,z'])], { value: ['x', 'z'] })).toEqual(false);
        expect(matches([within(['[object Object]'])], { value: { a: 1 } })).toEqual(false);
        expect(matches([within([['x'], 'y'])], { value: ['x'] })).toEqual(true);
        expect(matches([within([['x'], 'y'], true)], { value: ['x'] })).toEqual(false);
        expect(matches([within([{ b: 2, a: 1 }])], { value: { a: 1, b: 2 } })).toEqual(true);
        expect(matches([within([['x']])], { value: 'x' })).toEqual(false);
        expect(matches([within([['x']], true)], { value: 'x' })).toEqual(true);
    });

    test('leaves a where in that finds no array unknown when the list holds null', (): void => {
        expect(matches([within(['x', null])], { value: ['x'] })).toEqual(false);
        expect(matches([within(['x', null], true)], { value: ['x'] })).toEqual(false);
    });

    test('bounds an array between two arrays as IndexedDB orders keys', (): void => {
        expect(matches([between([1], [10])], { value: [5] })).toEqual(true);
        expect(matches([between([1], [10])], { value: [10, 0] })).toEqual(false);
        expect(matches([between([1], [10], true)], { value: [10, 0] })).toEqual(true);
        expect(matches([between([1], [10], true)], { value: [5] })).toEqual(false);
    });

    test('bounds an array against scalars by kind, arrays above every scalar', (): void => {
        expect(matches([between('a', 'z')], { value: ['m'] })).toEqual(false);
        expect(matches([between('a', 'z', true)], { value: ['m'] })).toEqual(true);
        expect(matches([between('a', ['z'])], { value: ['m'] })).toEqual(true);
        expect(matches([between(['a'], ['z'])], { value: 'm' })).toEqual(false);
        expect(matches([between(['a'], ['z'], true)], { value: 'm' })).toEqual(true);
    });

    test.each([
        [{ a: 1 }, 'a', 'z'],
        [['m'], 'a', { z: 1 }],
        [{ a: 1 }, { a: 0 }, { a: 2 }],
        [[true], [false], [true, true]],
    ])('treats %o between %o and %o as unknown, satisfying neither between nor not between', (held: unknown, from: unknown, to: unknown): void => {
        expect(matches([between(from, to)], { value: held })).toEqual(false);
        expect(matches([between(from, to, true)], { value: held })).toEqual(false);
    });

    test('is false rather than unknown between bounds where one comparison is false', (): void => {
        expect(matches([between(5, [9])], { value: 1 })).toEqual(false);
        expect(matches([between(5, [9], true)], { value: 1 })).toEqual(true);
        expect(matches([between([1], 'z')], { value: [0] })).toEqual(false);
        expect(matches([between([1], 'z', true)], { value: [0] })).toEqual(true);
    });

    test('compares two columns holding arrays or objects by content', (): void => {
        const column: (operator: Operator, not?: boolean) => Constraint = (operator: Operator, not: boolean = false): Constraint => ({ type: 'column', column: 'a', operator, other: 'b', conjunction: 'and', not });

        expect(matches([column('=')], { a: [1, 'x'], b: [1, 'x'] })).toEqual(true);
        expect(matches([column('=')], { a: { x: [1] }, b: { x: [1] } })).toEqual(true);
        expect(matches([column('=')], { a: ['x'], b: 'x' })).toEqual(false);
        expect(matches([column('!=')], { a: ['x'], b: 'x' })).toEqual(true);
        expect(matches([column('<')], { a: [9], b: [10] })).toEqual(true);
        expect(matches([column('<')], { a: [9], b: 10 })).toEqual(false);
        expect(matches([column('<', true)], { a: [9], b: 10 })).toEqual(true);
        expect(matches([column('<')], { a: { x: 1 }, b: 10 })).toEqual(false);
        expect(matches([column('<', true)], { a: { x: 1 }, b: 10 })).toEqual(false);
    });

    test('compares a value a path reaches by content', (): void => {
        expect(matches([basic('doc->list', '=', [1, 2])], { doc: { list: [1, 2] } })).toEqual(true);
        expect(matches([basic('doc->list', '=', '1,2')], { doc: { list: [1, 2] } })).toEqual(false);
    });

    test('keeps the loose rules between scalars', (): void => {
        expect(both(30, '=', '30')).toEqual([true, false]);
        expect(both(30, '===', '30')).toEqual([false, true]);
        expect(both('10', '<', 9)).toEqual([false, true]);
        expect(matches([within(['30'])], { value: 30 })).toEqual(true);
    });

    test('keeps the rules for a date, which is not a plain object', (): void => {
        expect(both(new Date(1000), '=', 1000)).toEqual([true, false]);
        expect(both(new Date(1000), '<', 2000)).toEqual([true, false]);
    });

    test('keeps the rules for binary values, which are not plain objects', (): void => {
        expect(both(new Uint8Array([1, 2]), '=', '1,2')).toEqual([true, false]);
        expect(both(new Uint8Array([1]), '=', new Uint8Array([1]))).toEqual([false, true]);
    });

    test('treats a comparison of an array against null as unknown', (): void => {
        expect(both(['x'], '=', null)).toEqual([false, false]);
        expect(both(['x'], '!=', undefined)).toEqual([false, false]);
        expect(both(null, '=', ['x'])).toEqual([false, false]);
    });
});

describe('Predicate comparing by kind', (): void => {
    const KINDS: unknown[] = [1e9, '0', { a: 1 }, [9], false, new Date(0), new Uint8Array([0])];

    /**
     * Test a value by kind against a basic constraint and its negation.
     */
    function both(held: unknown, operator: Operator, given: unknown): [boolean, boolean] {
        const constraint: Constraint = { ...basic('value', operator, given), kinds: true } as Constraint;

        return [matches([constraint], { value: held }), matches([{ ...constraint, not: true }], { value: held })];
    }

    /**
     * Build a where in constraint that compares by kind.
     */
    function within(values: unknown[], not: boolean = false): Constraint {
        return { type: 'in', column: 'value', values, conjunction: 'and', not, kinds: true } as Constraint;
    }

    /**
     * Build a between constraint that compares by kind.
     */
    function between(from: unknown, to: unknown, not: boolean = false): Constraint {
        return { type: 'between', column: 'value', from, to, conjunction: 'and', not, kinds: true } as Constraint;
    }

    test.each([
        [5, '5'],
        [1, true],
        [0, false],
        ['true', true],
        [5, new Date(5)],
        ['1970-01-01T00:00:00.005Z', new Date(5)],
        [5n, '5'],
        [['x'], 'x'],
        [{ a: 1 }, '[object Object]'],
        [[], {}],
    ])('never finds %o equal to %o, in either order', (first: unknown, second: unknown): void => {
        for (const operator of ['=', '==', '==='] as Operator[]) {
            expect(both(first, operator, second)).toEqual([false, true]);
            expect(both(second, operator, first)).toEqual([false, true]);
        }

        for (const operator of ['!=', '<>', '!=='] as Operator[]) {
            expect(both(first, operator, second)).toEqual([true, false]);
            expect(both(second, operator, first)).toEqual([true, false]);
        }
    });

    test.each([
        [5, 5],
        ['5', '5'],
        [true, true],
        [new Date(5), new Date(5)],
        [[9], [9]],
        [{ a: 1, b: [2] }, { b: [2], a: 1 }],
    ])('finds %o equal to %o of the same kind', (held: unknown, given: unknown): void => {
        for (const operator of ['=', '==', '==='] as Operator[]) {
            expect(both(held, operator, given)).toEqual([true, false]);
        }

        for (const operator of ['!=', '<>', '!=='] as Operator[]) {
            expect(both(held, operator, given)).toEqual([false, true]);
        }
    });

    test('ranks numbers, strings, objects, arrays, booleans, dates and binary data in that order', (): void => {
        for (const [lower, below] of KINDS.entries()) {
            for (const above of KINDS.slice(lower + 1)) {
                expect(both(below, '<', above)).toEqual([true, false]);
                expect(both(below, '<=', above)).toEqual([true, false]);
                expect(both(below, '>', above)).toEqual([false, true]);
                expect(both(above, '>', below)).toEqual([true, false]);
                expect(both(above, '>=', below)).toEqual([true, false]);
                expect(both(above, '<', below)).toEqual([false, true]);
            }
        }
    });

    test.each([
        [1, 2],
        [5n, 6],
        ['10', '9'],
        [false, true],
        [new Date(1), new Date(2)],
        [[9], [10]],
        [[9], [9, 1]],
    ])('orders %o below %o of the same kind', (lower: unknown, upper: unknown): void => {
        expect(both(lower, '<', upper)).toEqual([true, false]);
        expect(both(upper, '>', lower)).toEqual([true, false]);
        expect(both(lower, '>=', upper)).toEqual([false, true]);
    });

    test.each([
        [{ a: 1 }, { a: 2 }],
        [[true], [false]],
        [[1, { a: 1 }], [2]],
    ])('leaves ordering %o against %o of the same kind unknown, as before', (first: unknown, second: unknown): void => {
        for (const operator of ['<', '>', '<=', '>='] as Operator[]) {
            expect(both(first, operator, second)).toEqual([false, false]);
            expect(both(second, operator, first)).toEqual([false, false]);
        }
    });

    test('finds a value in a where in list only among values of its kind', (): void => {
        expect(matches([within(['5', true, new Date(5)])], { value: 5 })).toEqual(false);
        expect(matches([within(['5', true, new Date(5)], true)], { value: 5 })).toEqual(true);
        expect(matches([within([1])], { value: true })).toEqual(false);
        expect(matches([within([1], true)], { value: true })).toEqual(true);
        expect(matches([within(['x', 5])], { value: 5 })).toEqual(true);
        expect(matches([within([new Date(5)])], { value: new Date(5) })).toEqual(true);
    });

    test('leaves a where in that finds nothing unknown when the list holds null', (): void => {
        expect(matches([within(['5', null])], { value: 5 })).toEqual(false);
        expect(matches([within(['5', null], true)], { value: 5 })).toEqual(false);
    });

    test('bounds a value between values of other kinds by the order of kinds', (): void => {
        expect(matches([between(1, 'z')], { value: 5 })).toEqual(true);
        expect(matches([between(1, 'z')], { value: 'a' })).toEqual(true);
        expect(matches([between(1, 'z')], { value: true })).toEqual(false);
        expect(matches([between(1, 'z', true)], { value: true })).toEqual(true);
        expect(matches([between('1', '5')], { value: 5 })).toEqual(false);
        expect(matches([between('1', '5', true)], { value: 5 })).toEqual(true);
        expect(matches([between(false, true)], { value: 1 })).toEqual(false);
        expect(matches([between(new Date(0), new Date(9))], { value: new Date(5) })).toEqual(true);
    });

    test('leaves a value between bounds of its own kind it cannot order unknown', (): void => {
        expect(matches([between({ a: 0 }, { a: 2 })], { value: { a: 1 } })).toEqual(false);
        expect(matches([between({ a: 0 }, { a: 2 }, true)], { value: { a: 1 } })).toEqual(false);
    });

    test('treats a comparison against null as unknown', (): void => {
        expect(both(5, '=', null)).toEqual([false, false]);
        expect(both(5, '<', undefined)).toEqual([false, false]);
        expect(both(null, '!=', 5)).toEqual([false, false]);
    });

    test('matches like against a string alone', (): void => {
        expect(both('5', 'like', '5')).toEqual([true, false]);
        expect(both(5, 'like', '5')).toEqual([false, false]);
    });

    test('leaves a constraint not marked to compare by kind loose', (): void => {
        expect(matches([basic('value', '=', '5')], { value: 5 })).toEqual(true);
        expect(matches([{ type: 'in', column: 'value', values: [1], conjunction: 'and', not: false }], { value: true })).toEqual(true);
    });
});


describe('Predicate date parts in the constraint\'s timezone', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

    /**
     * Build a constraint on one date part of a column, read in the given timezone.
     */
    function part(which: DatePart, value: number, timezone: string): Constraint {
        return { type: 'part', column: 'on', part: which, operator: '=', value, timezone, conjunction: 'and', not: false };
    }

    /**
     * Build a constraint on the time of day of a column, read in the given timezone.
     */
    function time(value: string, timezone: string): Constraint {
        return { type: 'time', column: 'on', operator: '=', value, timezone, conjunction: 'and', not: false };
    }

    afterEach((): void => {
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    describe.each(['America/New_York', 'Asia/Tokyo', 'America/Santiago'])('with the process in %s', (process: string): void => {
        test('reads the local day a held string names on a local connection', (): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('year', 2024, 'local'), part('month', 1, 'local'), part('day', 1, 'local')], { on: '2024-01-01' })).toEqual(true);
            expect(matches([part('day', 15, 'local')], { on: '2024-01-15' })).toEqual(true);
            expect(matches([time('00:00:00', 'local')], { on: '2024-01-15' })).toEqual(true);
        });

        test('reads a held string with a time as the moment it names on a local connection', (): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('day', 15, 'local'), time('10:30:00', 'local')], { on: '2024-01-15T10:30' })).toEqual(true);
            expect(matches([part('year', 2023, 'local')], { on: '2024-01-01T00:00:00Z' })).toEqual(process !== 'Asia/Tokyo');
        });

        test.each(['UTC', 'America/New_York'])('reads the day and time a held string names in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('year', 2024, timezone), part('month', 1, timezone), part('day', 15, timezone)], { on: '2024-01-15' })).toEqual(true);
            expect(matches([time('00:00:00', timezone)], { on: '2024-01-15' })).toEqual(true);
            expect(matches([part('day', 15, timezone), time('10:30:00', timezone)], { on: '2024-01-15 10:30' })).toEqual(true);
        });

        test('reads an instant by the day and time it falls on in the timezone, whatever the process', (): void => {
            vi.stubEnv('TZ', process);

            const evening: Date = new Date('2024-01-15T02:00:00Z');

            expect(matches([part('day', 15, 'UTC'), time('02:00:00', 'UTC')], { on: evening })).toEqual(true);
            expect(matches([part('day', 14, 'America/New_York'), time('21:00:00', 'America/New_York')], { on: evening })).toEqual(true);
            expect(matches([part('year', 2023, 'UTC')], { on: '2024-01-01T00:00:00Z' })).toEqual(false);
            expect(matches([part('year', 2023, 'America/New_York')], { on: '2024-01-01T00:00:00Z' })).toEqual(true);
        });

        test.each(['local', 'UTC', 'America/New_York'])('reads a day the calendar does not have as no date in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('month', 3, timezone)], { on: '2024-02-30' })).toEqual(false);
            expect(matches([nested([part('month', 3, timezone)], true)], { on: '2024-02-30' })).toEqual(false);
        });

        test('reads a day whose midnight Santiago skips from its first moment there', (): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('day', 8, 'America/Santiago'), time('01:00:00', 'America/Santiago')], { on: '2024-09-08' })).toEqual(true);
        });

        test('reads both moments of an hour Santiago repeats as the same time of day', (): void => {
            vi.stubEnv('TZ', process);

            expect(matches([part('day', 6, 'America/Santiago'), time('23:30:00', 'America/Santiago')], { on: new Date('2024-04-07T02:30:00Z') })).toEqual(true);
            expect(matches([part('day', 6, 'America/Santiago'), time('23:30:00', 'America/Santiago')], { on: new Date('2024-04-07T03:30:00Z') })).toEqual(true);
        });
    });

    test('reads a day whose local midnight is skipped from its first moment', (): void => {
        vi.stubEnv('TZ', 'America/Santiago');

        expect(matches([part('day', 8, 'local'), time('01:00:00', 'local')], { on: '2024-09-08' })).toEqual(true);
    });
});
