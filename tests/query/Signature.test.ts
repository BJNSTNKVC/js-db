import { describe, expect, test } from 'vitest';
import { Signature } from '../../src/query/Signature';

describe('Signature.value', (): void => {
    test.each([
        ['a string', 'John', 's:John'],
        ['a number', 7, 'n:7'],
        ['a boolean', true, 'b:true'],
        ['a bigint', 1n, 'b:1'],
    ] as [string, unknown, string][])('encodes %s with its type', (_name: string, value: unknown, expected: string): void => {
        expect(Signature.value(value)).toEqual(expected);
    });

    test('encodes undefined and null differently', (): void => {
        expect(Signature.value(undefined)).toEqual('?');
        expect(Signature.value(null)).toEqual('~');
        expect(Signature.value(undefined)).not.toEqual(Signature.value(null));
    });

    test('encodes a date by its time value', (): void => {
        expect(Signature.value(new Date('2026-08-28T00:00:00.000Z'))).toEqual('d:1787875200000');
    });

    test('encodes two dates holding the same instant identically', (): void => {
        expect(Signature.value(new Date(1000))).toEqual(Signature.value(new Date(1000)));
    });

    test('encodes a structure', (): void => {
        expect(Signature.value({ a: 1 })).toEqual('o:{"a":1}');
        expect(Signature.value([1, 2])).toEqual('o:[1,2]');
    });

    test('keeps a number and its string form apart', (): void => {
        expect(Signature.value(1)).not.toEqual(Signature.value('1'));
    });

    test('keeps a boolean and its string form apart', (): void => {
        expect(Signature.value(true)).not.toEqual(Signature.value('true'));
    });
});

describe('Signature.of', (): void => {
    test('identifies a record by its columns', (): void => {
        expect(Signature.of({ name: 'John', age: 30 })).toEqual('age=n:30\u0001name=s:John');
    });

    test('ignores the order the columns were written in', (): void => {
        expect(Signature.of({ name: 'John', age: 30 })).toEqual(Signature.of({ age: 30, name: 'John' }));
    });

    test('keeps a column holding undefined apart from one that is absent', (): void => {
        // JSON.stringify drops undefined, which would wrongly collapse these two into one.
        expect(Signature.of({ a: 1, b: undefined })).not.toEqual(Signature.of({ a: 1 }));
    });

    test('keeps a column holding null apart from one holding undefined', (): void => {
        expect(Signature.of({ a: null })).not.toEqual(Signature.of({ a: undefined }));
    });

    test('identifies an empty record', (): void => {
        expect(Signature.of({})).toEqual('');
    });
});

describe('Signature.ofValues', (): void => {
    test('identifies an ordered list', (): void => {
        expect(Signature.ofValues(['core', 30])).toEqual('s:core\u0001n:30');
    });

    test('respects the order of the list', (): void => {
        expect(Signature.ofValues([1, 2])).not.toEqual(Signature.ofValues([2, 1]));
    });

    test('keeps undefined and null apart', (): void => {
        expect(Signature.ofValues([undefined])).not.toEqual(Signature.ofValues([null]));
    });

    test('identifies an empty list', (): void => {
        expect(Signature.ofValues([])).toEqual('');
    });
});
