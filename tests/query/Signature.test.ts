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
        const separator: string = String.fromCharCode(1);

        expect(Signature.value({ a: 1 })).toEqual(`o:1${separator}a3${separator}n:1`);
        expect(Signature.value([1, 2])).toEqual(`a:3${separator}n:13${separator}n:2`);
    });

    test('keeps a number and its string form apart', (): void => {
        expect(Signature.value(1)).not.toEqual(Signature.value('1'));
    });

    test('keeps a boolean and its string form apart', (): void => {
        expect(Signature.value(true)).not.toEqual(Signature.value('true'));
    });
});

describe('Signature.value over nested values', (): void => {
    test.each([
        ['an object', { x: 1, y: 2 }, { y: 2, x: 1 }],
        ['an object inside an object', { a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }],
        ['an object inside an array', [{ x: 1, y: 2 }], [{ y: 2, x: 1 }]],
        ['an object holding arrays', { a: [1, 2], b: [3] }, { b: [3], a: [1, 2] }],
        ['objects three levels down', { a: [{ b: { x: 1, y: 2 } }] }, { a: [{ b: { y: 2, x: 1 } }] }],
    ] as [string, unknown, unknown][])('ignores the key order of %s', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value(first)).toEqual(Signature.value(second));
    });

    test.each([
        ['an array', [1, 2], [2, 1]],
        ['an array of objects', [{ a: 1 }, { b: 1 }], [{ b: 1 }, { a: 1 }]],
        ['an array inside an object', { a: [1, 2] }, { a: [2, 1] }],
    ] as [string, unknown, unknown][])('keeps the order of %s', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value(first)).not.toEqual(Signature.value(second));
    });

    test.each([
        ['1 and \'1\'', 1, '1'],
        ['null and undefined', null, undefined],
        ['a date and its ISO string', new Date(0), new Date(0).toISOString()],
        ['true and \'true\'', true, 'true'],
        ['an empty object and an empty array', {}, []],
        ['NaN and null', NaN, null],
        ['Infinity and null', Infinity, null],
        ['a bigint and a number', 1n, 1],
        ['an array and an object keyed by its indexes', [1, 2], { 0: 1, 1: 2 }],
    ] as [string, unknown, unknown][])('keeps %s apart at every depth', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value({ a: first })).not.toEqual(Signature.value({ a: second }));
        expect(Signature.value([first])).not.toEqual(Signature.value([second]));
        expect(Signature.value({ a: [{ b: first }] })).not.toEqual(Signature.value({ a: [{ b: second }] }));
    });

    test('keeps a key holding undefined apart from a missing key', (): void => {
        expect(Signature.value({ a: 1, b: undefined })).not.toEqual(Signature.value({ a: 1 }));
        expect(Signature.value([{ a: 1, b: undefined }])).not.toEqual(Signature.value([{ a: 1 }]));
    });

    test('keeps a hole in an array apart from undefined and null', (): void => {
        const sparse: unknown[] = [1, , 3];

        expect(Signature.value(sparse)).not.toEqual(Signature.value([1, undefined, 3]));
        expect(Signature.value(sparse)).not.toEqual(Signature.value([1, null, 3]));
        expect(Signature.value(sparse)).not.toEqual(Signature.value([1, 3]));
        expect(Signature.value(sparse)).toEqual(Signature.value([1, , 3]));
    });

    test.each([
        ['NaN', NaN, NaN],
        ['-0 and 0', -0, 0],
        ['two dates holding the same instant', new Date(1000), new Date(1000)],
        ['two bigints', 10n, 10n],
    ] as [string, unknown, unknown][])('treats %s as one value at every depth', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value({ a: first })).toEqual(Signature.value({ a: second }));
        expect(Signature.value([first])).toEqual(Signature.value([second]));
    });

    test.each([
        ['numbers', Object(1), Object(2)],
        ['strings', Object('x'), Object('y')],
        ['booleans', Object(true), Object(false)],
        ['bigints', Object(1n), Object(2n)],
    ] as [string, unknown, unknown][])('keeps boxed %s apart by the value they hold at every depth', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value(first)).not.toEqual(Signature.value(second));
        expect(Signature.value({ a: first })).not.toEqual(Signature.value({ a: second }));
        expect(Signature.value({ a: first })).toEqual(Signature.value({ a: Object((first as object).valueOf()) }));
    });

    test.each([
        ['a boxed number and the number', Object(1), 1],
        ['a boxed string and the string', Object('x'), 'x'],
        ['a boxed string and an object keyed by its indexes', Object('x'), { 0: 'x' }],
        ['a boxed number and an empty object', Object(1), {}],
    ] as [string, unknown, unknown][])('keeps %s apart at every depth', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value(first)).not.toEqual(Signature.value(second));
        expect(Signature.value([first])).not.toEqual(Signature.value([second]));
    });

    test('encodes an object reached twice without containing itself', (): void => {
        const shared: Record<string, unknown> = { x: 1 };

        expect(Signature.value({ a: shared, b: [shared] })).toEqual(Signature.value({ b: [{ x: 1 }], a: { x: 1 } }));
    });

    test('refuses a value that contains itself', (): void => {
        const object: Record<string, unknown> = { a: 1 };
        const array: unknown[] = [];

        object['self'] = { inner: object };
        array.push([array]);

        expect((): string => Signature.value(object)).toThrow(TypeError);
        expect((): string => Signature.value(array)).toThrow(TypeError);
        expect((): string => Signature.of({ column: object })).toThrow(TypeError);
    });
});

describe('Signature.value keys', (): void => {
    test.each([
        ['__proto__', JSON.parse('{"__proto__": 1, "a": 2}'), JSON.parse('{"a": 2, "__proto__": 1}')],
        ['constructor', { constructor: 1, a: 2 }, { a: 2, constructor: 1 }],
        ['numeric-looking keys', { '10': 1, '2': 2, 'a': 3 }, { 'a': 3, '2': 2, '10': 1 }],
        ['a fractional key', { '1.5': 1, 'a': 2 }, { 'a': 2, '1.5': 1 }],
        ['keys differing in case', { a: 1, A: 2 }, { A: 2, a: 1 }],
    ] as [string, unknown, unknown][])('sorts %s with the rest', (_name: string, first: unknown, second: unknown): void => {
        expect(Signature.value(first)).toEqual(Signature.value(second));
        expect(Signature.value({ nested: first })).toEqual(Signature.value({ nested: second }));
    });

    test('keeps an own __proto__ key apart from its absence', (): void => {
        expect(Signature.value(JSON.parse('{"__proto__": 1, "a": 2}'))).not.toEqual(Signature.value({ a: 2 }));
    });

    test('keeps keys differing only in case apart', (): void => {
        expect(Signature.value({ a: 1 })).not.toEqual(Signature.value({ A: 1 }));
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

    test('ignores the key order of a column holding an object', (): void => {
        expect(Signature.of({ meta: { x: 1, y: 2 } })).toEqual(Signature.of({ meta: { y: 2, x: 1 } }));
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

    test('ignores the key order of an object in the list', (): void => {
        expect(Signature.ofValues(['core', { x: 1, y: 2 }])).toEqual(Signature.ofValues(['core', { y: 2, x: 1 }]));
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

    test('keeps two nested lists apart when one holds the separator', (): void => {
        expect(Signature.value({ a: [`a${SEPARATOR}s:b`, 'c'] })).not.toEqual(Signature.value({ a: ['a', `b${SEPARATOR}s:c`] }));
        expect(Signature.value([[`a${SEPARATOR}s:b`]])).not.toEqual(Signature.value([['a', 'b']]));
    });

    test('keeps two nested objects apart when a key or a value holds the separator', (): void => {
        expect(Signature.value({ o: { a: `p${SEPARATOR}b=q`, b: 'r' } })).not.toEqual(Signature.value({ o: { a: 'p', b: `q${SEPARATOR}b=r` } }));
        expect(Signature.value({ o: { [`a${SEPARATOR}b`]: 1 } })).not.toEqual(Signature.value({ o: { a: 1, b: 1 } }));
    });

    test('keeps a string apart from the structure its text spells', (): void => {
        const inner: string = Signature.value({ b: 1 });

        expect(Signature.value({ a: inner })).not.toEqual(Signature.value({ a: { b: 1 } }));
        expect(Signature.value([inner.slice(2)])).not.toEqual(Signature.value([{ b: 1 }]));
        expect(Signature.value({ a: 'n:1' })).not.toEqual(Signature.value({ a: 1 }));
        expect(Signature.value({ a: '?' })).not.toEqual(Signature.value({ a: undefined }));
        expect(Signature.value({ a: '~' })).not.toEqual(Signature.value({ a: null }));
    });

    test('keeps a key apart from the pair its text spells', (): void => {
        const pair: string = Signature.value({ a: 'x' }).slice(2);

        expect(Signature.value({ [pair]: undefined })).not.toEqual(Signature.value({ a: 'x' }));
        expect(Signature.value({ o: { [pair]: 'y' } })).not.toEqual(Signature.value({ o: { a: 'x' } }));
    });

    test('keeps an array apart from an object holding the same encoded parts', (): void => {
        expect(Signature.value(['a', 'x'])).not.toEqual(Signature.value({ a: 'x' }));
        expect(Signature.value([])).not.toEqual(Signature.value({}));
    });

    test('keeps a hole apart from a value whose length prefix reads as one', (): void => {
        expect(Signature.value([, 'a'])).not.toEqual(Signature.value(['', 'a']));
    });

    test('still repeats for equal input holding the separator', (): void => {
        const value: string = `x${SEPARATOR}y`;

        expect(Signature.ofValues([value])).toEqual(Signature.ofValues([value]));
    });
});
