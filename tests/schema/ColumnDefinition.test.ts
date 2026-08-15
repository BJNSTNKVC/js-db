import { describe, expect, test } from 'vitest';
import { ColumnDefinition } from '../../src/schema/ColumnDefinition';
import type { ColumnSchema, RequestedIndex } from '../../src/schema/types';

describe('ColumnDefinition', (): void => {
    test('describes a plain column', (): void => {
        const definition: ColumnDefinition = new ColumnDefinition('name', 'string');

        expect(definition.toSchema()).toEqual({
            name      : 'name',
            type      : 'string',
            nullable  : false,
            default   : undefined,
            hasDefault: false,
            primary   : false,
            increments: false,
        } satisfies ColumnSchema);
    });

    test('marks the column nullable', (): void => {
        expect(new ColumnDefinition('age', 'integer').nullable().toSchema().nullable).toEqual(true);
    });

    test('accepts an explicit nullable argument', (): void => {
        expect(new ColumnDefinition('age', 'integer').nullable(false).toSchema().nullable).toEqual(false);
        expect(new ColumnDefinition('age', 'integer').nullable(true).toSchema().nullable).toEqual(true);
    });

    test('records a default and distinguishes it from an absent one', (): void => {
        const schema: ColumnSchema = new ColumnDefinition('meta', 'json').default(null).toSchema();

        expect(schema.hasDefault).toEqual(true);
        expect(schema.default).toBeNull();
    });

    test('marks the column primary', (): void => {
        expect(new ColumnDefinition('id', 'integer').primary().toSchema().primary).toEqual(true);
    });

    test('marks the column auto incrementing', (): void => {
        expect(new ColumnDefinition('id', 'integer').increments().toSchema().increments).toEqual(true);
    });

    test('returns itself from every modifier', (): void => {
        const definition: ColumnDefinition = new ColumnDefinition('id', 'integer');

        expect(definition.nullable()).toBe(definition);
        expect(definition.default(1)).toBe(definition);
        expect(definition.primary()).toBe(definition);
        expect(definition.increments()).toBe(definition);
        expect(definition.index()).toBe(definition);
        expect(definition.unique()).toBe(definition);
        expect(definition.multiEntry()).toBe(definition);
    });

    test('requests no index by default', (): void => {
        expect(new ColumnDefinition('name', 'string').requested()).toEqual([]);
    });

    test('requests a plain index', (): void => {
        expect(new ColumnDefinition('name', 'string').index().requested()).toEqual([
            { name: null, unique: false, multiEntry: false } satisfies RequestedIndex,
        ]);
    });

    test('requests a named plain index', (): void => {
        expect(new ColumnDefinition('name', 'string').index('by_name').requested()).toEqual([
            { name: 'by_name', unique: false, multiEntry: false } satisfies RequestedIndex,
        ]);
    });

    test('requests a unique index', (): void => {
        expect(new ColumnDefinition('email', 'string').unique().requested()).toEqual([
            { name: null, unique: true, multiEntry: false } satisfies RequestedIndex,
        ]);
    });

    test('requests a named unique index', (): void => {
        expect(new ColumnDefinition('email', 'string').unique('by_email').requested()).toEqual([
            { name: 'by_email', unique: true, multiEntry: false } satisfies RequestedIndex,
        ]);
    });

    test('requests both a plain and a unique index', (): void => {
        expect(new ColumnDefinition('email', 'string').index().unique().requested()).toEqual([
            { name: null, unique: false, multiEntry: false },
            { name: null, unique: true, multiEntry: false },
        ]);
    });

    test('requests an implicit multi entry index when marked without one', (): void => {
        expect(new ColumnDefinition('tags', 'json').multiEntry().requested()).toEqual([
            { name: null, unique: false, multiEntry: true } satisfies RequestedIndex,
        ]);
    });

    test('marks an explicit index multi entry', (): void => {
        expect(new ColumnDefinition('tags', 'json').index('by_tags').multiEntry().requested()).toEqual([
            { name: 'by_tags', unique: false, multiEntry: true } satisfies RequestedIndex,
        ]);
    });

    test('marks every requested index multi entry', (): void => {
        expect(new ColumnDefinition('tags', 'json').index().unique().multiEntry().requested()).toEqual([
            { name: null, unique: false, multiEntry: true },
            { name: null, unique: true, multiEntry: true },
        ]);
    });

    test('exposes its name and type', (): void => {
        const definition: ColumnDefinition = new ColumnDefinition('age', 'integer');

        expect(definition.name).toEqual('age');
        expect(definition.type).toEqual('integer');
    });
});
