import { afterEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Migrator } from '../../src/migrations/Migrator';
import { Repository } from '../../src/migrations/Repository';
import { Registry } from '../../src/schema/Registry';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Request } from '../../src/database/Request';
import { Dispatcher } from '../../src/events/Dispatcher';
import { DB } from '../../src/main';
import {
    CheckConstraintViolationException,
    DatabaseBlockedException,
    MigrationMismatchException,
    MigrationTransactionClosedException,
    NotNullConstraintViolationException,
    ReservedTableException,
    SchemaException,
    TableNotFoundException,
    UniqueConstraintViolationException,
} from '../../src/exceptions';
import type { MigrationConstructor, MigrationStatus } from '../../src/migrations/types';
import type { ColumnSchema, TableSchema } from '../../src/schema/types';
import type { MockInstance } from 'vitest';
import type { MigrationContext } from '../../src/migrations/Migrator';
import type { DatabaseVersionChanged, IndexSchema } from '../../src/main';

let sequence: number = 0;

const connections: Connection[] = [];
const handles: IDBDatabase[] = [];
const listeners: ((event: Event) => void)[] = [];

/**
 * Build a connection against a uniquely named database.
 */
function connect(migrations: MigrationConstructor[], database: string = `connection-${++sequence}`, strict: boolean = true): Connection {
    const connection: Connection = new Connection('app', { database, migrations, strict });

    connections.push(connection);

    return connection;
}

/**
 * Build a migration class from an up implementation.
 */
function migration(name: string, up: () => void | Promise<void>): MigrationConstructor {
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
}

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
async function records(connection: Connection, table: string): Promise<Record<string, unknown>[]> {
    const database: IDBDatabase = await connection.open();

    return Request.settle(database.transaction(table, 'readonly').objectStore(table).getAll() as IDBRequest<Record<string, unknown>[]>);
}

/**
 * Write records into a table directly, bypassing the query builder.
 */
async function seed(connection: Connection, table: string, rows: Record<string, unknown>[]): Promise<void> {
    const database: IDBDatabase = await connection.open();
    const transaction: IDBTransaction = database.transaction(table, 'readwrite');

    for (const row of rows) {
        transaction.objectStore(table).add(row);
    }

    await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = (): void => reject(transaction.error);
    });
}

/**
 * Delete a database, failing rather than waiting when an open handle blocks it.
 */
function drop(database: string): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
        const request: IDBOpenDBRequest = indexedDB.deleteDatabase(database);

        request.onsuccess = (): void => resolve();
        request.onerror = (): void => reject(request.error);
        request.onblocked = (): void => reject(new Error('An open handle blocked the delete.'));
    });
}

/**
 * Collect the version changes dispatched for a database.
 */
function versionChanges(database: string): DatabaseVersionChanged[] {
    const events: DatabaseVersionChanged[] = [];

    const listener: (event: Event) => void = (event: Event): void => {
        if ((event as DatabaseVersionChanged).database === database) {
            events.push(event as DatabaseVersionChanged);
        }
    };

    Dispatcher.listen('db:database-version-changed', listener);
    listeners.push(listener);

    return events;
}

afterEach((): void => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }

    for (const handle of handles.splice(0)) {
        handle.close();
    }

    for (const listener of listeners.splice(0)) {
        Dispatcher.forget('db:database-version-changed', listener);
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

    test('lets the database be deleted after a mismatched open', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreatePostsTable, CreateUsersTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);
        await expect(drop(database)).resolves.toBeUndefined();
    });

    test('lets a later open with the right migrations upgrade after a mismatched open', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreatePostsTable, CreateUsersTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);
        await expect(connect([CreateUsersTable, CreatePostsTable, CreateTagsTable], database).migrate()).resolves.toEqual(['CreateTagsTable']);
    });

    test('lets the database be deleted after disconnecting a mismatched connection', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const connection: Connection = connect([CreatePostsTable, CreateUsersTable], database);

        await expect(connection.open()).rejects.toBeInstanceOf(MigrationMismatchException);

        connection.disconnect();

        await expect(drop(database)).resolves.toBeUndefined();
    });

    test('runs fresh on a connection whose open failed with a mismatch', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const connection: Connection = connect([CreatePostsTable, CreateUsersTable], database);

        await expect(connection.open()).rejects.toBeInstanceOf(MigrationMismatchException);
        await expect(connection.fresh()).resolves.toEqual(['CreatePostsTable', 'CreateUsersTable']);
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
        expect(schema.indexes.map((index: IndexSchema): string => index.name).sort()).toEqual(['users_age_index', 'users_email_unique']);
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

        const held: IDBDatabase = await new Promise<IDBDatabase>((resolve: (value: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 1);

            request.onsuccess = (): void => resolve(request.result);
            request.onerror = (): void => reject(request.error);
        });

        handles.push(held);

        const blocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
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
        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
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

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
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

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
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

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.deleteDatabase(database);

            request.onsuccess = (): void => resolve();
            request.onerror = (): void => reject(request.error);
            request.onblocked = (): void => reject(new Error('The connection did not step aside.'));
        });

        expect(await connection.migrate()).toEqual(['CreateUsersTable']);
        expect(await connection.tables()).toEqual(['users']);
    });
});

describe('Connection version change event', (): void => {
    test('reports the version another tab upgrades to, after which the next query fails', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateUsersTable], database);

        await first.migrate();

        const events: DatabaseVersionChanged[] = versionChanges(database);

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();

        expect(events.map((event: DatabaseVersionChanged): number | null => event.version)).toEqual([3]);
        await expect(first.table('users').count()).rejects.toBeInstanceOf(MigrationMismatchException);
    });

    test('reports a null version when another tab deletes the database', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.open();

        const events: DatabaseVersionChanged[] = versionChanges(database);

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.deleteDatabase(database);

            request.onsuccess = (): void => resolve();
            request.onerror = (): void => reject(request.error);
        });

        expect(events.map((event: DatabaseVersionChanged): number | null => event.version)).toEqual([null]);
    });

    test('is not dispatched when the connection runs fresh itself', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const connection: Connection = connect([CreateUsersTable], database);

        await connection.migrate();

        const events: DatabaseVersionChanged[] = versionChanges(database);

        await connection.fresh();

        expect(events).toEqual([]);
    });

    test('reaches a listener registered through the manager', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();

        const received: Promise<DatabaseVersionChanged> = new Promise<DatabaseVersionChanged>((resolve: (event: DatabaseVersionChanged) => void): void => {
            DB.onDatabaseVersionChanged(resolve, { once: true });
        });

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();

        const event: DatabaseVersionChanged = await received;

        expect(event.database).toEqual(database);
        expect(event.version).toEqual(3);
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
        const held: IDBDatabase = await new Promise<IDBDatabase>((resolve: (value: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
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
    function failing(error: Error): IDBOpenDBRequest {
        const request: Partial<IDBOpenDBRequest> = { error: error as unknown as DOMException };

        setTimeout((): void => {
            (request.onerror as ((event: Event) => void) | null)?.(new Event('error'));
        }, 0);

        return request as IDBOpenDBRequest;
    }

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

    test('lets the database be deleted after the stored version holds no reserved tables', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, 2);

            request.onsuccess = (): void => {
                request.result.close();

                resolve();
            };

            request.onerror = (): void => reject(request.error);
        });

        await expect(connect([CreateUsersTable], database).open()).rejects.toMatchObject({ name: 'NotFoundError' });
        await expect(drop(database)).resolves.toBeUndefined();
    });

    test('lets the database be deleted after reading the migration records fails', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const error: Error = new Error('The records could not be read.');
        const spy: MockInstance = vi.spyOn(Repository, 'ran').mockRejectedValueOnce(error);

        await expect(connect([CreateUsersTable], database).open()).rejects.toBe(error);

        spy.mockRestore();

        await expect(drop(database)).resolves.toBeUndefined();
    });

    test('lets the database be deleted after reading the schemas fails', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await connect([CreateUsersTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const error: Error = new Error('The schemas could not be read.');
        const spy: MockInstance = vi.spyOn(Registry, 'all').mockRejectedValueOnce(error);

        await expect(connect([CreateUsersTable], database).open()).rejects.toBe(error);

        spy.mockRestore();

        await expect(drop(database)).resolves.toBeUndefined();
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
    const Slow: MigrationConstructor = migration('SlowMigration', async (): Promise<void> => {
        const context: MigrationContext = Migrator.alive();

        // A migration would really await a fetch or a timer, and the transaction commits under it
        // either way. A timer is a race though, since it and the commit are both macrotasks, so
        // the transaction's own event is awaited here to establish the same state exactly.
        await new Promise<void>((resolve: () => void): void => {
            context.transaction.addEventListener('complete', (): void => resolve());
            context.transaction.addEventListener('abort', (): void => resolve());
        });

        await Schema.create('slow', (table: Blueprint): void => {
            table.id();
        });
    });

    test('fails when a migration awaits work outside the transaction', async (): Promise<void> => {
        await expect(connect([Slow]).open()).rejects.toBeInstanceOf(MigrationTransactionClosedException);
    });

    test('lets the database be deleted after a migration fails past its commit', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await expect(connect([Slow], database).open()).rejects.toBeInstanceOf(MigrationTransactionClosedException);
        await expect(drop(database)).resolves.toBeUndefined();
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
    async function altered(callback: (table: Blueprint) => void, record: Record<string, unknown> = {}): Promise<Connection> {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateUsersTable], database);

        await first.migrate();
        await seed(first, 'users', [{ name: 'John', email: 'a@b.c', age: 30, created_at: null, updated_at: null, ...record }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const AlterUsersTable: MigrationConstructor = migration('AlterUsersTable', async (): Promise<void> => {
            await Schema.table('users', callback);
        });

        const second: Connection = connect([CreateUsersTable, AlterUsersTable], database);

        await second.migrate();

        return second;
    }

    test('adds a column and backfills its default', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.string('role').default('member');
        });

        expect(await records(connection, 'users')).toEqual([expect.objectContaining({ role: 'member' })]);
        expect((await connection.schema('users')).columns.map((column: ColumnSchema): string => column.name)).toContain('role');
    });

    test('adds a column with a default and keeps a value a record already holds under its name', async (): Promise<void> => {
        const connection: Connection = await altered((table: Blueprint): void => {
            table.string('role').default('member');
        }, { role: 'admin' });

        expect(await records(connection, 'users')).toEqual([expect.objectContaining({ role: 'admin' })]);
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

describe('Schema.table column changes', (): void => {
    const CreateMembersTable: MigrationConstructor = migration('CreateMembersTable', async (): Promise<void> => {
        await Schema.create('members', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('email').nullable().unique();
            table.enum('role', ['admin', 'editor', 'member']).default('member');
            table.integer('age').nullable().index();
            table.json('tags').nullable();
        });
    });

    /**
     * Migrate a members table holding the given rows, then change it with the given callback.
     */
    async function changed(rows: Record<string, unknown>[], callback: (table: Blueprint) => void, database: string = `connection-${++sequence}`): Promise<Connection> {
        const first: Connection = connect([CreateMembersTable], database);

        await first.migrate();
        await seed(first, 'members', rows);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const ChangeMembersTable: MigrationConstructor = migration('ChangeMembersTable', async (): Promise<void> => {
            await Schema.table('members', callback);
        });

        const second: Connection = connect([CreateMembersTable, ChangeMembersTable], database);

        await second.migrate();

        return second;
    }

    /**
     * Get the schema of a column of the members table.
     */
    async function column(connection: Connection, name: string): Promise<ColumnSchema | undefined> {
        return (await connection.schema('members')).columns.find((candidate: ColumnSchema): boolean => candidate.name === name);
    }

    /**
     * Get the names of the indexes the members store really has.
     */
    async function indexNames(connection: Connection): Promise<string[]> {
        const database: IDBDatabase = await connection.open();

        return Array.from(database.transaction('members', 'readonly').objectStore('members').indexNames).sort();
    }

    /**
     * Get one column of every record in the members table.
     */
    async function values(connection: Connection, name: string): Promise<unknown[]> {
        return (await records(connection, 'members')).map((record: Record<string, unknown>): unknown => record[name]);
    }

    test('makes a column nullable, leaving the rows and the column order as they are', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'John', role: 'admin' }], (table: Blueprint): void => {
            table.string('name').nullable().change();
        });

        expect(await column(connection, 'name')).toEqual(expect.objectContaining({ nullable: true }));
        expect((await connection.schema('members')).columns.map((candidate: ColumnSchema): string => candidate.name)).toEqual(['id', 'name', 'email', 'role', 'age', 'tags']);
        expect(await records(connection, 'members')).toEqual([{ id: 1, name: 'John', role: 'admin' }]);

        await connection.table('members').insert({ name: null });

        expect(await values(connection, 'name')).toEqual(['John', null]);
    });

    test('makes a column required, giving its default to every row without a value', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A', age: null }, { name: 'B' }, { name: 'C', age: 30 }], (table: Blueprint): void => {
            table.integer('age').default(18).index().change();
        });

        expect(await column(connection, 'age')).toEqual(expect.objectContaining({ nullable: false, default: 18 }));
        expect(await values(connection, 'age')).toEqual([18, 18, 30]);
        expect(await indexNames(connection)).toEqual(['members_age_index', 'members_email_unique']);
    });

    test('refuses to make a column required without a default while rows hold no value', async (): Promise<void> => {
        await expect(changed([{ name: 'A', age: null }, { name: 'B' }, { name: 'C', age: 30 }], (table: Blueprint): void => {
            table.integer('age').index().change();
        })).rejects.toThrow(new SchemaException('Column [age] of table [members] cannot be made required without a default, because it holds no value in 2 rows.'));
    });

    test('makes a column required without a default once every row holds a value, and enforces it on writes', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A', age: 30 }], (table: Blueprint): void => {
            table.integer('age').index().change();
        });

        expect(await column(connection, 'age')).toEqual(expect.objectContaining({ nullable: false }));
        await expect(connection.table('members').insert({ name: 'B' })).rejects.toBeInstanceOf(NotNullConstraintViolationException);
    });

    test('adds a default, filling rows without the column and keeping null', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A' }, { name: 'B', age: null }], (table: Blueprint): void => {
            table.integer('age').nullable().default(18).index().change();
        });

        expect(await values(connection, 'age')).toEqual([18, null]);

        await connection.table('members').insert({ name: 'C' });

        expect(await values(connection, 'age')).toEqual([18, null, 18]);
    });

    test('removes a default', async (): Promise<void> => {
        const connection: Connection = await changed([], (table: Blueprint): void => {
            table.enum('role', ['admin', 'editor', 'member']).change();
        });

        expect(await column(connection, 'role')).toEqual(expect.objectContaining({ hasDefault: false }));
        await expect(connection.table('members').insert({ name: 'A' })).rejects.toBeInstanceOf(NotNullConstraintViolationException);
    });

    test('widens an enum', async (): Promise<void> => {
        const connection: Connection = await changed([], (table: Blueprint): void => {
            table.enum('role', ['admin', 'editor', 'member', 'owner']).default('member').change();
        });

        await connection.table('members').insert({ name: 'A', role: 'owner' });

        expect(await values(connection, 'role')).toEqual(['owner']);
    });

    test('narrows an enum when no row holds a value it drops', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A', role: 'admin' }], (table: Blueprint): void => {
            table.enum('role', ['admin', 'member']).default('member').change();
        });

        expect(await column(connection, 'role')).toEqual(expect.objectContaining({ values: ['admin', 'member'] }));
        await expect(connection.table('members').insert({ name: 'B', role: 'editor' })).rejects.toBeInstanceOf(CheckConstraintViolationException);
    });

    test('refuses to narrow an enum while rows hold a value it drops', async (): Promise<void> => {
        await expect(changed([{ name: 'A', role: 'editor' }, { name: 'B', role: 'editor' }, { name: 'C', role: 'admin' }], (table: Blueprint): void => {
            table.enum('role', ['admin', 'member']).default('member').change();
        })).rejects.toThrow(new SchemaException('Column [role] of table [members] cannot stop accepting [editor], which it still holds in 2 rows.'));
    });

    test('makes a column unique', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A' }, { name: 'B' }], (table: Blueprint): void => {
            table.string('name').unique().change();
        });

        expect(await indexNames(connection)).toEqual(['members_age_index', 'members_email_unique', 'members_name_unique']);
        await expect(connection.table('members').insert({ name: 'A' })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    });

    test('refuses to make a column unique over values that repeat', async (): Promise<void> => {
        await expect(changed([{ name: 'A' }, { name: 'A' }, { name: 'B' }], (table: Blueprint): void => {
            table.string('name').unique().change();
        })).rejects.toThrow(new SchemaException('Index [members_name_unique] of table [members] cannot be unique, because 2 rows repeat a value of [name].'));
    });

    test('refuses a default that would repeat across a unique column', async (): Promise<void> => {
        await expect(changed([{ name: 'A' }, { name: 'B' }], (table: Blueprint): void => {
            table.string('email').nullable().default('none').unique().change();
        })).rejects.toThrow(new SchemaException('Index [members_email_unique] of table [members] cannot be unique, because 2 rows repeat a value of [email].'));
    });

    test('refuses a compound unique index over values that repeat, skipping rows it would not index', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = [{ name: 'A', age: 1 }, { name: 'A', age: 1 }, { name: 'A', age: null }, { name: 'A', age: null }];

        await expect(changed(rows, (table: Blueprint): void => {
            table.unique(['name', 'age']);
        })).rejects.toThrow(new SchemaException('Index [members_name_age_unique] of table [members] cannot be unique, because 2 rows repeat a value of [name, age].'));
    });

    test('checks a unique multi entry index by element, across rows only', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A', tags: ['x', 'x', {}] }, { name: 'B', tags: ['y'] }, { name: 'C', tags: 'z' }], (table: Blueprint): void => {
            table.json('tags').nullable().unique().multiEntry().change();
        });

        expect(await indexNames(connection)).toContain('members_tags_unique');

        await expect(changed([{ name: 'A', tags: ['x', 'y'] }, { name: 'B', tags: ['y'] }], (table: Blueprint): void => {
            table.json('tags').nullable().unique().multiEntry().change();
        })).rejects.toThrow(new SchemaException('Index [members_tags_unique] of table [members] cannot be unique, because 2 rows repeat a value of [tags].'));
    });

    test('removes a unique index the change leaves out', async (): Promise<void> => {
        const connection: Connection = await changed([], (table: Blueprint): void => {
            table.string('email').nullable().change();
        });

        expect(await indexNames(connection)).toEqual(['members_age_index']);

        await connection.table('members').insert([{ name: 'A', email: 'a@b.c' }, { name: 'B', email: 'a@b.c' }]);

        expect(await values(connection, 'email')).toEqual(['a@b.c', 'a@b.c']);
    });

    test('adds and removes plain indexes', async (): Promise<void> => {
        const connection: Connection = await changed([{ name: 'A', age: 30 }], (table: Blueprint): void => {
            table.integer('age').nullable().change();
            table.string('name').index().change();
        });

        expect(await indexNames(connection)).toEqual(['members_email_unique', 'members_name_index']);
    });

    test('refuses to change the key path', async (): Promise<void> => {
        await expect(changed([], (table: Blueprint): void => {
            table.integer('id').primary().increments().change();
        })).rejects.toThrow(new SchemaException('Column [id] is the key path of table [members] and may not be changed.'));
    });

    test('refuses a change of type', async (): Promise<void> => {
        await expect(changed([], (table: Blueprint): void => {
            table.integer('name').change();
        })).rejects.toBeInstanceOf(SchemaException);
    });

    test('rolls the whole migration back when a change fails, leaving the schema and the rows as they were', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateMembersTable], database);

        await first.migrate();
        await seed(first, 'members', [{ name: 'A', age: null }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const ChangeMembersTable: MigrationConstructor = migration('ChangeMembersTable', async (): Promise<void> => {
            await Schema.table('members', (table: Blueprint): void => {
                table.string('email').nullable().default('none').change();
                table.string('name').unique().change();
            });

            await Schema.table('members', (table: Blueprint): void => {
                table.integer('age').index().change();
            });
        });

        await expect(connect([CreateMembersTable, ChangeMembersTable], database).migrate()).rejects.toThrow(new SchemaException('Column [age] of table [members] cannot be made required without a default, because it holds no value in 1 row.'));

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const restored: Connection = connect([CreateMembersTable], database);

        expect(await column(restored, 'email')).toEqual(expect.objectContaining({ hasDefault: false }));
        expect(await column(restored, 'age')).toEqual(expect.objectContaining({ nullable: true }));
        expect(await records(restored, 'members')).toEqual([{ id: 1, name: 'A', age: null }]);
        expect(await indexNames(restored)).toEqual(['members_age_index', 'members_email_unique']);
    });
});

const CreateIndexedUsersTable: MigrationConstructor = migration('CreateIndexedUsersTable', async (): Promise<void> => {
    await Schema.create('users', (table: Blueprint): void => {
        table.id();
        table.string('email').unique();
        table.string('name').index();
        table.string('city').nullable();
        table.integer('age').nullable();
        table.string('nickname').nullable().index('by_nickname');
        table.string('note').nullable();
        table.index(['city', 'age']);
    });
});

const people: Record<string, unknown>[] = [
    { email: 'a@x', name: 'Alice', city: 'Oslo', age: 30, nickname: 'al', note: 'first' },
    { email: 'b@x', name: 'Bob', city: 'Rome', age: 40, nickname: 'bo', note: 'second' },
];

const before: string[] = ['by_nickname(nickname)', 'users_city_age_index(city,age)', 'users_email_unique(email) unique', 'users_name_index(name)'];

/**
 * Migrate a users table holding the given rows, then alter it once with each given callback.
 */
async function altered(callbacks: ((table: Blueprint) => void)[], options: { database?: string; rows?: Record<string, unknown>[]; strict?: boolean } = {}): Promise<Connection> {
    const database: string = options.database ?? `connection-${++sequence}`;
    const strict: boolean = options.strict ?? true;
    const rows: Record<string, unknown>[] = options.rows ?? people;
    const first: Connection = connect([CreateIndexedUsersTable], database, strict);

    await first.migrate();

    if (rows.length > 0) {
        await seed(first, 'users', rows);
    }

    first.disconnect();
    connections.splice(connections.indexOf(first), 1);

    const AlterUsersTable: MigrationConstructor = migration('AlterUsersTable', async (): Promise<void> => {
        for (const callback of callbacks) {
            await Schema.table('users', callback);
        }
    });

    const second: Connection = connect([CreateIndexedUsersTable, AlterUsersTable], database, strict);

    await second.migrate();

    return second;
}

/**
 * Describe the indexes the registry lists for the users table.
 */
async function listed(connection: Connection): Promise<string[]> {
    return (await connection.getIndexes('users'))
        .map((index: IndexSchema): string => `${index.name}(${index.columns.join(',')})${index.unique ? ' unique' : ''}`)
        .sort();
}

/**
 * Describe the indexes the users store really has.
 */
async function stored(connection: Connection): Promise<string[]> {
    const store: IDBObjectStore = (await connection.open()).transaction('users', 'readonly').objectStore('users');

    return Array.from(store.indexNames)
        .map((name: string): IDBIndex => store.index(name))
        .map((index: IDBIndex): string => `${index.name}(${([] as string[]).concat(index.keyPath).join(',')})${index.unique ? ' unique' : ''}`);
}

describe('Schema.table renamed and dropped columns', (): void => {
    /**
     * Rename one key of every person, as a rewrite should.
     */
    function renamed(from: string, to: string): Record<string, unknown>[] {
        return people.map((person: Record<string, unknown>, position: number): Record<string, unknown> => {
            const { [from]: value, ...rest } = person;

            return { id: position + 1, ...rest, [to]: value };
        });
    }

    /**
     * Drop keys from every person, as a rewrite should.
     */
    function dropped(...columns: string[]): Record<string, unknown>[] {
        return people.map((person: Record<string, unknown>, position: number): Record<string, unknown> => ({
            id: position + 1,
            ...Object.fromEntries(Object.entries(person).filter(([column]: [string, unknown]): boolean => !columns.includes(column))),
        }));
    }

    test('moves a unique index onto the renamed column, in the registry and the store', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('email', 'mail');
        }]);

        const after: string[] = ['by_nickname(nickname)', 'users_city_age_index(city,age)', 'users_mail_unique(mail) unique', 'users_name_index(name)'];

        expect(await listed(connection)).toEqual(after);
        expect(await stored(connection)).toEqual(after);
        expect(await records(connection, 'users')).toEqual(renamed('email', 'mail'));
    });

    test('refuses a duplicate of a renamed unique column', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('email', 'mail');
        }]);

        await expect(connection.table('users').insert({ mail: 'a@x', name: 'Again' })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
        expect(await connection.table('users').count()).toEqual(2);
    });

    test('upserts by a renamed unique column', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('email', 'mail');
        }]);

        expect(await connection.table('users').upsert([{ mail: 'b@x', name: 'Bobby' }], 'mail')).toEqual(1);
        expect(await connection.table('users').orderBy('id').pluck('name')).toEqual(['Alice', 'Bobby']);
    });

    test('serves lookups on a renamed column through its moved plain index', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('name', 'full_name');
        }]);

        expect(await connection.table('users').where('full_name', 'Alice').explain()).toEqual('index:users_full_name_index');
        expect(await connection.table('users').where('full_name', 'Alice').pluck('email')).toEqual(['a@x']);
        expect(await records(connection, 'users')).toEqual(renamed('name', 'full_name'));
    });

    test('renames a column inside a compound index, keeping its other columns and their order', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('age', 'years');
        }]);

        const after: string[] = ['by_nickname(nickname)', 'users_city_years_index(city,years)', 'users_email_unique(email) unique', 'users_name_index(name)'];

        expect(await listed(connection)).toEqual(after);
        expect(await stored(connection)).toEqual(after);
        expect(await records(connection, 'users')).toEqual(renamed('age', 'years'));
    });

    test('keeps the name of a hand-named index through a rename', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('nickname', 'handle');
        }]);

        const after: string[] = ['by_nickname(handle)', 'users_city_age_index(city,age)', 'users_email_unique(email) unique', 'users_name_index(name)'];

        expect(await listed(connection)).toEqual(after);
        expect(await stored(connection)).toEqual(after);
        expect(await connection.table('users').where('handle', 'bo').explain()).toEqual('index:by_nickname');
        expect(await records(connection, 'users')).toEqual(renamed('nickname', 'handle'));
    });

    test('drops a unique index with its column, so a column added again under the name is plain', async (): Promise<void> => {
        const connection: Connection = await altered([
            (table: Blueprint): void => {
                table.dropColumn('email');
            },
            (table: Blueprint): void => {
                table.string('email').nullable();
            },
        ]);

        expect(await listed(connection)).toEqual(['by_nickname(nickname)', 'users_city_age_index(city,age)', 'users_name_index(name)']);
        expect(await records(connection, 'users')).toEqual(dropped('email'));

        await connection.table('users').insert([{ name: 'P', email: 'x@x' }, { name: 'Q', email: 'x@x' }]);

        expect(await connection.table('users').where('email', 'x@x').count()).toEqual(2);
    });

    test('refuses to drop a column a compound index still needs, rolling the migration back', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await expect(altered([(table: Blueprint): void => {
            table.dropColumn('age');
        }], { database })).rejects.toThrow(new SchemaException('Column [age] of table [users] may not be dropped while index [users_city_age_index] covers it. Drop the index first.'));

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const AlterUsersTable: MigrationConstructor = migration('AlterUsersTable', (): void => {});
        const status: MigrationStatus[] = await connect([CreateIndexedUsersTable, AlterUsersTable], database).status();

        expect(status.map((entry: MigrationStatus): boolean => entry.ran)).toEqual([true, false]);

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const restored: Connection = connect([CreateIndexedUsersTable], database);

        expect((await restored.getColumns('users')).map((column: ColumnSchema): string => column.name)).toContain('age');
        expect(await listed(restored)).toEqual(before);
        expect(await stored(restored)).toEqual(before);
        expect(await records(restored, 'users')).toEqual(dropped());
    });

    test('drops a column once the same migration drops the compound index that needs it', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.dropIndex('users_city_age_index');
            table.dropColumn('age');
        }]);

        expect(await stored(connection)).toEqual(['by_nickname(nickname)', 'users_email_unique(email) unique', 'users_name_index(name)']);
        expect(await records(connection, 'users')).toEqual(dropped('age'));
    });

    test.each([
        ['renaming', (table: Blueprint): void => table.renameColumn('note', 'memo'), renamed('note', 'memo')],
        ['dropping', (table: Blueprint): void => table.dropColumn('note'), dropped('note')],
    ] as [string, (table: Blueprint) => void, Record<string, unknown>[]][])('leaves every index alone when %s a column no index covers', async (_name: string, callback: (table: Blueprint) => void, rows: Record<string, unknown>[]): Promise<void> => {
        const connection: Connection = await altered([callback]);

        expect(await listed(connection)).toEqual(before);
        expect(await stored(connection)).toEqual(before);
        expect(await records(connection, 'users')).toEqual(rows);
    });

    test('repairs an index left over a column renamed before indexes followed it', async (): Promise<void> => {
        const CreateStaleUsersTable: MigrationConstructor = migration('CreateStaleUsersTable', async (): Promise<void> => {
            await Schema.create('users', (table: Blueprint): void => {
                table.id();
                table.string('mail');
                table.unique('email');
            });
        });

        const RepairUsersTable: MigrationConstructor = migration('RepairUsersTable', async (): Promise<void> => {
            await Schema.table('users', (table: Blueprint): void => {
                table.dropIndex('users_email_unique');
                table.unique('mail');
            });
        });

        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateStaleUsersTable], database);

        await first.migrate();
        await seed(first, 'users', [{ mail: 'a@x' }, { mail: 'b@x' }]);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const connection: Connection = connect([CreateStaleUsersTable, RepairUsersTable], database);

        expect(await listed(connection)).toEqual(['users_mail_unique(mail) unique']);
        expect(await stored(connection)).toEqual(['users_mail_unique(mail) unique']);
        await expect(connection.table('users').insert({ mail: 'a@x' })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    });
});

describe('Schema.table required columns added to a table with rows', (): void => {
    /**
     * Read the version and the store names a database holds, past the package.
     */
    async function inspected(database: string): Promise<{ version: number; stores: string[] }> {
        const handle: IDBDatabase = await new Promise<IDBDatabase>((resolve: (database: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database);

            request.onsuccess = (): void => resolve(request.result);
            request.onerror = (): void => reject(request.error);
        });

        const found: { version: number; stores: string[] } = { version: handle.version, stores: Array.from(handle.objectStoreNames).sort() };

        handle.close();

        return found;
    }

    /**
     * Build a migration that creates a ranks table, alters users, then alters users again with the given callback.
     */
    function ranking(callback: (table: Blueprint) => void): MigrationConstructor {
        return migration('AddRankToUsersTable', async (): Promise<void> => {
            await Schema.create('ranks', (table: Blueprint): void => {
                table.id();
                table.string('label');
            });

            await Schema.table('users', (table: Blueprint): void => {
                table.dropColumn('note');
                table.string('code').nullable().unique();
            });

            await Schema.table('users', callback);
        });
    }

    /**
     * Number every person as the key path would, merging the given columns into each.
     */
    function numbered(...columns: Record<string, unknown>[]): Record<string, unknown>[] {
        return people.map((person: Record<string, unknown>, position: number): Record<string, unknown> => ({ id: position + 1, ...person, ...columns[position] }));
    }

    test.each([true, false])('refuses a required column without a default on a connection with strict %s', async (strict: boolean): Promise<void> => {
        await expect(altered([(table: Blueprint): void => {
            table.integer('rank');
        }], { strict })).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));
    });

    test('rolls the whole migration back, and runs cleanly once the column has a default', async (): Promise<void> => {
        const database: string = `connection-${++sequence}`;
        const first: Connection = connect([CreateIndexedUsersTable], database);

        await first.migrate();
        await seed(first, 'users', people);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        await expect(connect([CreateIndexedUsersTable, ranking((table: Blueprint): void => {
            table.integer('rank').index();
        })], database).migrate()).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(await inspected(database)).toEqual({ version: 2, stores: [Registry.table, Repository.table, 'users'].sort() });

        const pending: MigrationStatus[] = await connect([CreateIndexedUsersTable, migration('AddRankToUsersTable', (): void => {})], database).status();

        expect(pending.map((entry: MigrationStatus): boolean => entry.ran)).toEqual([true, false]);

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const restored: Connection = connect([CreateIndexedUsersTable], database);

        expect((await restored.getColumns('users')).map((column: ColumnSchema): string => column.name)).toEqual(['id', 'email', 'name', 'city', 'age', 'nickname', 'note']);
        expect(await listed(restored)).toEqual(before);
        expect(await stored(restored)).toEqual(before);
        expect(await records(restored, 'users')).toEqual(numbered());

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        const fixed: Connection = connect([CreateIndexedUsersTable, ranking((table: Blueprint): void => {
            table.integer('rank').default(0).index();
        })], database);

        expect(await fixed.migrate()).toEqual(['AddRankToUsersTable']);
        expect(await records(fixed, 'users')).toEqual(numbered({ note: undefined, rank: 0 }, { note: undefined, rank: 0 }));
        expect(await stored(fixed)).toEqual([...before, 'users_code_unique(code) unique', 'users_rank_index(rank)'].sort());
    });

    test('adds a required column without a default to an empty table, and enforces it on writes', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.integer('rank');
        }], { rows: [] });

        expect((await connection.getColumns('users')).find((column: ColumnSchema): boolean => column.name === 'rank')).toEqual(expect.objectContaining({ nullable: false, hasDefault: false }));
        await expect(connection.table('users').insert({ email: 'c@x', name: 'Carol' })).rejects.toBeInstanceOf(NotNullConstraintViolationException);
    });

    test('runs every migration of a fresh install, whose tables are all empty', async (): Promise<void> => {
        const AddRankToUsersTable: MigrationConstructor = migration('AddRankToUsersTable', async (): Promise<void> => {
            await Schema.table('users', (table: Blueprint): void => {
                table.integer('rank').index();
            });
        });

        expect(await connect([CreateIndexedUsersTable, AddRankToUsersTable]).migrate()).toEqual(['CreateIndexedUsersTable', 'AddRankToUsersTable']);
    });

    test.each([
        ['with a default', (table: Blueprint): void => {
            table.integer('rank').default(0);
        }, numbered({ rank: 0 }, { rank: 0 })],
        ['as nullable', (table: Blueprint): void => {
            table.integer('rank').nullable();
        }, numbered()],
    ] as [string, (table: Blueprint) => void, Record<string, unknown>[]][])('adds the column %s, backfilling as before', async (_: string, callback: (table: Blueprint) => void, rows: Record<string, unknown>[]): Promise<void> => {
        expect(await records(await altered([callback]), 'users')).toEqual(rows);
    });

    test('counts only the rows that would hold no value', async (): Promise<void> => {
        await expect(altered([(table: Blueprint): void => {
            table.integer('rank');
        }], { rows: [{ ...people[0], rank: 7 }, { ...people[1], rank: null }, { email: 'c@x', name: 'Carol' }] })).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));
    });

    test('adds a required column without a default once every row holds a value under its name', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.integer('rank');
        }], { rows: numbered({ rank: 7 }, { rank: 0 }) });

        expect(await records(connection, 'users')).toEqual(numbered({ rank: 7 }, { rank: 0 }));
    });

    test('names every column without a value and counts the rows missing any of them', async (): Promise<void> => {
        await expect(altered([(table: Blueprint): void => {
            table.integer('rank');
            table.integer('level');
            table.integer('tier');
            table.integer('score').nullable();
        }], { rows: [{ ...people[0], rank: 1, level: 1 }, { ...people[1], level: 1 }, { email: 'c@x', name: 'Carol', level: 1, tier: 1 }] })).rejects.toThrow(new SchemaException('Columns [rank, tier] of table [users] cannot be added as required without a default, because they would hold no value in 3 rows.'));
    });

    test('describes a single row', async (): Promise<void> => {
        await expect(altered([(table: Blueprint): void => {
            table.integer('rank');
        }], { rows: [people[0] as Record<string, unknown>] })).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 1 row.'));
    });

    test.each([
        ['unique()', (table: Blueprint): void => {
            table.integer('rank').unique();
        }],
        ['index()', (table: Blueprint): void => {
            table.integer('rank').index();
        }],
        ['multiEntry()', (table: Blueprint): void => {
            table.json('rank').multiEntry();
        }],
    ] as [string, (table: Blueprint) => void][])('refuses a required column added with %s, creating no index', async (_: string, callback: (table: Blueprint) => void): Promise<void> => {
        const database: string = `connection-${++sequence}`;

        await expect(altered([callback], { database })).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(await stored(connect([CreateIndexedUsersTable], database))).toEqual(before);
    });

    test('checks each Schema.table call on its own, so a default given by a later call comes too late', async (): Promise<void> => {
        await expect(altered([
            (table: Blueprint): void => {
                table.integer('rank');
            },
            (table: Blueprint): void => {
                table.integer('rank').default(0).change();
            },
        ])).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));
    });

    test('makes a column added as nullable required with a default in a later call', async (): Promise<void> => {
        const connection: Connection = await altered([
            (table: Blueprint): void => {
                table.integer('rank').nullable();
            },
            (table: Blueprint): void => {
                table.integer('rank').default(0).change();
            },
        ]);

        expect(await records(connection, 'users')).toEqual(numbered({ rank: 0 }, { rank: 0 }));
    });

    test('refuses to make a column added as nullable required without a default in a later call', async (): Promise<void> => {
        await expect(altered([
            (table: Blueprint): void => {
                table.integer('rank').nullable();
            },
            (table: Blueprint): void => {
                table.integer('rank').change();
            },
        ])).rejects.toThrow(new SchemaException('Column [rank] of table [users] cannot be made required without a default, because it holds no value in 2 rows.'));
    });

    test('renames a required column, which adds nothing', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.renameColumn('name', 'full_name');
        }]);

        expect(await connection.table('users').orderBy('id').pluck('full_name')).toEqual(['Alice', 'Bob']);
    });

    test.each([
        ['renamed', (table: Blueprint): void => {
            table.renameColumn('note', 'memo');
        }],
        ['dropped', (table: Blueprint): void => {
            table.dropColumn('note');
        }],
    ] as [string, (table: Blueprint) => void][])('refuses a required column added under the name of a column %s in the same call', async (_: string, callback: (table: Blueprint) => void): Promise<void> => {
        await expect(altered([(table: Blueprint): void => {
            callback(table);
            table.string('note');
        }])).rejects.toThrow(new SchemaException('Column [note] of table [users] cannot be added as required without a default, because it would hold no value in 2 rows.'));
    });

    test.each([
        ['renamed', (table: Blueprint): void => {
            table.renameColumn('note', 'memo');
        }, numbered({ memo: 'first', note: 'none' }, { memo: 'second', note: 'none' })],
        ['dropped', (table: Blueprint): void => {
            table.dropColumn('note');
        }, numbered({ note: 'none' }, { note: 'none' })],
    ] as [string, (table: Blueprint) => void, Record<string, unknown>[]][])('gives every row the default of a column added under the name of a column %s in the same call', async (_: string, callback: (table: Blueprint) => void, rows: Record<string, unknown>[]): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            callback(table);
            table.string('note').default('none');
        }]);

        expect(await records(connection, 'users')).toEqual(rows);
    });

    test('gives the default of an added required column to a row holding null under its name', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.integer('rank').default(0);
        }], { rows: numbered({ rank: null }, { rank: 3 }) });

        expect(await records(connection, 'users')).toEqual(numbered({ rank: 0 }, { rank: 3 }));
    });

    test('keeps null under an added nullable column with a default', async (): Promise<void> => {
        const connection: Connection = await altered([(table: Blueprint): void => {
            table.integer('rank').nullable().default(0);
        }], { rows: numbered({ rank: null }, {}) });

        expect(await records(connection, 'users')).toEqual(numbered({ rank: null }, { rank: 0 }));
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
