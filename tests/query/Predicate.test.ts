import { describe, expect, test } from 'vitest';
import { Predicate } from '../../src/query/Predicate';
import type { Conjunction, Constraint, Operator } from '../../src/query/types';

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
            nested([{ type: 'part', column: 'at', part: 'year', value: 2026, conjunction: 'and', not: false }], true),
        ];

        expect(matches(constraints, { at: 'never' })).toEqual(false);
        expect(matches(constraints, { at: new Date(2025, 0, 1) })).toEqual(true);
    });

    test('negating a group leaves the time of a value that holds no date unknown', (): void => {
        const constraints: Constraint[] = [
            nested([{ type: 'time', column: 'at', operator: '=', value: '09:30:00', conjunction: 'and', not: false }], true),
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
