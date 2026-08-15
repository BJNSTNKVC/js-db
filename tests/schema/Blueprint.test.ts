import { describe, expect, test } from 'vitest';
import { Blueprint } from '../../src/schema/Blueprint';
import { SchemaException } from '../../src/exceptions';
import type { BlueprintOperations, TableSchema } from '../../src/schema/types';

/**
 * Build the schema produced by a create-mode blueprint.
 */
const schema = (callback: (table: Blueprint) => void): TableSchema => {
    const blueprint: Blueprint = new Blueprint('users');

    callback(blueprint);

    return blueprint.toSchema();
};

describe('Blueprint column types', (): void => {
    test('declares every column type', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('name');
            table.integer('age');
            table.float('rating');
            table.boolean('active');
            table.date('born_on');
            table.datetime('seen_at');
            table.json('meta');
        });

        expect(table.columns.map((column): string => `${column.name}:${column.type}`)).toEqual([
            'name:string',
            'age:integer',
            'rating:float',
            'active:boolean',
            'born_on:date',
            'seen_at:datetime',
            'meta:json',
        ]);
    });

    test('declares an auto incrementing primary key', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.id();
        });

        expect(table.key).toEqual('id');
        expect(table.increments).toEqual(true);
        expect(table.columns[0]).toMatchObject({ name: 'id', type: 'integer', primary: true, increments: true });
    });

    test('accepts a custom name for the primary key', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.id('uid');
        });

        expect(table.key).toEqual('uid');
    });

    test('declares a uuid primary key that does not increment', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.uuid('id').primary();
        });

        expect(table.key).toEqual('id');
        expect(table.increments).toEqual(false);
        expect(table.columns[0]).toMatchObject({ name: 'id', type: 'string', primary: true });
    });

    test('falls back to an out of line incrementing key when no primary is declared', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('name');
        });

        expect(table.key).toBeNull();
        expect(table.increments).toEqual(true);
    });

    test('declares timestamps as nullable datetime columns', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.timestamps();
        });

        expect(table.timestamps).toEqual(true);
        expect(table.columns).toEqual([
            { name: 'created_at', type: 'datetime', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false },
            { name: 'updated_at', type: 'datetime', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false },
        ]);
    });

    test('does not report timestamps when they were not declared', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('name');
        });

        expect(table.timestamps).toEqual(false);
    });

    test('returns the column definition so modifiers chain', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.integer('age').nullable().default(18);
        });

        expect(table.columns[0]).toMatchObject({ nullable: true, default: 18, hasDefault: true });
    });
});

describe('Blueprint indexes', (): void => {
    test('names a column index after the table and column', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('name').index();
        });

        expect(table.indexes).toEqual([
            { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
        ]);
    });

    test('names a column unique index after the table and column', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('email').unique();
        });

        expect(table.indexes).toEqual([
            { name: 'users_email_unique', columns: ['email'], unique: true, multiEntry: false },
        ]);
    });

    test('honours an explicit index name', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('email').unique('by_email');
        });

        expect(table.indexes[0]?.name).toEqual('by_email');
    });

    test('carries multi entry onto the index', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.json('tags').multiEntry();
        });

        expect(table.indexes).toEqual([
            { name: 'users_tags_index', columns: ['tags'], unique: false, multiEntry: true },
        ]);
    });

    test('declares a compound index from a table level call', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.string('name');
            table.integer('age');
            table.index(['name', 'age']);
        });

        expect(table.indexes).toEqual([
            { name: 'users_name_age_index', columns: ['name', 'age'], unique: false, multiEntry: false },
        ]);
    });

    test('declares a compound unique index from a table level call', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.unique(['name', 'age']);
        });

        expect(table.indexes).toEqual([
            { name: 'users_name_age_unique', columns: ['name', 'age'], unique: true, multiEntry: false },
        ]);
    });

    test('accepts a single column as a string at table level', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.index('name');
        });

        expect(table.indexes[0]?.columns).toEqual(['name']);
    });

    test('honours an explicit name on a table level index', (): void => {
        const table: TableSchema = schema((table: Blueprint): void => {
            table.index(['name'], 'by_name');
        });

        expect(table.indexes[0]?.name).toEqual('by_name');
    });
});

describe('Blueprint validation', (): void => {
    test('rejects two primary columns', (): void => {
        expect((): TableSchema => schema((table: Blueprint): void => {
            table.integer('a').primary();
            table.integer('b').primary();
        })).toThrow(new SchemaException('Table [users] declares more than one primary column [a, b].'));
    });

    test('rejects a primary column alongside id()', (): void => {
        expect((): TableSchema => schema((table: Blueprint): void => {
            table.id();
            table.uuid('uid').primary();
        })).toThrow(SchemaException);
    });

    test('rejects a duplicate column name', (): void => {
        expect((): TableSchema => schema((table: Blueprint): void => {
            table.string('name');
            table.integer('name');
        })).toThrow(new SchemaException('Column [name] is declared more than once on table [users].'));
    });

    test('rejects a duplicate index name', (): void => {
        expect((): TableSchema => schema((table: Blueprint): void => {
            table.index(['name'], 'by_name');
            table.index(['age'], 'by_name');
        })).toThrow(new SchemaException('Index [by_name] is declared more than once on table [users].'));
    });
});

describe('Blueprint operations in create mode', (): void => {
    test('reports every column as added and every index as new', (): void => {
        const blueprint: Blueprint = new Blueprint('users');

        blueprint.id();
        blueprint.string('email').unique();

        const operations: BlueprintOperations = blueprint.operations();

        expect(operations.added.map((column): string => column.name)).toEqual(['id', 'email']);
        expect(operations.indexed.map((index): string => index.name)).toEqual(['users_email_unique']);
        expect(operations.dropped).toEqual([]);
        expect(operations.renamed).toEqual([]);
        expect(operations.unindexed).toEqual([]);
    });
});

describe('Blueprint operations in alter mode', (): void => {
    const existing: TableSchema = {
        table     : 'users',
        key       : 'id',
        increments: true,
        timestamps: false,
        columns   : [
            { name: 'id', type: 'integer', nullable: false, default: undefined, hasDefault: false, primary: true, increments: true },
            { name: 'name', type: 'string', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false },
            { name: 'legacy', type: 'string', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false },
        ],
        indexes   : [
            { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
        ],
    };

    test('merges added columns onto the existing schema', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.integer('age').default(0);

        expect(blueprint.toSchema().columns.map((column): string => column.name)).toEqual(['id', 'name', 'legacy', 'age']);
        expect(blueprint.operations().added.map((column): string => column.name)).toEqual(['age']);
    });

    test('preserves the existing key and increments', (): void => {
        const table: TableSchema = new Blueprint('users', existing).toSchema();

        expect(table.key).toEqual('id');
        expect(table.increments).toEqual(true);
    });

    test('drops a column from the schema and reports it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('legacy');

        expect(blueprint.toSchema().columns.map((column): string => column.name)).toEqual(['id', 'name']);
        expect(blueprint.operations().dropped).toEqual(['legacy']);
    });

    test('drops several columns at once', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('legacy', 'name');

        expect(blueprint.operations().dropped).toEqual(['legacy', 'name']);
    });

    test('renames a column in the schema and reports it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('legacy', 'archived');

        expect(blueprint.toSchema().columns.map((column): string => column.name)).toEqual(['id', 'name', 'archived']);
        expect(blueprint.operations().renamed).toEqual([{ from: 'legacy', to: 'archived' }]);
    });

    test('rejects renaming a column that does not exist', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        expect((): void => blueprint.renameColumn('missing', 'other')).toThrow(new SchemaException('Column [missing] does not exist on table [users].'));
    });

    test('rejects dropping a column that does not exist', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        expect((): void => blueprint.dropColumn('missing')).toThrow(new SchemaException('Column [missing] does not exist on table [users].'));
    });

    test('drops an index from the schema and reports it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropIndex('users_name_index');

        expect(blueprint.toSchema().indexes).toEqual([]);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
    });

    test('rejects dropping an index that does not exist', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        expect((): void => blueprint.dropIndex('missing')).toThrow(new SchemaException('Index [missing] does not exist on table [users].'));
    });

    test('adds an index alongside the existing ones', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.index(['legacy']);

        expect(blueprint.toSchema().indexes.map((index): string => index.name)).toEqual(['users_name_index', 'users_legacy_index']);
        expect(blueprint.operations().indexed.map((index): string => index.name)).toEqual(['users_legacy_index']);
    });

    test('rejects an added column that already exists', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name');

        expect((): TableSchema => blueprint.toSchema()).toThrow(SchemaException);
    });

    test('rejects dropping a column declared on the same blueprint', (): void => {
        const blueprint: Blueprint = new Blueprint('users');

        blueprint.string('draft');

        expect((): void => blueprint.dropColumn('draft')).not.toThrow();
    });

    test('turns timestamps on for a table that lacked them', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.timestamps();

        expect(blueprint.toSchema().timestamps).toEqual(true);
    });

    test('keeps timestamps on for a table that already had them', (): void => {
        const table: TableSchema = new Blueprint('users', { ...existing, timestamps: true }).toSchema();

        expect(table.timestamps).toEqual(true);
    });

    test('exposes the table name', (): void => {
        expect(new Blueprint('users').table).toEqual('users');
    });
});
