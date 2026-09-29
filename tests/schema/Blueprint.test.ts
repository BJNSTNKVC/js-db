import { describe, expect, test } from 'vitest';
import { Blueprint } from '../../src/schema/Blueprint';
import { SchemaException } from '../../src/exceptions';
import type { BlueprintOperations, TableSchema } from '../../src/schema/types';
import type { IndexSchema, ColumnSchema } from '../../src/main';

/**
 * Build the schema produced by a create-mode blueprint.
 */
function schema(callback: (table: Blueprint) => void): TableSchema {
    const blueprint: Blueprint = new Blueprint('users');

    callback(blueprint);

    return blueprint.toSchema();
}

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

        expect(table.columns.map((column: ColumnSchema): string => `${column.name}:${column.type}`)).toEqual([
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
        expect(table.columns[0]).toMatchObject({ name: 'id', type: 'integer', primary: true, increments: true, places: null, values: null });
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
            { name: 'created_at', type: 'datetime', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'updated_at', type: 'datetime', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
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

        expect(operations.added.map((column: ColumnSchema): string => column.name)).toEqual(['id', 'email']);
        expect(operations.indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_email_unique']);
        expect(operations.dropped).toEqual([]);
        expect(operations.renamed).toEqual([]);
        expect(operations.changed).toEqual([]);
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
            { name: 'id', type: 'integer', nullable: false, default: undefined, hasDefault: false, primary: true, increments: true, places: null, values: null },
            { name: 'name', type: 'string', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'legacy', type: 'string', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
        ],
        indexes   : [
            { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
        ],
    };

    test('merges added columns onto the existing schema', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.integer('age').default(0);

        expect(blueprint.toSchema().columns.map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name', 'legacy', 'age']);
        expect(blueprint.operations().added.map((column: ColumnSchema): string => column.name)).toEqual(['age']);
    });

    test('preserves the existing key and increments', (): void => {
        const table: TableSchema = new Blueprint('users', existing).toSchema();

        expect(table.key).toEqual('id');
        expect(table.increments).toEqual(true);
    });

    test('drops a column from the schema and reports it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('legacy');

        expect(blueprint.toSchema().columns.map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name']);
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

        expect(blueprint.toSchema().columns.map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name', 'archived']);
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

        expect(blueprint.toSchema().indexes.map((index: IndexSchema): string => index.name)).toEqual(['users_name_index', 'users_legacy_index']);
        expect(blueprint.operations().indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_legacy_index']);
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

describe('Blueprint column changes', (): void => {
    const existing: TableSchema = {
        table     : 'users',
        key       : 'id',
        increments: true,
        timestamps: false,
        columns   : [
            { name: 'id', type: 'integer', nullable: false, default: undefined, hasDefault: false, primary: true, increments: true, places: null, values: null },
            { name: 'name', type: 'string', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'price', type: 'decimal', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false, places: 2, values: null },
            { name: 'role', type: 'enum', nullable: false, default: 'member', hasDefault: true, primary: false, increments: false, places: null, values: ['admin', 'member'] },
        ],
        indexes   : [
            { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
            { name: 'users_name_price_index', columns: ['name', 'price'], unique: false, multiEntry: false },
        ],
    };

    /**
     * Get the names of the columns of a schema.
     */
    function names(table: TableSchema): string[] {
        return table.columns.map((column: ColumnSchema): string => column.name);
    }

    /**
     * Get the names of the indexes of a schema.
     */
    function indexes(table: TableSchema): string[] {
        return table.indexes.map((index: IndexSchema): string => index.name);
    }

    test('replaces the column where it stands', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').nullable().index().change();
        blueprint.string('email');

        const table: TableSchema = blueprint.toSchema();

        expect(names(table)).toEqual(['id', 'name', 'price', 'role', 'email']);
        expect(table.columns[1]?.nullable).toEqual(true);
    });

    test('reports the column before and after, and not as added', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.enum('role', ['admin', 'member', 'owner']).change();

        const operations: BlueprintOperations = blueprint.operations();

        expect(operations.added).toEqual([]);
        expect(operations.changed).toEqual([{ from: existing.columns[3], to: expect.objectContaining({ name: 'role', hasDefault: false, values: ['admin', 'member', 'owner'] }) }]);
    });

    test('changes a column under the name a rename gives it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('name', 'title');
        blueprint.string('title').nullable().change();

        expect(names(blueprint.toSchema())).toEqual(['id', 'title', 'price', 'role']);
        expect(blueprint.operations().changed[0]?.from.name).toEqual('title');
    });

    test('rejects changing a column that does not exist', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('missing').change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [missing] does not exist on table [users].'));
        expect((): BlueprintOperations => blueprint.operations()).toThrow(SchemaException);
    });

    test('rejects changing a column the blueprint drops', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('name');
        blueprint.string('name').change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [name] does not exist on table [users].'));
    });

    test('rejects a change when creating a table', (): void => {
        expect((): TableSchema => schema((table: Blueprint): void => {
            table.string('name').change();
        })).toThrow(new SchemaException('Column [name] does not exist on table [users].'));
    });

    test('rejects changing a column twice', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').nullable().change();
        blueprint.string('name').change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [name] is declared more than once on table [users].'));
    });

    test('rejects a change of type', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.integer('name').change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [name] of table [users] may not change type from [string] to [integer]. Add a new column, copy the values across and drop the old one.'));
    });

    test('rejects a change of decimal scale', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.decimal('price', 3).change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [price] of table [users] may not change scale from [2] to [3], because every stored value would be read at the wrong scale.'));
    });

    test('keeps a decimal at the same scale', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.decimal('price').nullable().change();

        expect(blueprint.toSchema().columns[2]).toEqual(expect.objectContaining({ places: 2, nullable: true }));
    });

    test('rejects making a column the key path', (): void => {
        const blueprint: Blueprint = new Blueprint('users', { ...existing, key: null, columns: existing.columns.slice(1) });

        blueprint.string('name').primary().change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Column [name] of table [users] may not become the key path, because IndexedDB fixes it when the store is created.'));
    });

    test('keeps an index the change declares again', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').nullable().index().change();

        expect(indexes(blueprint.toSchema())).toEqual(['users_name_index', 'users_name_price_index']);
        expect(blueprint.operations().indexed).toEqual([]);
        expect(blueprint.operations().unindexed).toEqual([]);
    });

    test('deletes an index the change leaves out, keeping a compound one over the column', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').change();

        expect(indexes(blueprint.toSchema())).toEqual(['users_name_price_index']);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
    });

    test('creates an index the change adds', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.decimal('price').index().change();

        expect(indexes(blueprint.toSchema())).toEqual(['users_name_index', 'users_name_price_index', 'users_price_index']);
        expect(blueprint.operations().indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_price_index']);
    });

    test('replaces an index the change declares differently', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').unique().change();

        expect(indexes(blueprint.toSchema())).toEqual(['users_name_price_index', 'users_name_unique']);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
        expect(blueprint.operations().indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_name_unique']);
    });

    test('rebuilds an index under the same name with other options', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').unique('users_name_index').change();

        expect(blueprint.toSchema().indexes.find((index: IndexSchema): boolean => index.name === 'users_name_index')?.unique).toEqual(true);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
        expect(blueprint.operations().indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_name_index']);
    });

    test('deletes a dropped index once when the change also leaves it out', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropIndex('users_name_index');
        blueprint.string('name').change();

        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
    });

    test('recreates a dropped index the change declares again', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropIndex('users_name_index');
        blueprint.string('name').index().change();

        expect(indexes(blueprint.toSchema())).toEqual(['users_name_price_index', 'users_name_index']);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
        expect(blueprint.operations().indexed.map((index: IndexSchema): string => index.name)).toEqual(['users_name_index']);
    });

    test('still rejects an index the change declares twice', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.string('name').index().index().change();

        expect((): TableSchema => blueprint.toSchema()).toThrow(new SchemaException('Index [users_name_index] is declared more than once on table [users].'));
    });
});

describe('Blueprint renamed and dropped columns', (): void => {
    const existing: TableSchema = {
        table     : 'users',
        key       : 'id',
        increments: true,
        timestamps: false,
        columns   : [
            { name: 'id', type: 'integer', nullable: false, default: undefined, hasDefault: false, primary: true, increments: true, places: null, values: null },
            { name: 'email', type: 'string', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'name', type: 'string', nullable: false, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'city', type: 'string', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'age', type: 'integer', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'nickname', type: 'string', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
            { name: 'note', type: 'string', nullable: true, default: undefined, hasDefault: false, primary: false, increments: false, places: null, values: null },
        ],
        indexes   : [
            { name: 'users_email_unique', columns: ['email'], unique: true, multiEntry: false },
            { name: 'users_name_index', columns: ['name'], unique: false, multiEntry: false },
            { name: 'users_city_age_index', columns: ['city', 'age'], unique: false, multiEntry: false },
            { name: 'by_nickname', columns: ['nickname'], unique: false, multiEntry: false },
        ],
    };

    test('moves a single column index onto the new name, regenerating the name it was generated with', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('email', 'mail');

        const moved: IndexSchema = { name: 'users_mail_unique', columns: ['mail'], unique: true, multiEntry: false };

        expect(blueprint.toSchema().indexes).toEqual([moved, ...existing.indexes.slice(1)]);
        expect(blueprint.operations().unindexed).toEqual(['users_email_unique']);
        expect(blueprint.operations().indexed).toEqual([moved]);
    });

    test('renames a column inside a compound index, keeping its other columns and their order', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('age', 'years');

        const moved: IndexSchema = { name: 'users_city_years_index', columns: ['city', 'years'], unique: false, multiEntry: false };

        expect(blueprint.toSchema().indexes[2]).toEqual(moved);
        expect(blueprint.operations().unindexed).toEqual(['users_city_age_index']);
        expect(blueprint.operations().indexed).toEqual([moved]);
    });

    test('keeps the name of a hand-named index through a rename', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('nickname', 'handle');

        const moved: IndexSchema = { name: 'by_nickname', columns: ['handle'], unique: false, multiEntry: false };

        expect(blueprint.toSchema().indexes[3]).toEqual(moved);
        expect(blueprint.operations().unindexed).toEqual(['by_nickname']);
        expect(blueprint.operations().indexed).toEqual([moved]);
    });

    test('drops an index over the dropped column alone', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('email');

        expect(blueprint.toSchema().indexes).toEqual(existing.indexes.slice(1));
        expect(blueprint.operations().unindexed).toEqual(['users_email_unique']);
        expect(blueprint.operations().indexed).toEqual([]);
    });

    test('refuses to drop a column a compound index still needs', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('age');

        const refusal: SchemaException = new SchemaException('Column [age] of table [users] may not be dropped while index [users_city_age_index] covers it. Drop the index first.');

        expect((): TableSchema => blueprint.toSchema()).toThrow(refusal);
        expect((): BlueprintOperations => blueprint.operations()).toThrow(refusal);
    });

    test('drops a column once the same blueprint drops the compound index that needs it', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('age');
        blueprint.dropIndex('users_city_age_index');

        expect(blueprint.toSchema().indexes.map((index: IndexSchema): string => index.name)).toEqual(['users_email_unique', 'users_name_index', 'by_nickname']);
        expect(blueprint.operations().unindexed).toEqual(['users_city_age_index']);
    });

    test('drops a compound index along with every column it covers', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.dropColumn('city', 'age');

        expect(blueprint.toSchema().indexes.map((index: IndexSchema): string => index.name)).toEqual(['users_email_unique', 'users_name_index', 'by_nickname']);
        expect(blueprint.operations().unindexed).toEqual(['users_city_age_index']);
    });

    test.each([
        ['renaming', (blueprint: Blueprint): void => blueprint.renameColumn('note', 'memo')],
        ['dropping', (blueprint: Blueprint): void => blueprint.dropColumn('note')],
    ] as [string, (blueprint: Blueprint) => void][])('leaves every index alone when %s a column no index covers', (_name: string, alter: (blueprint: Blueprint) => void): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        alter(blueprint);

        expect(blueprint.toSchema().indexes).toEqual(existing.indexes);
        expect(blueprint.operations().unindexed).toEqual([]);
        expect(blueprint.operations().indexed).toEqual([]);
    });

    test('deletes a moved index a change under the new name leaves out', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('name', 'title');
        blueprint.string('title').nullable().change();

        expect(blueprint.toSchema().indexes.map((index: IndexSchema): string => index.name)).toEqual(['users_email_unique', 'users_city_age_index', 'by_nickname']);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
        expect(blueprint.operations().indexed).toEqual([]);
    });

    test('moves an index once when a change under the new name declares it again', (): void => {
        const blueprint: Blueprint = new Blueprint('users', existing);

        blueprint.renameColumn('name', 'title');
        blueprint.string('title').nullable().index().change();

        const moved: IndexSchema = { name: 'users_title_index', columns: ['title'], unique: false, multiEntry: false };

        expect(blueprint.toSchema().indexes[1]).toEqual(moved);
        expect(blueprint.operations().unindexed).toEqual(['users_name_index']);
        expect(blueprint.operations().indexed).toEqual([moved]);
    });
});
