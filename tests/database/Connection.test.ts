import { afterEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Migrator } from '../../src/migrations/Migrator';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Request } from '../../src/database/Request';
import { Dispatcher } from '../../src/events/Dispatcher';
import {
    DatabaseBlockedException,
    MigrationMismatchException,
    MigrationTransactionClosedException,
    ReservedTableException,
    SchemaException,
    TableNotFoundException,
} from '../../src/exceptions';
import type { MigrationConstructor, MigrationStatus } from '../../src/migrations/types';
import type { ColumnSchema, TableSchema } from '../../src/schema/types';
import type { MockInstance } from 'vitest';
import type { MigrationContext } from '../../src/migrations/Migrator';

let sequence: number = 0;

const connections: Connection[] = [];
const handles: IDBDatabase[] = [];

/**
 * Build a connection against a uniquely named database.
 */
const connect = (migrations: MigrationConstructor[], database: string = `connection-${++sequence}`): Connection => {
    const connection: Connection = new Connection('app', { database, migrations });

    connections.push(connection);

    return connection;
};

/**
 * Build a migration class from an up implementation.
 */
const migration = (name: string, up: () => void | Promise<void>): MigrationConstructor => {
    return class extends Migration {
        /**
         * Get the name of the migration.
         */
        override name(): string {
            return name;
        }

        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await up();
        }
    };
};

const CreateUsersTable: MigrationConstructor = migration('CreateUsersTable', async (): Promise<void> => {
    await Schema.create('users', (table: Blueprint): void => {
        table.id();
        table.string('name');
        table.string('email').unique();
        table.integer('age').nullable().index();
        table.timestamps();
    });
});

const CreatePostsTable: MigrationConstructor = migration('CreatePostsTable', async (): Promise<void> => {
    await Schema.create('posts', (table: Blueprint): void => {
        table.id();
        table.string('title');
    });
});

const CreateTagsTable: MigrationConstructor = migration('CreateTagsTable', async (): Promise<void> => {
    await Schema.create('tags', (table: Blueprint): void => {
        table.id();
        table.string('label');
    });
});

/**
 * Read the records of a table directly, bypassing the query builder.
 */
const records = async (connection: Connection, table: string): Promise<Record<string, unknown>[]> => {
    const database: IDBDatabase = await connection.open();

    return Request.settle(database.transaction(table, 'readonly').objectStore(table).getAll() as IDBRequest<Record<string, unknown>[]>);
};

/**
 * Write records into a table directly, bypassing the query builder.
 */
const seed = async (connection: Connection, table: string, rows: Record<string, unknown>[]): Promise<void> => {
    const database: IDBDatabase = await connection.open();
    const transaction: IDBTransaction = database.transaction(table, 'readwrite');

    for (const row of rows) {
        transaction.objectStore(table).add(row);
    }

    await new Promise<void>((resolve, reject): void => {
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = (): void => reject(transaction.error);
    });
};

afterEach((): void => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }

    for (const handle of handles.splice(0)) {
        handle.close();
    }
});

describe('Connection versioning', (): void => {
    test('opens at one more than the migration count, so a first migration still upgrades', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable, CreatePostsTable]);
        const database: IDBDatabase = await connection.open();

        expect(database.version).toEqual(3);
    });

    test('runs every migration against a fresh database', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable, CreatePostsTable]);

        expect(await connection.migrate()).toEqual(['CreateUsersTable', 'CreatePostsTable']);
        expect((await connection.tables()).sort()).toEqual(['posts', 'users']);
    });

    test('runs nothing on a second open of the same database', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(await connect([CreateUsersTable], database).migrate()).toEqual([]);
    });

    test('runs only the appended migration when one is added', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const connection: Connection = connect([CreateUsersTable, CreatePostsTable], database);

        expect(await connection.migrate()).toEqual(['CreatePostsTable']);
        expect((await connection.open()).version).toEqual(3);
    });

    test('reports nothing on a second migrate of a live connection', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);

        expect(await connection.migrate()).toEqual(['CreateUsersTable']);
        expect(await connection.migrate()).toEqual([]);
    });

    test('creates the reserved stores for a connection with no migrations', async (): Promise<void> => {
        const connection: Connection = connect([]);
        const database: IDBDatabase = await connection.open();

        expect(database.version).toEqual(1);
        expect(Array.from(database.objectStoreNames).sort()).toEqual(['migrations', 'schema']);
        expect(await connection.tables()).toEqual([]);
    });

    test('shares one handle between concurrent opens', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);
        const [first, second]: IDBDatabase[] = await Promise.all([connection.open(), connection.open()]);

        expect(first).toBe(second);
    });

    test('reuses the handle it already holds', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);

        expect(await connection.open()).toBe(await connection.open());
    });
});

describe('Connection status', (): void => {
    test('reports every migration as run once they have', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable, CreatePostsTable]);

        await connection.migrate();

        const status: MigrationStatus[] = await connection.status();

        expect(status.map((entry: MigrationStatus): string => entry.migration)).toEqual(['CreateUsersTable', 'CreatePostsTable']);
        expect(status.every((entry: MigrationStatus): boolean => entry.ran)).toEqual(true);
        expect(status[0]?.at).toEqual(expect.any(String));
    });

    test('reports every migration as pending before anything has run', async (): Promise<void> => {
        const status: MigrationStatus[] = await connect([CreateUsersTable, CreatePostsTable]).status();

        expect(status).toEqual([
            { migration: 'CreateUsersTable', ran: false, at: null },
            { migration: 'CreatePostsTable', ran: false, at: null },
        ]);
    });

    test('reports a mix once one migration has been appended', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const status: MigrationStatus[] = await connect([CreateUsersTable, CreatePostsTable], database).status();

        expect(status.map((entry: MigrationStatus): boolean => entry.ran)).toEqual([true, false]);
        expect(status[1]?.at).toBeNull();
    });

    test('does not migrate as a side effect of reporting status', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.status();

        expect(await connection.migrate()).toEqual(['CreateUsersTable']);
    });

    test('reports a connection with no migrations as having nothing to run', async (): Promise<void> => {
        expect(await connect([]).status()).toEqual([]);
    });
});

describe('Connection migration mismatch', (): void => {
    test('rejects a migration inserted into the middle of the list', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreateUsersTable, CreateTagsTable, CreatePostsTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);
    });

    test('rejects a migration removed from the list', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreateUsersTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);
    });

    test('rejects a reordered list even though the count is unchanged', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreatePostsTable, CreateUsersTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);
    });
});

describe('Connection schema cache', (): void => {
    test('resolves a table schema from memory', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);
        const schema: TableSchema = await connection.schema('users');

        expect(schema.table).toEqual('users');
        expect(schema.key).toEqual('id');
        expect(schema.increments).toEqual(true);
        expect(schema.timestamps).toEqual(true);
        expect(schema.columns.map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name', 'email', 'age', 'created_at', 'updated_at']);
        expect(schema.indexes.map((index): string => index.name).sort()).toEqual(['users_age_index', 'users_email_unique']);
    });

    test('fails for a table that does not exist', async (): Promise<void> => {
        await expect(connect([CreateUsersTable]).schema('missing')).rejects.toBeInstanceOf(TableNotFoundException);
    });

    test('is emptied on disconnect and rebuilt on the next open', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);

        await connection.open();
        connection.disconnect();

        expect(await connection.tables()).toEqual(['users']);
    });
});

describe('Connection multi tab', (): void => {
    test('fails when another connection pins an older version', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        const held: IDBDatabase = await new Promise<IDBDatabase>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 1);

            request.onsuccess = (): void => resolve(request.result);
            request.onerror = (): void => reject(request.error);
        });

        handles.push(held);

        const blocked: Promise<void> = new Promise<void>((resolve): void => {
            Dispatcher.listen('db:database-blocked', (): void => resolve(), true);
        });

        await expect(connect([CreateUsersTable], database).open()).rejects.toBeInstanceOf(DatabaseBlockedException);
        await blocked;
    });

    test('steps aside when another tab upgrades, rather than blocking it', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.open();

        // The upgrade only completes if our versionchange handler closed the handle it holds.
        await new Promise<void>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 9);

            request.onsuccess = (): void => {
                handles.push(request.result);

                resolve();
            };

            request.onerror = (): void => reject(request.error);
            request.onblocked = (): void => reject(new Error('The connection did not step aside.'));
        });
    });

    test('reports a database upgraded past its own version as a migration mismatch', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.migrate();

        await new Promise<void>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 9);

            request.onsuccess = (): void => {
                request.result.close();

                resolve();
            };

            request.onerror = (): void => reject(request.error);
            request.onblocked = (): void => reject(new Error('The connection did not step aside.'));
        });

        await expect(connection.open()).rejects.toBeInstanceOf(MigrationMismatchException);
    });

    test('names the migrations already run when reporting a mismatch', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.migrate();
        connection.disconnect();

        await new Promise<void>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 9);

            request.onsuccess = (): void => {
                request.result.close();

                resolve();
            };

            request.onerror = (): void => reject(request.error);
        });

        await expect(connection.open()).rejects.toThrow(/already run \[CreateUsersTable\]/);
    });

    test('recreates the database when another tab deletes it', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.open();

        await new Promise<void>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.deleteDatabase(database);

            request.onsuccess = (): void => resolve();
            request.onerror = (): void => reject(request.error);
            request.onblocked = (): void => reject(new Error('The connection did not step aside.'));
        });

        expect(await connection.migrate()).toEqual(['CreateUsersTable']);
        expect(await connection.tables()).toEqual(['users']);
    });
});

describe('Connection fresh', (): void => {
    test('deletes the database and replays every migration', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);

        await connection.migrate();
        await seed(connection, 'users', [{ name: 'John', email: 'a@b.c', age: null, created_at: null, updated_at: null }]);

        expect(await records(connection, 'users')).toHaveLength(1);
        expect(await connection.fresh()).toEqual(['CreateUsersTable']);
        expect(await records(connection, 'users')).toHaveLength(0);
    });
});

describe('Connection fresh when blocked', (): void => {
    test('fails when another connection holds the database open', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.migrate();

        // A raw handle with no versionchange handler will not step aside for the delete.
        const held: IDBDatabase = await new Promise<IDBDatabase>((resolve, reject): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 2);

            request.onsuccess = (): void => resolve(request.result);
            request.onerror = (): void => reject(request.error);
        });

        handles.push(held);

        await expect(connection.fresh()).rejects.toBeInstanceOf(DatabaseBlockedException);
    });
});

describe('Connection platform failures', (): void => {
    /**
     * Build a request that fails on the next tick with the given error.
     */
    const failing = (error: Error): IDBOpenDBRequest => {
        const request: Partial<IDBOpenDBRequest> = { error: error as unknown as DOMException };

        setTimeout((): void => {
            (request.onerror as ((event: Event) => void) | null)?.(new Event('error'));
        }, 0);

        return request as IDBOpenDBRequest;
    };

    test('surfaces a failure to open at the stored version', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);
        const error: Error = new Error('The database could not be opened.');
        const spy: MockInstance = vi.spyOn(indexedDB, 'open').mockImplementation((): IDBOpenDBRequest => failing(error));

        await expect(connection.status()).rejects.toBe(error);

        spy.mockRestore();
    });

    test('surfaces a failure to delete the database', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);

        await connection.migrate();

        const error: Error = new Error('The database could not be deleted.');
        const spy: MockInstance = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((): IDBOpenDBRequest => failing(error));

        await expect(connection.fresh()).rejects.toBe(error);

        spy.mockRestore();
    });

    test('surfaces an open failure that is not a version conflict', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);
        const error: Error = new Error('Quota exceeded.');
        const spy: MockInstance = vi.spyOn(indexedDB, 'open').mockImplementation((): IDBOpenDBRequest => failing(error));

        await expect(connection.open()).rejects.toBe(error);

        spy.mockRestore();
    });
});

describe('Migrator.alive outside a migration', (): void => {
    test('reports that there is no live transaction', (): void => {
        expect((): unknown => Migrator.alive()).toThrow(MigrationTransactionClosedException);
    });
});

describe('Connection strictness', (): void => {
    test('is strict by default', (): void => {
        expect(new Connection('app', { database: 'strict-default' }).strict).toEqual(true);
    });

    test('honours an explicit true', (): void => {
        expect(new Connection('app', { database: 'strict-true', strict: true }).strict).toEqual(true);
    });

    test('honours an explicit false', (): void => {
        expect(new Connection('app', { database: 'strict-false', strict: false }).strict).toEqual(false);
    });

    test('exposes its name and database', (): void => {
        const connection: Connection = new Connection('reporting', { database: 'reports' });

        expect(connection.name).toEqual('reporting');
        expect(connection.database).toEqual('reports');
        expect(connection.migrations).toEqual([]);
        expect(connection.seeders).toEqual([]);
    });
});

describe('Migration transaction hazard', (): void => {
    test('fails when a migration awaits work outside the transaction', async (): Promise<void> => {
        const Slow: MigrationConstructor = migration('SlowMigration', async (): Promise<void> => {
            await new Promise<void>((resolve): void => {
                setTimeout(resolve, 0);
            });

            await Schema.create('slow', (table: Blueprint): void => {
                table.id();
            });
        });

        await expect(connect([Slow]).open()).rejects.toBeInstanceOf(MigrationTransactionClosedException);
    });
});

describe('Migration failures', (): void => {
    test('surfaces the platform error when a migration aborts the transaction', async (): Promise<void> => {
        const Duplicate: MigrationConstructor = migration('DuplicateKeys', async (): Promise<void> => {
            await Schema.create('duplicates', (table: Blueprint): void => {
                table.uuid('id').primary();
            });

            const context: MigrationContext = Migrator.alive();
            const store: IDBObjectStore = context.transaction.objectStore('duplicates');

            store.add({ id: 'same' });
            store.add({ id: 'same' });
        });

        await expect(connect([Duplicate]).open()).rejects.toBeInstanceOf(DOMException);
    });

    test('rolls the schema back when a migration fails', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        const Failing: MigrationConstructor = migration('FailingMigration', async (): Promise<void> => {
            await Schema.create('kept', (table: Blueprint): void => {
                table.id();
            });

            throw new Error('Nope.');
        });

        await expect(connect([Failing], database).open()).rejects.toThrow('Nope.');

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(await connect([], database).tables()).toEqual([]);
    });
});

describe('Reserved tables', (): void => {
    test.each(['migrations', 'schema'])('refuses to create the reserved table %s', async (table: string): Promise<void> => {
        const Reserved: MigrationConstructor = migration('ReservedMigration', async (): Promise<void> => {
            await Schema.create(table, (blueprint: Blueprint): void => {
                blueprint.id();
            });
        });

        await expect(connect([Reserved]).open()).rejects.toBeInstanceOf(ReservedTableException);
    });

    test('lists the reserved table names', (): void => {
        expect(Schema.reserved()).toEqual(['migrations', 'schema']);
    });
});

describe('Schema outside a migration', (): void => {
    test.each([
        ['create', async (): Promise<void> => Schema.create('users', (): void => {})],
        ['table', async (): Promise<void> => Schema.table('users', (): void => {})],
        ['drop', async (): Promise<void> => Schema.drop('users')],
        ['dropIfExists', async (): Promise<void> => Schema.dropIfExists('users')],
        ['rename', async (): Promise<void> => Schema.rename('users', 'people')],
    ] as [string, () => Promise<void>][])('refuses Schema.%s()', async (name: string, operation: () => Promise<void>): Promise<void> => {
        await expect(operation()).rejects.toThrow(new SchemaException(`Schema.${name}() may only be called inside a migration.`));
    });
});

describe('Schema.create', (): void => {
    test('builds the store with the declared key and indexes', async (): Promise<void> => {
        const connection: Connection = connect([CreateUsersTable]);
        const database: IDBDatabase = await connection.open();
        const store: IDBObjectStore = database.transaction('users', 'readonly').objectStore('users');

        expect(store.keyPath).toEqual('id');
        expect(store.autoIncrement).toEqual(true);
        expect(Array.from(store.indexNames).sort()).toEqual(['users_age_index', 'users_email_unique']);
        expect(store.index('users_email_unique').unique).toEqual(true);
    });

    test('builds an out of line key when no primary is declared', async (): Promise<void> => {
        const Keyless: MigrationConstructor = migration('CreateKeylessTable', async (): Promise<void> => {
            await Schema.create('keyless', (table: Blueprint): void => {
                table.string('name');
            });
        });

        const database: IDBDatabase = await connect([Keyless]).open();
        const store: IDBObjectStore = database.transaction('keyless', 'readonly').objectStore('keyless');

        expect(store.keyPath).toBeNull();
        expect(store.autoIncrement).toEqual(true);
    });

    test('builds a compound index', async (): Promise<void> => {
        const Compound: MigrationConstructor = migration('CreateCompoundTable', async (): Promise<void> => {
            await Schema.create('compound', (table: Blueprint): void => {
                table.id();
                table.string('name');
                table.integer('age');
                table.index(['name', 'age']);
            });
        });

        const database: IDBDatabase = await connect([Compound]).open();
        const store: IDBObjectStore = database.transaction('compound', 'readonly').objectStore('compound');

        expect(store.index('compound_name_age_index').keyPath).toEqual(['name', 'age']);
    });

    test('refuses to create a table twice', async (): Promise<void> => {
        const Twice: MigrationConstructor = migration('CreateTwice', async (): Promise<void> => {
            await Schema.create('twice', (table: Blueprint): void => {
                table.id();
            });

            await Schema.create('twice', (table: Blueprint): void => {
                table.id();
            });
        });

        await expect(connect([Twice]).open()).rejects.toThrow(new SchemaException('Table [twice] already exists.'));
    });
});

describe('Schema.table', (): void => {
    /**
     * Migrate a users table, then alter it with the given callback.
     */
    const altered = async (callback: (table: Blueprint) => void): Promise<Connection> => {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateUsersTable], database);

        await first.migrate();
        await seed(first, 'users', [{ name: 'John', email: 'a@b.c', age: 30, created_at: null, updated_at: null }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const AlterUsersTable: MigrationConstructor = migration('AlterUsersTable', async (): Promise<void> => {
            await Schema.table('users', callback);
        });

        const second: Connection = connect([CreateUsersTable, AlterUsersTable], database);

        await second.migrate();

        return second;
    };

    test('adds a column and backfills its default', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.string('role').default('member');
        });

        expect(await records(connection, 'users')).toEqual([expect.objectContaining({ role: 'member' })]);
        expect((await connection.schema('users')).columns.map((column: ColumnSchema): string => column.name)).toContain('role');
    });

    test('adds a column without a default and leaves records untouched', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.string('role').nullable();
        });

        const rows: Record<string, unknown>[] = await records(connection, 'users');

        expect(Object.hasOwn(rows[0] as Record<string, unknown>, 'role')).toEqual(false);
    });

    test('drops a column from every record', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.dropColumn('age');
        });

        const rows: Record<string, unknown>[] = await records(connection, 'users');

        expect(Object.hasOwn(rows[0] as Record<string, unknown>, 'age')).toEqual(false);
        expect((await connection.schema('users')).columns.map((column: ColumnSchema): string => column.name)).not.toContain('age');
    });

    test('renames a column in every record', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.renameColumn('age', 'years');
        });

        expect(await records(connection, 'users')).toEqual([expect.objectContaining({ years: 30 })]);
    });

    test('drops an index', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.dropIndex('users_age_index');
        });

        const database: IDBDatabase = await connection.open();

        expect(Array.from(database.transaction('users', 'readonly').objectStore('users').indexNames)).toEqual(['users_email_unique']);
    });

    test('adds an index', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.index(['name']);
        });

        const database: IDBDatabase = await connection.open();

        expect(Array.from(database.transaction('users', 'readonly').objectStore('users').indexNames).sort()).toEqual(['users_age_index', 'users_email_unique', 'users_name_index']);
    });

    test('refuses to drop the key path', async (): Promise<void> => {
        await expect(altered((table: Blueprint): void => {
            table.dropColumn('id');
        })).rejects.toThrow(new SchemaException('Column [id] is the key path of table [users] and may not be dropped or renamed.'));
    });

    test('refuses to rename the key path', async (): Promise<void> => {
        await expect(altered((table: Blueprint): void => {
            table.renameColumn('id', 'uid');
        })).rejects.toBeInstanceOf(SchemaException);
    });

    test('fails for a table that does not exist', async (): Promise<void> => {
        const Missing: MigrationConstructor = migration('AlterMissing', async (): Promise<void> => {
            await Schema.table('missing', (): void => {});
        });

        await expect(connect([Missing]).open()).rejects.toBeInstanceOf(TableNotFoundException);
    });

    test('alters a table with out of line keys, which has no key path to protect', async (): Promise<void> => {
        const CreateKeyless: MigrationConstructor = migration('CreateKeylessForAlter', async (): Promise<void> => {
            await Schema.create('keyless', (table: Blueprint): void => {
                table.string('name');
            });
        });

        const AlterKeyless: MigrationConstructor = migration('AlterKeyless', async (): Promise<void> => {
            await Schema.table('keyless', (table: Blueprint): void => {
                table.string('role').default('member');
            });
        });

        const connection: Connection = connect([CreateKeyless, AlterKeyless]);

        expect((await connection.schema('keyless')).columns.map((column: ColumnSchema): string => column.name)).toEqual(['name', 'role']);
    });
});

describe('Schema.drop', (): void => {
    test('drops a table', async (): Promise<void> => {
        const DropPosts: MigrationConstructor = migration('DropPosts', async (): Promise<void> => {
            await Schema.drop('posts');
        });

        const connection: Connection = connect([CreateUsersTable, CreatePostsTable, DropPosts]);

        expect(await connection.tables()).toEqual(['users']);
        expect(Array.from((await connection.open()).objectStoreNames)).not.toContain('posts');
    });

    test('fails for a table that does not exist', async (): Promise<void> => {
        const DropMissing: MigrationConstructor = migration('DropMissing', async (): Promise<void> => {
            await Schema.drop('missing');
        });

        await expect(connect([DropMissing]).open()).rejects.toBeInstanceOf(TableNotFoundException);
    });
});

describe('Schema.dropIfExists', (): void => {
    test('drops a table that exists', async (): Promise<void> => {
        const Drop: MigrationConstructor = migration('DropIfExists', async (): Promise<void> => {
            await Schema.dropIfExists('posts');
        });

        expect(await connect([CreateUsersTable, CreatePostsTable, Drop]).tables()).toEqual(['users']);
    });

    test('does nothing for a table that does not exist', async (): Promise<void> => {
        const Drop: MigrationConstructor = migration('DropIfExistsMissing', async (): Promise<void> => {
            await Schema.dropIfExists('missing');
        });

        expect(await connect([CreateUsersTable, Drop]).tables()).toEqual(['users']);
    });
});

describe('Schema.rename', (): void => {
    test('copies every record into the new table and drops the old one', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateUsersTable], database);

        await first.migrate();
        await seed(first, 'users', [{ name: 'John', email: 'a@b.c', age: 30, created_at: null, updated_at: null }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const RenameUsers: MigrationConstructor = migration('RenameUsers', async (): Promise<void> => {
            await Schema.rename('users', 'people');
        });

        const second: Connection = connect([CreateUsersTable, RenameUsers], database);

        await second.migrate();

        expect(await second.tables()).toEqual(['people']);
        expect(await records(second, 'people')).toEqual([expect.objectContaining({ name: 'John' })]);
        expect((await second.schema('people')).table).toEqual('people');
    });

    test('copies records of a table with out of line keys', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        const CreateKeyless: MigrationConstructor = migration('CreateKeyless', async (): Promise<void> => {
            await Schema.create('keyless', (table: Blueprint): void => {
                table.string('name');
            });
        });

        const first: Connection = connect([CreateKeyless], database);

        await first.migrate();
        await seed(first, 'keyless', [{ name: 'John' }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const RenameKeyless: MigrationConstructor = migration('RenameKeyless', async (): Promise<void> => {
            await Schema.rename('keyless', 'named');
        });

        const second: Connection = connect([CreateKeyless, RenameKeyless], database);

        await second.migrate();

        expect(await records(second, 'named')).toEqual([{ name: 'John' }]);
    });

    test('fails for a source table that does not exist', async (): Promise<void> => {
        const Rename: MigrationConstructor = migration('RenameMissing', async (): Promise<void> => {
            await Schema.rename('missing', 'other');
        });

        await expect(connect([Rename]).open()).rejects.toBeInstanceOf(TableNotFoundException);
    });

    test('refuses a reserved target name', async (): Promise<void> => {
        const Rename: MigrationConstructor = migration('RenameToReserved', async (): Promise<void> => {
            await Schema.rename('users', 'migrations');
        });

        await expect(connect([CreateUsersTable, Rename]).open()).rejects.toBeInstanceOf(ReservedTableException);
    });

    test('refuses a target table that already exists', async (): Promise<void> => {
        const Rename: MigrationConstructor = migration('RenameToExisting', async (): Promise<void> => {
            await Schema.rename('users', 'posts');
        });

        await expect(connect([CreateUsersTable, CreatePostsTable, Rename]).open()).rejects.toThrow(new SchemaException('Table [posts] already exists.'));
    });
});
