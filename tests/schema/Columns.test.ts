import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Enforcer } from '../../src/schema/Enforcer';
import { CheckConstraintViolationException, NotNullConstraintViolationException, SchemaException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { ColumnSchema, Enumerable, TableSchema } from '../../src/schema/types';

interface Item {
    id: number;
    price: number;
    weight: number;
    status: string;
    tier: string | null;
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
            table.enum('status', ['draft', 'live', 'archived']).default('draft');
            table.enum('tier', ['free', 'paid']).nullable();
        });
    }
}

let connection: Connection;
let sequence: number = 0;

/**
 * Begin a query against the items table.
 */
function items(): Builder<Item> {
    return connection.table<Item>('items');
}

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
        await items().insert({ price: 1999, status: 'live' });

        expect(await items().value<number>('price')).toEqual(1999);
    });

    test('refuses a fractional value, since it would be silently lost', async (): Promise<void> => {
        await expect(items().insert({ price: 19.99, status: 'live' })).rejects.toThrow(/whole number of its smallest unit/);
    });

    test('accepts a numeric string', async (): Promise<void> => {
        await items().insert({ price: '1999' as unknown as number, status: 'live' });

        expect(await items().value<number>('price')).toEqual(1999);
    });

    test('rounds a fractional value when the connection is loose', (): void => {
        expect(Enforcer.coerce(19.99, 'decimal', false)).toEqual(20);
    });

    test('refuses an uncoercible value', (): void => {
        expect((): unknown => Enforcer.coerce('abc', 'decimal', true)).toThrow(TypeError);
    });

    test('yields null for an uncoercible value when loose', (): void => {
        expect(Enforcer.coerce('abc', 'decimal', false)).toBeNull();
    });

    test('passes null through', (): void => {
        expect(Enforcer.coerce(null, 'decimal', true)).toBeNull();
    });

    test('orders exactly, being an integer at rest', async (): Promise<void> => {
        await items().insert([
            { price: 1000, status: 'live' },
            { price: 999, status: 'live' },
            { price: 1001, status: 'live' },
        ]);

        expect(await items().orderBy('price').pluck<number>('price')).toEqual([999, 1000, 1001]);
    });

    test('sums exactly', async (): Promise<void> => {
        await items().insert([
            { price: 1999, status: 'live' },
            { price: 1, status: 'live' },
        ]);

        expect(await items().sum('price')).toEqual(2000);
    });
});

describe('Blueprint.enum', (): void => {
    test('records the values it accepts', async (): Promise<void> => {
        const status: ColumnSchema = (await connection.getColumns('items')).find((column: ColumnSchema): boolean => column.name === 'status') as ColumnSchema;

        expect(status.type).toEqual('enum');
        expect(status.values).toEqual(['draft', 'live', 'archived']);
    });

    test('accepts a declared value', async (): Promise<void> => {
        await items().insert({ price: 1, status: 'archived' });

        expect(await items().value<string>('status')).toEqual('archived');
    });

    test('rejects a value it does not accept', async (): Promise<void> => {
        await expect(items().insert({ price: 1, status: 'pending' })).rejects.toThrow(
            new CheckConstraintViolationException('items', 'status', 'pending', ['draft', 'live', 'archived']),
        );
    });

    test('rejects a value it does not accept on update', async (): Promise<void> => {
        await items().insert({ price: 1, status: 'live' });

        await expect(items().update({ status: 'pending' })).rejects.toBeInstanceOf(CheckConstraintViolationException);
    });

    test('applies a declared default', async (): Promise<void> => {
        await items().insert({ price: 1 });

        expect(await items().value<string>('status')).toEqual('draft');
    });

    test('allows null on a nullable enumerated column', async (): Promise<void> => {
        await items().insert({ price: 1, status: 'live' });

        expect(await items().value<string>('tier')).toBeNull();
    });

    test('rejects an unacceptable value even on a nullable column', async (): Promise<void> => {
        await expect(items().insert({ price: 1, status: 'live', tier: 'gold' })).rejects.toBeInstanceOf(CheckConstraintViolationException);
    });

    test('coerces a value to a string before checking it', (): void => {
        expect(Enforcer.coerce(7, 'enum', true)).toEqual('7');
    });

    test('refuses to declare an enumerated column over no values', (): void => {
        const blueprint: Blueprint = new Blueprint('items');

        expect((): unknown => blueprint.enum('status', [])).toThrow(
            new SchemaException('Column [status] of table [items] is enumerated over no values, so nothing could ever be written to it.'),
        );
    });
});

describe('Enumerated columns on a loose connection', (): void => {
    /**
     * Build a table schema holding a single enumerated column.
     */
    function schema(nullable: boolean): TableSchema {
        return {
            table     : 'items',
            key       : 'id',
            increments: true,
            timestamps: false,
            columns   : [
                {
                    name      : 'status',
                    type      : 'enum',
                    nullable,
                    default   : undefined,
                    hasDefault: false,
                    primary   : false,
                    increments: false,
                    places    : null,
                    values    : ['draft', 'live'],
                },
            ],
            indexes   : [],
        };
    }

    test('writes null in place of a value it does not accept', (): void => {
        expect(Enforcer.insertable({ status: 'pending' }, schema(true), false, new Date())).toEqual({ status: null });
    });

    test('still reports a non nullable column it had to empty', (): void => {
        expect((): unknown => Enforcer.insertable({ status: 'pending' }, schema(false), true, new Date())).toThrow(
            CheckConstraintViolationException,
        );
    });

    test('writes null for a non nullable column when loose', (): void => {
        expect(Enforcer.insertable({ status: 'pending' }, schema(false), false, new Date())).toEqual({ status: null });
    });

    test('leaves an accepted value alone', (): void => {
        expect(Enforcer.insertable({ status: 'live' }, schema(false), true, new Date())).toEqual({ status: 'live' });
    });

    test('reports a null in a non nullable enumerated column', (): void => {
        expect((): unknown => Enforcer.insertable({ status: null }, schema(false), true, new Date())).toThrow(
            NotNullConstraintViolationException,
        );
    });
});

describe('Blueprint.enum over an enum or a constant object', (): void => {
    /**
     * Get the values a declared enumerated column accepts.
     */
    function accepted(values: Enumerable): string[] | null {
        const blueprint: Blueprint = new Blueprint('items');

        blueprint.enum('status', values);

        return blueprint.toSchema().columns[0]!.values;
    }

    test('takes the values of a string enum, not its keys', (): void => {
        enum Status {
            Draft = 'draft',
            Live  = 'live',
        }

        expect(accepted(Status)).toEqual(['draft', 'live']);
    });

    test('takes the values of a constant object', (): void => {
        const Status: { readonly Draft: "draft"; readonly Live: "live" } = { Draft: 'draft', Live: 'live' } as const;

        expect(accepted(Status)).toEqual(['draft', 'live']);
    });

    test('still takes a plain array', (): void => {
        expect(accepted(['draft', 'live'])).toEqual(['draft', 'live']);
    });

    test('takes a readonly array', (): void => {
        const values: readonly ["draft", "live"] = ['draft', 'live'] as const;

        expect(accepted(values)).toEqual(['draft', 'live']);
    });

    test('collapses two members sharing a value', (): void => {
        enum Status {
            Draft   = 'draft',
            Pending = 'draft',
        }

        expect(accepted(Status)).toEqual(['draft']);
    });

    test('refuses a numeric enum, whose reverse mapping has no value worth storing', (): void => {
        enum Status {
            Draft,
            Live,
        }

        expect((): unknown => accepted(Status)).toThrow(
            new SchemaException('Column [status] of table [items] is enumerated over a numeric enum, which has no string form to store. Give the enum string values, or use integer() instead.'),
        );
    });

    test('refuses a heterogeneous enum', (): void => {
        enum Status {
            Draft = 'draft',
            Live  = 1,
        }

        expect((): unknown => accepted(Status)).toThrow(SchemaException);
    });

    test('refuses an empty constant object', (): void => {
        expect((): unknown => accepted({})).toThrow(
            new SchemaException('Column [status] of table [items] is enumerated over no values, so nothing could ever be written to it.'),
        );
    });

    test('enforces the values a string enum declared', async (): Promise<void> => {
        enum Role {
            Admin  = 'admin',
            Member = 'member',
        }

        class CreatePeopleTable extends Migration {
            /**
             * Run the migration.
             */
            override async up(): Promise<void> {
                await Schema.create('people', (table: Blueprint): void => {
                    table.id();
                    table.enum('role', Role).default(Role.Member);
                });
            }
        }

        const people: Connection = new Connection('app', { database: `roles-${++sequence}`, migrations: [CreatePeopleTable] });

        await people.migrate();

        await people.table('people').insert({});

        expect(await people.table('people').value<string>('role')).toEqual('member');

        await expect(people.table('people').insert({ role: 'owner' })).rejects.toBeInstanceOf(CheckConstraintViolationException);

        people.disconnect();
    });
});
