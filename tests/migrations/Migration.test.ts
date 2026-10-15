import { afterEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Migrator } from '../../src/migrations/Migrator';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import type { MigrationConstructor } from '../../src/migrations/types';

const connections: Connection[] = [];

let sequence: number = 0;

/**
 * Build a connection against a uniquely named database.
 */
function connect(migrations: MigrationConstructor[], database: string = `migration-${++sequence}`): Connection {
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
 * Build a migration that creates a table, inserts a row and creates a second table.
 */
function building(prefix: string, connection: () => Connection): MigrationConstructor {
    return migration(`Build${prefix}`, async (): Promise<void> => {
        await Schema.create(`${prefix}_one`, (table: Blueprint): void => {
            table.id();
            table.string('name');
        });

        await connection().table(`${prefix}_one`).insert({ name: prefix });

        await Schema.create(`${prefix}_two`, (table: Blueprint): void => {
            table.id();
        });
    });
}

/**
 * Describe how each open settled, naming the reason of one that rejected.
 */
function outcomes(results: PromiseSettledResult<IDBDatabase>[]): unknown[] {
    return results.map((result: PromiseSettledResult<IDBDatabase>): unknown => result.status === 'fulfilled' ? 'opened' : result.reason);
}

/**
 * Wait on a real timer, which ends the task the transaction was active in.
 */
function elsewhere(delay: number = 50): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, delay);
    });
}

afterEach((): void => {
    for (const connection of connections.splice(0)) {
        connection.disconnect();
    }
});

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class AddOAuthTokensToHTTPClients extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class AddV2ColumnsToUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class create_posts_table extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class Renamed extends Migration {
    /**
     * Get the name of the migration.
     */
    override name(): string {
        return 'create_posts_table';
    }

    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class Asynchronous extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Promise.resolve();
    }
}

describe('Migration', (): void => {
    test('names itself after its class in snake case', (): void => {
        expect(new CreateUsersTable().name()).toEqual('create_users_table');
    });

    test('keeps an acronym together when snake casing its class', (): void => {
        expect(new AddOAuthTokensToHTTPClients().name()).toEqual('add_o_auth_tokens_to_http_clients');
    });

    test('keeps a digit with the word before it when snake casing its class', (): void => {
        expect(new AddV2ColumnsToUsersTable().name()).toEqual('add_v2_columns_to_users_table');
    });

    test('leaves a class already in snake case alone', (): void => {
        expect(new create_posts_table().name()).toEqual('create_posts_table');
    });

    test('honours an overridden name', (): void => {
        expect(new Renamed().name()).toEqual('create_posts_table');
    });

    test('accepts a synchronous up', (): void => {
        expect(new CreateUsersTable().up()).toBeUndefined();
    });

    test('accepts an asynchronous up', async (): Promise<void> => {
        await expect(new Asynchronous().up()).resolves.toBeUndefined();
    });
});

describe('Migrating several databases at once', (): void => {
    test('runs each connection\'s migrations in its own database', async (): Promise<void> => {
        const first: Connection = connect([building('first', (): Connection => first)]);
        const second: Connection = connect([building('second', (): Connection => second)]);

        expect(outcomes(await Promise.allSettled([first.open(), second.open()]))).toEqual(['opened', 'opened']);
        expect((await first.tables()).sort()).toEqual(['first_one', 'first_two']);
        expect((await second.tables()).sort()).toEqual(['second_one', 'second_two']);
        expect(await first.table('first_one').pluck('name')).toEqual(['first']);
        expect(await second.table('second_one').pluck('name')).toEqual(['second']);
    }, 2000);

    test('opens a connection with nothing to migrate while another migrates', async (): Promise<void> => {
        const migrated: Connection = connect([building('first', (): Connection => migrated)]);

        await migrated.migrate();

        migrated.disconnect();

        let started!: () => void;
        let opened: boolean = false;
        let settled: boolean = false;

        const starting: Promise<void> = new Promise<void>((resolve: () => void): void => {
            started = resolve;
        });

        const busy: Connection = connect([migration('BusyMigration', async (): Promise<void> => {
            await Schema.create('busy', (table: Blueprint): void => {
                table.id();
            });

            started();

            const deadline: number = Date.now() + 1000;

            while (!opened && Date.now() < deadline) {
                await busy.table('busy').count();
            }
        })]);

        const migrating: Promise<string[]> = busy.migrate().finally((): void => {
            settled = true;
        });

        await starting;
        await migrated.open();

        opened = true;

        expect(settled).toEqual(false);
        expect(await migrating).toEqual(['BusyMigration']);
    }, 2000);

    test('migrates a second connection when the first one\'s migration fails', async (): Promise<void> => {
        const failing: Connection = connect([migration('FailingMigration', async (): Promise<void> => {
            await Schema.create('kept', (table: Blueprint): void => {
                table.id();
            });

            throw new Error('Nope.');
        })]);

        const second: Connection = connect([building('second', (): Connection => second)]);

        expect(outcomes(await Promise.allSettled([failing.open(), second.open()]))).toEqual([new Error('Nope.'), 'opened']);
        expect((await second.tables()).sort()).toEqual(['second_one', 'second_two']);
        expect(await second.table('second_one').pluck('name')).toEqual(['second']);
        expect(await connect([], failing.database).tables()).toEqual([]);
    }, 2000);

    test('starts the next upgrade only once a migration whose transaction aborted has stopped', async (): Promise<void> => {
        const steps: string[] = [];

        const aborted: Connection = connect([migration('AbortedMigration', async (): Promise<void> => {
            await Schema.create('duplicates', (table: Blueprint): void => {
                table.uuid('id').primary();
            });

            const store: IDBObjectStore = Migrator.alive().transaction.objectStore('duplicates');

            store.add({ id: 'same' });
            store.add({ id: 'same' });

            await elsewhere();

            steps.push('aborted');
        })]);

        const second: Connection = connect([migration('SecondMigration', async (): Promise<void> => {
            steps.push('second');

            await Schema.create('second', (table: Blueprint): void => {
                table.id();
            });
        })]);

        const results: PromiseSettledResult<IDBDatabase>[] = await Promise.allSettled([aborted.open(), second.open()]);

        expect(steps).toEqual(['aborted', 'second']);
        expect(outcomes(results)).toEqual([expect.any(DOMException), 'opened']);
        expect(await second.tables()).toEqual(['second']);
    }, 2000);
});
