import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DB } from '../../src/main';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { ConnectionNotConfiguredException } from '../../src/exceptions';
import type { Connection } from '../../src/database/Connection';
import type { QueryExecuted } from '../../src/events';
import type { MigrationStatus } from '../../src/migrations/types';
import type { QueryLogEntry } from '../../src/database/types';
import type { Transaction } from '../../src/database/Transaction';
import type { ColumnSchema } from '../../src/main';

interface User {
    id: number;
    name: string;
    role: string;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('role').default('member');
        });
    }
}

class CreateReportsTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('reports', (table: Blueprint): void => {
            table.id();
            table.string('title');
        });
    }
}

let sequence: number = 0;

/**
 * Register a configuration against uniquely named databases.
 */
function configure(): void {
    const suffix: number = ++sequence;

    DB.configure({
        default    : 'app',
        connections: {
            app      : { database: `manager-app-${suffix}`, migrations: [CreateUsersTable] },
            reporting: { database: `manager-reporting-${suffix}`, migrations: [CreateReportsTable] },
        },
    });
}

beforeEach((): void => {
    configure();
});

afterEach((): void => {
    DB.disableQueryLog();
    DB.flushQueryLog();
});

describe('DB.configure', (): void => {
    test('replaces a prior configuration', async (): Promise<void> => {
        const first: Connection = DB.connection();

        configure();

        expect(DB.connection()).not.toBe(first);
    });

    test('fails to resolve a connection before anything is configured', (): void => {
        DB.configure({ default: 'app', connections: {} });

        expect((): Connection => DB.connection()).toThrow(new ConnectionNotConfiguredException('app'));
    });
});

describe('DB.connection', (): void => {
    test('resolves the default connection', (): void => {
        expect(DB.connection().name).toEqual('app');
    });

    test('resolves a named connection', (): void => {
        expect(DB.connection('reporting').name).toEqual('reporting');
    });

    test('caches the connection it resolved', (): void => {
        expect(DB.connection()).toBe(DB.connection('app'));
    });

    test('fails for a name that is not configured', (): void => {
        expect((): Connection => DB.connection('missing')).toThrow(new ConnectionNotConfiguredException('missing'));
    });
});

describe('DB delegation', (): void => {
    test('queries the default connection', async (): Promise<void> => {
        await DB.migrate('app');
        await DB.table<User>('users').insert({ name: 'Alice' });

        expect(await DB.table<User>('users').count()).toEqual(1);
    });

    test('runs a transaction on the default connection', async (): Promise<void> => {
        await DB.migrate('app');

        await DB.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
        });

        expect(await DB.table<User>('users').count()).toEqual(1);
    });

    test('narrows a transaction on the default connection', async (): Promise<void> => {
        await DB.migrate('app');

        await DB.transaction(async (transaction: Transaction): Promise<void> => {
            expect(transaction.tables).toEqual(['users']);
        }, { tables: ['users'] });
    });

    test('migrates only the connection it was named', async (): Promise<void> => {
        expect(await DB.migrate('app')).toEqual(['create_users_table']);
        expect(await DB.status('reporting')).toEqual([{ migration: 'create_reports_table', ran: false, at: null }]);
    });

    test('migrates a second connection when named', async (): Promise<void> => {
        expect(await DB.migrate('reporting')).toEqual(['create_reports_table']);
    });

    test('declares the connection name as required', (): void => {
        expect(DB.migrate.length).toEqual(1);
    });

    test('fails for a connection that is not configured', (): void => {
        expect((): Promise<string[]> => DB.migrate('missing')).toThrow(new ConnectionNotConfiguredException('missing'));
    });

    test('reports the status of the default connection', async (): Promise<void> => {
        await DB.migrate('app');

        const status: MigrationStatus[] = await DB.status('app');

        expect(status.map((entry: MigrationStatus): string => entry.migration)).toEqual(['create_users_table']);
    });

    test('refreshes the default connection', async (): Promise<void> => {
        await DB.migrate('app');
        await DB.table<User>('users').insert({ name: 'Alice' });

        expect(await DB.fresh('app')).toEqual(['create_users_table']);
        expect(await DB.table<User>('users').count()).toEqual(0);
    });
});

describe('DB schema information', (): void => {
    beforeEach(async (): Promise<void> => {
        await DB.migrate('app');
    });

    test('reports that a table exists', async (): Promise<void> => {
        expect(await DB.hasTable('users')).toEqual(true);
        expect(await DB.hasTable('missing')).toEqual(false);
    });

    test('reports that a column exists', async (): Promise<void> => {
        expect(await DB.hasColumn('users', 'name')).toEqual(true);
        expect(await DB.hasColumn('users', 'missing')).toEqual(false);
    });

    test('lists the tables', async (): Promise<void> => {
        expect(await DB.getTables()).toEqual(['users']);
    });

    test('lists the columns', async (): Promise<void> => {
        expect((await DB.getColumns('users')).map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name', 'role']);
    });

    test('lists the indexes', async (): Promise<void> => {
        expect(await DB.getIndexes('users')).toEqual([]);
    });

    test('reads a named connection', async (): Promise<void> => {
        await DB.migrate('reporting');

        expect(await DB.hasTable('reports', 'reporting')).toEqual(true);
        expect(await DB.hasColumn('reports', 'title', 'reporting')).toEqual(true);
        expect(await DB.getTables('reporting')).toEqual(['reports']);
        expect((await DB.getColumns('reports', 'reporting')).map((column: ColumnSchema): string => column.name)).toEqual(['id', 'title']);
        expect(await DB.getIndexes('reports', 'reporting')).toEqual([]);
    });
});

describe('Schema facade reads', (): void => {
    beforeEach(async (): Promise<void> => {
        await DB.migrate('app');
    });

    test('reports that a table exists', async (): Promise<void> => {
        expect(await Schema.hasTable('users')).toEqual(true);
    });

    test('reports that a column exists', async (): Promise<void> => {
        expect(await Schema.hasColumn('users', 'role')).toEqual(true);
    });

    test('lists the tables', async (): Promise<void> => {
        expect(await Schema.getTables()).toEqual(['users']);
    });

    test('lists the columns', async (): Promise<void> => {
        expect((await Schema.getColumns('users')).map((column: ColumnSchema): string => column.name)).toEqual(['id', 'name', 'role']);
    });

    test('lists the indexes', async (): Promise<void> => {
        expect(await Schema.getIndexes('users')).toEqual([]);
    });

    test('reads through a named connection', async (): Promise<void> => {
        await DB.migrate('reporting');

        expect(await Schema.connection('reporting').hasTable('reports')).toEqual(true);
    });
});

describe('DB.disconnect and DB.purge', (): void => {
    test('reopens after a disconnect, keeping the same connection', async (): Promise<void> => {
        await DB.migrate('app');

        const connection: Connection = DB.connection();

        DB.disconnect('app');

        expect(DB.connection()).toBe(connection);
        expect(await DB.table<User>('users').count()).toEqual(0);
    });

    test('rebuilds the connection after a purge', async (): Promise<void> => {
        await DB.migrate('app');

        const connection: Connection = DB.connection();

        DB.purge('app');

        expect(DB.connection()).not.toBe(connection);
    });

    test('purges a named connection', async (): Promise<void> => {
        const connection: Connection = DB.connection('reporting');

        DB.purge('reporting');

        expect(DB.connection('reporting')).not.toBe(connection);
        expect(DB.connection()).toBe(DB.connection('app'));
    });
});

describe('DB.listen', (): void => {
    test('keeps a listener registered across events', async (): Promise<void> => {
        const seen: string[] = [];
        function listener(event: QueryExecuted): void {
            seen.push(event.plan);
        }

        DB.listen('query', listener);

        await DB.migrate('app');
        await DB.table<User>('users').count();
        await DB.table<User>('users').count();

        DB.forget('query', listener);

        expect(seen).toHaveLength(2);
    });

    test('drops a once listener after the first event', async (): Promise<void> => {
        const seen: string[] = [];

        DB.listen('query', (event: QueryExecuted): void => {
            seen.push(event.plan);
        }, { once: true });

        await DB.migrate('app');
        await DB.table<User>('users').count();
        await DB.table<User>('users').count();

        expect(seen).toHaveLength(1);
    });

    test('stops delivering to a forgotten listener', async (): Promise<void> => {
        let count: number = 0;
        function listener(): void {
            count++;
        }

        DB.listen('query', listener);
        DB.forget('query', listener);

        await DB.migrate('app');
        await DB.table<User>('users').count();

        expect(count).toEqual(0);
    });

    test.each([
        ['onQueryExecuted', 'query'],
        ['onTransactionBeginning', 'transaction-beginning'],
        ['onTransactionCommitted', 'transaction-committed'],
        ['onTransactionRolledBack', 'transaction-rolled-back'],
        ['onMigrationsStarted', 'migrations-started'],
        ['onMigrationStarted', 'migration-started'],
        ['onMigrationEnded', 'migration-ended'],
        ['onMigrationsEnded', 'migrations-ended'],
        ['onNoPendingMigrations', 'no-pending-migrations'],
        ['onDatabaseBlocked', 'database-blocked'],
    ])('registers a listener through %s', (method: string, event: string): void => {
        const seen: string[] = [];

        const register: (listener: (received: Event) => void, options?: unknown) => void = (DB as unknown as Record<string, (listener: (received: Event) => void, options?: unknown) => void>)[method] as (listener: (received: Event) => void, options?: unknown) => void;

        register.call(DB, (received: Event): void => {
            seen.push(received.type);
        }, { once: true });

        Dispatcher.dispatch(new Event(`db:${event}`));

        expect(seen).toEqual([`db:${event}`]);
    });

    test('registers a persistent listener through the sugar by default', (): void => {
        let count: number = 0;

        DB.onQueryExecuted((): void => {
            count++;
        });

        Dispatcher.dispatch(new Event('db:query'));
        Dispatcher.dispatch(new Event('db:query'));

        expect(count).toEqual(2);
    });
});

describe('DB query log', (): void => {
    test('records nothing until it is enabled', async (): Promise<void> => {
        await DB.migrate('app');
        await DB.table<User>('users').count();

        expect(DB.getQueryLog()).toEqual([]);
        expect(DB.logging()).toEqual(false);
    });

    test('records the queries that run while enabled', async (): Promise<void> => {
        await DB.migrate('app');

        DB.enableQueryLog();

        await DB.table<User>('users').insert({ name: 'Alice' });
        await DB.table<User>('users').count();

        const log: QueryLogEntry[] = DB.getQueryLog();

        expect(DB.logging()).toEqual(true);
        expect(log.map((entry: QueryLogEntry): string => entry.plan)).toEqual(['insert', 'scan']);
        expect(log[0]).toEqual({
            connection: 'app',
            table     : 'users',
            plan      : 'insert',
            duration  : expect.any(Number),
            records   : 1,
        });
    });

    test('is idempotent when enabled twice', async (): Promise<void> => {
        await DB.migrate('app');

        DB.enableQueryLog();
        DB.enableQueryLog();

        await DB.table<User>('users').count();

        expect(DB.getQueryLog()).toHaveLength(1);
    });

    test('stops recording once disabled', async (): Promise<void> => {
        await DB.migrate('app');

        DB.enableQueryLog();
        DB.disableQueryLog();

        await DB.table<User>('users').count();

        expect(DB.getQueryLog()).toEqual([]);
        expect(DB.logging()).toEqual(false);
    });

    test('is idempotent when disabled twice', (): void => {
        DB.disableQueryLog();
        DB.disableQueryLog();

        expect(DB.logging()).toEqual(false);
    });

    test('empties the log when flushed', async (): Promise<void> => {
        await DB.migrate('app');

        DB.enableQueryLog();

        await DB.table<User>('users').count();

        DB.flushQueryLog();

        expect(DB.getQueryLog()).toEqual([]);
    });

    test('hands out a copy of the log', async (): Promise<void> => {
        await DB.migrate('app');

        DB.enableQueryLog();

        await DB.table<User>('users').count();

        DB.getQueryLog().length = 0;

        expect(DB.getQueryLog()).toHaveLength(1);
    });
});
