import { describe, expect, test } from 'vitest';
import { Comparator } from '../../src/query/Comparator';
import type { Order } from '../../src/query/types';

/**
 * Sort values by the comparator in the given direction.
 */
function sorted(values: unknown[], direction: 'asc' | 'desc' = 'asc'): unknown[] {
    const orders: Order[] = [{ column: 'value', direction }];

    return Comparator.sort(values.map((value: unknown): { value: unknown } => ({ value })), orders, (row: { value: unknown }): unknown => row.value)
        .map((row: { value: unknown }): unknown => row.value);
}

describe('Comparator.compare over values of one kind', (): void => {
    test.each([
        [1, 2],
        [-0.5, 0],
        ['a', 'b'],
        ['B', 'a'],
        [new Date(1), new Date(2)],
        [false, true],
    ])('orders %o before %o', (lower: unknown, higher: unknown): void => {
        expect(Comparator.compare(lower, higher)).toBeLessThan(0);
        expect(Comparator.compare(higher, lower)).toBeGreaterThan(0);
    });

    test.each([
        [1, 1],
        ['a', 'a'],
        [new Date(5), new Date(5)],
        [true, true],
    ])('ties %o with %o', (first: unknown, second: unknown): void => {
        expect(Comparator.compare(first, second)).toEqual(0);
    });

    test('puts null and a missing value before everything else, tied with each other', (): void => {
        expect(Comparator.compare(null, undefined)).toEqual(0);
        expect(Comparator.compare(null, -Infinity)).toBeLessThan(0);
        expect(Comparator.compare({ a: 1 }, undefined)).toBeGreaterThan(0);
    });
});

describe('Comparator.compare over arrays', (): void => {
    test.each([
        [[9], [10]],
        [[9], [9, 1]],
        [[], [0]],
        [[1, 'a'], [1, 'b']],
        [[[1]], [[1], 0]],
        [['z'], [[0]]],
    ])('orders %j before %j element by element, as IndexedDB orders keys', (lower: unknown[], higher: unknown[]): void => {
        expect(Comparator.compare(lower, higher)).toBeLessThan(0);
        expect(Comparator.compare(higher, lower)).toBeGreaterThan(0);
        expect(indexedDB.cmp(lower, higher)).toEqual(-1);
    });

    test('ties two arrays holding the same keys', (): void => {
        expect(Comparator.compare([9, 'a', new Date(1)], [9, 'a', new Date(1)])).toEqual(0);
    });

    test('orders arrays that are not keys element by element after every key', (): void => {
        expect(Comparator.compare([true], [false])).toBeGreaterThan(0);
        expect(Comparator.compare([1, true], [2])).toBeGreaterThan(0);
        expect(Comparator.compare([{ a: 1 }], ['z'])).toBeGreaterThan(0);
        expect(Comparator.compare([true], [true, false])).toBeLessThan(0);
        expect(Comparator.compare([true, false], [true])).toBeGreaterThan(0);
        expect(Comparator.compare([true, { a: 1 }], [true, { b: 2 }])).toEqual(0);
    });
});

describe('Comparator.compare across kinds', (): void => {
    test('ranks keys of different kinds as IndexedDB does', (): void => {
        const keys: unknown[] = [[0], new Uint8Array([0]), 'a', '', new Date(0), 10, -1, [], Infinity];

        expect(sorted(keys)).toEqual([...keys].sort((a: unknown, b: unknown): number => indexedDB.cmp(a, b)));
        expect(sorted(keys)).toEqual([-1, 10, Infinity, new Date(0), '', 'a', new Uint8Array([0]), [], [0]]);
    });

    test('orders a number before a string, whatever the string reads as', (): void => {
        expect(Comparator.compare(10, '9')).toBeLessThan(0);
        expect(Comparator.compare('', 4)).toBeGreaterThan(0);
    });

    test('orders a number before a date, whatever its time', (): void => {
        expect(Comparator.compare(new Date(0), 5)).toBeGreaterThan(0);
    });

    test('puts every value that is not a key after every key', (): void => {
        const values: unknown[] = [{ a: 1 }, [true], true, [9], 'z', false, 1];

        expect(sorted(values)).toEqual([1, 'z', [9], false, true, [true], { a: 1 }]);
    });

    test('ties objects with each other, whatever they hold, leaving them in the order they came', (): void => {
        expect(Comparator.compare({ b: 2 }, { a: 1 })).toEqual(0);
        expect(sorted([{ b: 2 }, { a: 1 }, {}])).toEqual([{ b: 2 }, { a: 1 }, {}]);
    });

    test('reverses the whole order descending, null and the values that are not keys included', (): void => {
        const values: unknown[] = [{ a: 1 }, null, [true], true, [9], 'z', 1];

        expect(sorted(values, 'desc')).toEqual([{ a: 1 }, [true], true, [9], 'z', 1, null]);
    });

    test('orders a value that is not a key by its kind, such as NaN or an invalid date, after the keys', (): void => {
        expect(Comparator.compare(NaN, 'z')).toBeGreaterThan(0);
        expect(Comparator.compare(new Date(NaN), [9])).toBeGreaterThan(0);
    });
});
