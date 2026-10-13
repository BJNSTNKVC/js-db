import { afterEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Request } from '../../src/database/Request';
import { Env } from '../environment';
import type { MigrationConstructor } from '../../src/migrations/types';
import type { ColumnSchema } from '../../src/schema/types';

const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

let sequence: number = 0;

const connections: Connection[] = [];

/**
 * Build a connection against a uniquely named database.
 */
function connect(migrations: MigrationConstructor[], database: string, timezone?: string): Connection {
    const connection: Connection = new Connection('app', { database, migrations, timezone });

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
 * Read the records of a table directly, bypassing the query builder.
 */
async function records(connection: Connection, table: string): Promise<Record<string, unknown>[]> {
    const database: IDBDatabase = await connection.open();
    const transaction: IDBTransaction = database.transaction(table, 'readonly');
    const rows: Record<string, unknown>[] = await Request.settle(transaction.objectStore(table).getAll() as IDBRequest<Record<string, unknown>[]>);

    await new Promise<void>((resolve: () => void): void => {
        transaction.addEventListener('complete', resolve);
    });

    return rows;
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

afterEach((): void => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }

    vi.stubEnv('TZ', zone);
    vi.unstubAllEnvs();
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

/**
 * Migrate a users table holding the given rows, then alter it once with each given callback.
 */
async function altered(callbacks: ((table: Blueprint) => void)[], options: { rows: Record<string, unknown>[]; timezone?: string }): Promise<Connection> {
    const database: string = `connection-zoned-${++sequence}`;
    const first: Connection = connect([CreateIndexedUsersTable], database, options.timezone);

    await first.migrate();
    await seed(first, 'users', options.rows);

    first.disconnect();
    connections.splice(connections.indexOf(first), 1);

    const AlterUsersTable: MigrationConstructor = migration('AlterUsersTable', async (): Promise<void> => {
        for (const callback of callbacks) {
            await Schema.table('users', callback);
        }
    });

    const second: Connection = connect([CreateIndexedUsersTable, AlterUsersTable], database, options.timezone);

    await second.migrate();

    return second;
}

describe('Schema definitions IndexedDB cannot honor', (): void => {
    describe('with a date-only default', (): void => {
        /**
         * Add date columns defaulting to a date-only string and change another to one, on a connection set to the given timezone, and read what Alice holds.
         */
        async function backfilled(timezone?: string): Promise<{ connection: Connection; alice: Record<string, unknown> }> {
            const connection: Connection = await altered([(table: Blueprint): void => {
                table.date('joined').default('2024-01-15');
                table.datetime('seen').default('2024-01-15');
                table.date('left').nullable();
            }, (table: Blueprint): void => {
                table.date('left').nullable().default('2024-02-29').change();
            }], { rows: [{ email: 'a@x', name: 'Alice' }], timezone });

            const [alice]: Record<string, unknown>[] = await records(connection, 'users');

            return { connection, alice: alice as Record<string, unknown> };
        }

        test.each(Env.zones())('backfills the local day it names in %s on a local connection', async (timezone: string): Promise<void> => {
            Env.moveTo(timezone);

            const { connection, alice }: { connection: Connection; alice: Record<string, unknown> } = await backfilled('local');

            expect([alice['joined'], alice['seen'], alice['left']]).toEqual([new Date(2024, 0, 15), new Date(2024, 0, 15), new Date(2024, 1, 29)]);
            expect((await connection.getColumns('users')).find((column: ColumnSchema): boolean => column.name === 'joined')?.default).toEqual('2024-01-15');
        });

        test.each(Env.zones())('backfills midnight UTC by default and midnight in the migrating connection\'s timezone, with the process in %s', async (process: string): Promise<void> => {
            Env.moveTo(process);

            const utc: Record<string, unknown> = (await backfilled()).alice;
            const york: Record<string, unknown> = (await backfilled('America/New_York')).alice;

            expect([utc['joined'], utc['seen'], utc['left']]).toEqual([new Date('2024-01-15T00:00:00.000Z'), new Date('2024-01-15T00:00:00.000Z'), new Date('2024-02-29T00:00:00.000Z')]);
            expect([york['joined'], york['seen'], york['left']]).toEqual([new Date('2024-01-15T05:00:00.000Z'), new Date('2024-01-15T05:00:00.000Z'), new Date('2024-02-29T05:00:00.000Z')]);
        });
    });
});

describe('Schema.coerce', (): void => {
    const CreateVisitorsTable: MigrationConstructor = migration('CreateVisitorsTable', async (): Promise<void> => {
        await Schema.create('visitors', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('age');
            table.integer('visits').nullable();
            table.decimal('price').nullable();
            table.float('score').nullable();
            table.boolean('active').nullable();
            table.date('joined').nullable();
            table.enum('role', ['admin', 'member']).nullable();
            table.json('meta').nullable();
            table.string('code').nullable().unique();
            table.integer('rank').nullable().unique();
            table.string('label').nullable().unique().multiEntry();
        });
    });

    /**
     * Migrate a visitors table, plant the given rows past the package, then run a migration with the given up over them.
     */
    async function coerced(rows: Record<string, unknown>[], up: () => Promise<void>, options: { timezone?: string }): Promise<Connection> {
        const database: string = `connection-zoned-${++sequence}`;
        const first: Connection = connect([CreateVisitorsTable], database, options.timezone);

        await first.migrate();
        await seed(first, 'visitors', rows);

        first.disconnect();
        connections.splice(connections.indexOf(first), 1);

        const second: Connection = connect([CreateVisitorsTable, migration('CoerceVisitorsTable', up)], database, options.timezone);

        await second.migrate();

        return second;
    }

    /**
     * Coerce every declared column of the visitors table.
     */
    async function every(): Promise<void> {
        await Schema.coerce('visitors');
    }

    describe.each(Env.zones(['Asia/Tokyo']))('with the process in %s', (process: string): void => {
        test.each([
            [undefined, '2024-01-15T00:00:00.000Z'],
            ['America/New_York', '2024-01-15T05:00:00.000Z'],
        ])('reads a date-only string in the migrating connection\'s timezone, %s, whatever the process runs in', async (timezone: string | undefined, moment: string): Promise<void> => {
            Env.moveTo(process);

            const connection: Connection = await coerced([{ name: 'A', joined: '2024-01-15' }], every, { timezone });

            expect((await records(connection, 'visitors'))[0]?.['joined']).toEqual(new Date(moment));
        });
    });
});
