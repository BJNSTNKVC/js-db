import { afterEach, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { DB } from '../../src/main';
import { DatabaseBlockedException, MigrationMismatchException } from '../../src/exceptions';
import type { MigrationConstructor, MigrationStatus } from '../../src/migrations/types';
import type { DatabaseBlocked, DatabaseVersionChanged } from '../../src/events';

const connections: Connection[] = [];
const tabs: string[] = [];
const blocked: ((event: DatabaseBlocked) => void)[] = [];
const changed: ((event: DatabaseVersionChanged) => void)[] = [];

let sequence: number = 0;

/**
 * Build a connection against a uniquely named database.
 */
function connect(migrations: MigrationConstructor[], database: string): Connection {
    const connection: Connection = new Connection('app', { database, migrations });

    connections.push(connection);

    return connection;
}

/**
 * Build a migration class creating a table with only a key.
 */
function creating(table: string): MigrationConstructor {
    return class extends Migration {
        /**
         * Get the name of the migration.
         */
        override name(): string {
            return `create_${table}_table`;
        }

        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await Schema.create(table, (blueprint: Blueprint): void => {
                blueprint.id();
            });
        }
    };
}

const CreateUsersTable: MigrationConstructor = creating('users');
const CreatePostsTable: MigrationConstructor = creating('posts');

/**
 * Open another tab on this origin, closed again after the test.
 */
async function tab(): Promise<string> {
    const opened: string = await commands.openTab();

    tabs.push(opened);

    return opened;
}

/**
 * Name a database no other test uses.
 */
function named(): string {
    return `browser-tabs-${++sequence}-${Date.now()}`;
}

/**
 * Read the version a database is stored at, once the opens queued before it finish.
 */
function stored(database: string): Promise<number> {
    return new Promise<number>((resolve: (version: number) => void, reject: (reason: unknown) => void): void => {
        const request: IDBOpenDBRequest = indexedDB.open(database);

        request.onsuccess = (): void => {
            request.result.close();

            resolve(request.result.version);
        };

        request.onerror = (): void => reject(request.error);
    });
}

/**
 * Wait on the other tab or an event, failing rather than hanging when it never comes.
 */
function soon<T>(waiting: Promise<T>): Promise<T> {
    const limit: Promise<never> = new Promise<never>((_: (value: never) => void, reject: (reason: unknown) => void): void => {
        setTimeout((): void => reject(new Error('Nothing arrived within 2000 ms.')), 2000);
    });

    return Promise.race([waiting, limit]);
}

/**
 * Resolve with the first blocked event dispatched for a database.
 */
function blocking(database: string): Promise<DatabaseBlocked> {
    return new Promise<DatabaseBlocked>((resolve: (event: DatabaseBlocked) => void): void => {
        const listener: (event: DatabaseBlocked) => void = (event: DatabaseBlocked): void => {
            if (event.database === database) {
                resolve(event);
            }
        };

        DB.listen('database-blocked', listener);
        blocked.push(listener);
    });
}

/**
 * Resolve with the first version change dispatched for a database.
 */
function changing(database: string): Promise<DatabaseVersionChanged> {
    return new Promise<DatabaseVersionChanged>((resolve: (event: DatabaseVersionChanged) => void): void => {
        const listener: (event: DatabaseVersionChanged) => void = (event: DatabaseVersionChanged): void => {
            if (event.database === database) {
                resolve(event);
            }
        };

        DB.listen('database-version-changed', listener);
        changed.push(listener);
    });
}

afterEach(async (): Promise<void> => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }

    for (const listener of blocked.splice(0)) {
        DB.forget('database-blocked', listener);
    }

    for (const listener of changed.splice(0)) {
        DB.forget('database-version-changed', listener);
    }

    for (const opened of tabs.splice(0)) {
        await commands.closeTab(opened);
    }
});

describe('Another tab holding the database open', (): void => {
    test('blocks this tab\'s upgrade until it closes, after which the next open succeeds', async (): Promise<void> => {
        const database: string = named();
        const other: string = await tab();

        expect(await soon(commands.holdDatabase(other, database, 1))).toEqual(1);

        const event: Promise<DatabaseBlocked> = blocking(database);
        const connection: Connection = connect([CreateUsersTable], database);

        await expect(soon(connection.open())).rejects.toThrow(new DatabaseBlockedException(database));
        expect((await soon(event)).database).toEqual(database);

        await soon(commands.closeDatabase(other, database));

        await soon(connection.open());

        expect(await connection.tables()).toEqual(['users']);
    });

    test('leaves a tab that recovered from the block stepping aside for a later upgrade', async (): Promise<void> => {
        const database: string = named();
        const other: string = await tab();

        await soon(commands.holdDatabase(other, database, 1));

        const connection: Connection = connect([CreateUsersTable], database);

        await expect(soon(connection.open())).rejects.toBeInstanceOf(DatabaseBlockedException);

        await soon(commands.closeDatabase(other, database));
        await soon(connection.open());

        expect(await soon(commands.upgradeDatabase(other, database, 9))).toEqual(false);
    });

    test('runs none of the rejected open\'s migrations once that tab closes', async (): Promise<void> => {
        const database: string = named();
        const other: string = await tab();

        await soon(commands.holdDatabase(other, database, 1));

        const connection: Connection = connect([CreateUsersTable], database);

        await expect(soon(connection.open())).rejects.toBeInstanceOf(DatabaseBlockedException);

        await soon(commands.closeDatabase(other, database));

        expect(await soon(connection.status())).toEqual([{ migration: 'create_users_table', ran: false, at: null }]);
        expect(await soon(stored(database))).toEqual(1);
    });

    test('runs the migrations on the next open instead, made as soon as that tab closes', async (): Promise<void> => {
        const database: string = named();
        const other: string = await tab();

        await soon(commands.holdDatabase(other, database, 1));

        const connection: Connection = connect([CreateUsersTable], database);

        await expect(soon(connection.open())).rejects.toBeInstanceOf(DatabaseBlockedException);

        await soon(commands.closeDatabase(other, database));

        expect(await soon(connection.migrate())).toEqual(['create_users_table']);
        expect((await connection.status()).map((status: MigrationStatus): boolean => status.ran)).toEqual([true]);
        expect((await connection.open()).version).toEqual(2);
    });

    test('leaves another tab\'s delete unblocked once the tab that recovered disconnects', async (): Promise<void> => {
        const database: string = named();
        const other: string = await tab();

        await soon(commands.holdDatabase(other, database, 1));

        const connection: Connection = connect([CreateUsersTable], database);

        await expect(soon(connection.open())).rejects.toBeInstanceOf(DatabaseBlockedException);

        await soon(commands.closeDatabase(other, database));
        await soon(connection.open());

        connection.disconnect();

        expect(await soon(commands.deleteDatabase(other, database))).toEqual(false);
    });
});

describe('Another tab upgrading the database', (): void => {
    test('makes this tab close its handle and report the new version, without blocking that tab', async (): Promise<void> => {
        const database: string = named();
        const connection: Connection = connect([CreateUsersTable], database);
        const other: string = await tab();

        await connection.migrate();

        const event: Promise<DatabaseVersionChanged> = changing(database);

        expect(await soon(commands.upgradeDatabase(other, database, 9))).toEqual(false);
        expect((await soon(event)).version).toEqual(9);
    });
});

describe('Another tab deleting the database', (): void => {
    test('makes this tab close its handle and report a null version, without blocking that tab', async (): Promise<void> => {
        const database: string = named();
        const connection: Connection = connect([CreateUsersTable], database);
        const other: string = await tab();

        await connection.migrate();

        const event: Promise<DatabaseVersionChanged> = changing(database);

        expect(await soon(commands.deleteDatabase(other, database))).toEqual(false);
        expect((await soon(event)).version).toBeNull();
    });
});

describe('A tab whose open fails with a migration mismatch', (): void => {
    test('closes its handle, so another tab\'s upgrade is never blocked', async (): Promise<void> => {
        const database: string = named();

        await connect([CreateUsersTable, CreatePostsTable], database).migrate();
        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        await expect(connect([CreatePostsTable, CreateUsersTable], database).open()).rejects.toBeInstanceOf(MigrationMismatchException);

        const other: string = await tab();

        expect(await soon(commands.upgradeDatabase(other, database, 9))).toEqual(false);
    });
});
