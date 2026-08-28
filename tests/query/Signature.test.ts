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
        // The encoding is private, so what matters is that it repeats and that it separates.
        expect(Signature.of({ name: 'John', age: 30 })).toEqual(Signature.of({ name: 'John', age: 30 }));
        expect(Signature.of({ name: 'John', age: 30 })).not.toEqual(Signature.of({ name: 'John', age: 31 }));
        expect(Signature.of({ name: 'John', age: 30 })).not.toEqual(Signature.of({ name: 'John' }));
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
        expect(Signature.ofValues(['core', 30])).toEqual(Signature.ofValues(['core', 30]));
        expect(Signature.ofValues(['core', 30])).not.toEqual(Signature.ofValues(['core', 31]));
        expect(Signature.ofValues(['core', 30])).not.toEqual(Signature.ofValues(['core']));
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

describe('Signature boundaries cannot be forged', (): void => {
    const SEPARATOR: string = String.fromCharCode(1);

    test('keeps two value lists apart when one holds the separator', (): void => {
        // Joined on the separator alone, both of these encoded to the same string and their groups
        // merged into one.
        const first: string = Signature.ofValues([`a${SEPARATOR}s:b`, 'c']);
        const second: string = Signature.ofValues(['a', `b${SEPARATOR}s:c`]);

        expect(first).not.toEqual(second);
    });

    test('keeps two records apart when one holds the separator', (): void => {
        const first: string = Signature.of({ a: `p${SEPARATOR}b=q`, b: 'r' });
        const second: string = Signature.of({ a: 'p', b: `q${SEPARATOR}b=r` });

        expect(first).not.toEqual(second);
    });

    test('keeps a value apart from the same text split across two values', (): void => {
        expect(Signature.ofValues([`a${SEPARATOR}s:b`])).not.toEqual(Signature.ofValues(['a', 'b']));
    });

    test('keeps a record apart from one whose column name absorbs the value', (): void => {
        expect(Signature.of({ 'a': 'b=c' })).not.toEqual(Signature.of({ 'a=b': 'c' }));
    });

    test('still repeats for equal input holding the separator', (): void => {
        const value: string = `x${SEPARATOR}y`;

        expect(Signature.ofValues([value])).toEqual(Signature.ofValues([value]));
    });
});
