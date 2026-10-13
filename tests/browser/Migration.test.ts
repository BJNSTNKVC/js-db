import { afterEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Migrator } from '../../src/migrations/Migrator';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { DB } from '../../src/main';
import { MigrationTransactionClosedException } from '../../src/exceptions';
import { Env } from '../environment';
import { Engine } from '../engines';
import type { MigrationConstructor, MigrationStatus } from '../../src/migrations/types';

const connections: Connection[] = [];

let sequence: number = 0;

/**
 * Build a connection against a uniquely named database.
 */
function connect(migrations: MigrationConstructor[], database: string = `browser-migrations-${++sequence}`): Connection {
    const connection: Connection = new Connection('app', { database, migrations });

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

/**
 * Wait on a real timer, which ends the task the transaction was active in.
 */
function elsewhere(delay: number = 50): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, delay);
    });
}

/**
 * Read the version a database is stored at.
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
 * List the object stores a database holds, without running any migration.
 */
function stores(database: string): Promise<string[]> {
    return new Promise<string[]>((resolve: (names: string[]) => void, reject: (reason: unknown) => void): void => {
        const request: IDBOpenDBRequest = indexedDB.open(database);

        request.onsuccess = (): void => {
            request.result.close();

            resolve(Array.from(request.result.objectStoreNames));
        };

        request.onerror = (): void => reject(request.error);
    });
}

/**
 * Create a table with only a key.
 */
function create(table: string): Promise<void> {
    return Schema.create(table, (blueprint: Blueprint): void => {
        blueprint.id();
    });
}

const First: MigrationConstructor = migration('FirstMigration', (): Promise<void> => create('first'));
const Last: MigrationConstructor = migration('LastMigration', (): Promise<void> => create('last'));

afterEach((): void => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }
});

describe.each([
    // WebKit, and Firefox now and then, finish an upgrade's commit before a 0 ms timer,
    // but dispatch complete only after it, which the check misses.
    [0, Env.isEngine(Engine.Firefox, Engine.WebKit)],
    [50, false],
])('A migration that awaits a %i ms timer', (delay: number, skipped: boolean): void => {
    test.skipIf(skipped)('throws from the next query and leaves the migration unrecorded', async (): Promise<void> => {
        const database: string = `browser-migrations-${++sequence}`;
        const thrown: unknown[] = [];

        const Waiting: MigrationConstructor = migration('WaitingMigration', async (): Promise<void> => {
            await create('users');
            await elsewhere(delay);

            try {
                await DB.connection('app').table('users').get();
            } catch (error: unknown) {
                thrown.push(error);

                throw error;
            }
        });

        DB.configure({ default: 'app', connections: { app: { database, migrations: [Waiting] } } });

        try {
            await expect(DB.migrate('app')).rejects.toThrow(new MigrationTransactionClosedException('WaitingMigration'));
            expect(thrown).toHaveLength(1);
            expect(thrown[0]).toBeInstanceOf(MigrationTransactionClosedException);
            expect((await DB.status('app')).map((status: MigrationStatus): boolean => status.ran)).toEqual([false]);
        } finally {
            DB.purge('app');
        }
    }, 2000);

    test.skipIf(skipped)('throws from the next schema call', async (): Promise<void> => {
        const Waiting: MigrationConstructor = migration('WaitingMigration', async (): Promise<void> => {
            await create('users');
            await elsewhere(delay);
            await create('posts');
        });

        await expect(connect([Waiting]).migrate()).rejects.toThrow(new MigrationTransactionClosedException('WaitingMigration'));
    }, 2000);
});

describe('A migration that fails while its upgrade is committing', (): void => {
    test('rejects with its own failure and leaves no rejection unhandled when the abort is refused', async (): Promise<void> => {
        const unhandled: unknown[] = [];

        const listener: (event: PromiseRejectionEvent) => void = (event: PromiseRejectionEvent): void => {
            unhandled.push(event.reason);
        };

        const Committing: MigrationConstructor = migration('CommittingMigration', async (): Promise<void> => {
            await create('early');

            Migrator.alive().transaction.commit();

            throw new Error('Failed while committing.');
        });

        const database: string = `browser-migrations-${++sequence}`;

        addEventListener('unhandledrejection', listener);

        try {
            await expect(connect([Committing], database).migrate()).rejects.toThrow('Failed while committing.');
            await elsewhere();
        } finally {
            removeEventListener('unhandledrejection', listener);
        }

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(unhandled).toEqual([]);
        expect(await stored(database)).toEqual(2);
        expect(await stores(database)).toContain('early');
    }, 2000);
});

describe('A migration that fails after its upgrade committed', (): void => {
    const Committing: MigrationConstructor = migration('CommittingMigration', async (): Promise<void> => {
        await create('early');
        await elsewhere();
        await create('late');
    });

    test('runs again on the next open, with every migration after it', async (): Promise<void> => {
        const database: string = `browser-migrations-${++sequence}`;

        await expect(connect([First, Committing, Last], database).migrate()).rejects.toThrow(new MigrationTransactionClosedException('CommittingMigration'));

        connections.splice(0).forEach((connection: Connection): void => connection.disconnect());

        expect(await stored(database)).toEqual(4);

        const Fixed: MigrationConstructor = migration('CommittingMigration', (): Promise<void> => create('late'));
        const connection: Connection = connect([First, Fixed, Last], database);

        expect(await connection.migrate()).toEqual(['CommittingMigration', 'LastMigration']);
        expect((await connection.status()).map((status: MigrationStatus): boolean => status.ran)).toEqual([true, true, true]);
        expect((await connection.tables()).sort()).toEqual(['early', 'first', 'last', 'late']);
        expect((await connection.open()).version).toEqual(5);
    }, 2000);
});
