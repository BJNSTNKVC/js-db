import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Coercer } from '../../src/schema/Coercer';
import type { Builder } from '../../src/query/Builder';
import type { ColumnSchema } from '../../src/schema/types';

interface Item {
    id: number;
    price: number;
    weight: number;
}

class CreateItemsTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('items', (table: Blueprint): void => {
            table.id();
            table.decimal('price');
            table.decimal('weight', 3).default(0);
        });
    }
}

let connection: Connection;
let sequence: number = 0;

/**
 * Begin a query against the items table.
 */
const items = (): Builder<Item> => connection.table<Item>('items');

beforeEach(async (): Promise<void> => {
    connection?.disconnect();

    connection = new Connection('app', { database: `columns-${++sequence}`, migrations: [CreateItemsTable] });

    await connection.migrate();
});

describe('Blueprint.decimal', (): void => {
    test('declares a scaled integer column, defaulting to two places', async (): Promise<void> => {
        const price: ColumnSchema = (await connection.getColumns('items')).find((column: ColumnSchema): boolean => column.name === 'price') as ColumnSchema;

        expect(price.type).toEqual('decimal');
        expect(price.places).toEqual(2);
    });

    test('honours an explicit scale', async (): Promise<void> => {
        const weight: ColumnSchema = (await connection.getColumns('items')).find((column: ColumnSchema): boolean => column.name === 'weight') as ColumnSchema;

        expect(weight.places).toEqual(3);
    });

    test('stores a whole number of the smallest unit', async (): Promise<void> => {
        await items().insert({ price: 1999 });

        expect(await items().value<number>('price')).toEqual(1999);
    });

    test('refuses a fractional value, since it would be silently lost', async (): Promise<void> => {
        await expect(items().insert({ price: 19.99 })).rejects.toThrow(/whole number of its smallest unit/);
    });

    test('accepts a numeric string', async (): Promise<void> => {
        await items().insert({ price: '1999' as unknown as number });

        expect(await items().value<number>('price')).toEqual(1999);
    });

    test('rounds a fractional value when the connection is loose', (): void => {
        expect(Coercer.coerce(19.99, 'decimal', false)).toEqual(20);
    });

    test('refuses an uncoercible value', (): void => {
        expect((): unknown => Coercer.coerce('abc', 'decimal', true)).toThrow(TypeError);
    });

    test('yields null for an uncoercible value when loose', (): void => {
        expect(Coercer.coerce('abc', 'decimal', false)).toBeNull();
    });

    test('passes null through', (): void => {
        expect(Coercer.coerce(null, 'decimal', true)).toBeNull();
    });

    test('orders exactly, being an integer at rest', async (): Promise<void> => {
        await items().insert([
            { price: 1000 },
            { price: 999 },
            { price: 1001 },
        ]);

        expect(await items().orderBy('price').pluck<number>('price')).toEqual([999, 1000, 1001]);
    });

    test('sums exactly', async (): Promise<void> => {
        await items().insert([
            { price: 1999 },
            { price: 1 },
        ]);

        expect(await items().sum('price')).toEqual(2000);
    });
});
