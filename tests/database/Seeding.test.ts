import { beforeEach, describe, expect, test } from 'vitest';
import { DB } from '../../src/main';
import { Migration } from '../../src/migrations/Migration';
import { Seeder } from '../../src/seeders/Seeder';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { ConnectionNotConfiguredException } from '../../src/exceptions';
import type { SeederConstructor } from '../../src/seeders/types';
import type { Transaction } from '../../src/database/Transaction';
import type { SeedingEnded, SeederEnded, SeederStarted, SeedingStarted } from '../../src/main';

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
            table.string('name').unique();
            table.string('role').default('member');
        });
    }
}

class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        await DB.table<User>('users').insert([{ name: 'Alice' }, { name: 'Bob' }]);
    }
}

class RoleSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        await DB.table<User>('users').where('name', 'Alice').update({ role: 'admin' });
    }
}

let sequence: number = 0;
let database: string;

/**
 * Register a configuration with the given seeders.
 */
function configure(seeders: SeederConstructor[]): void {
    database = `seeding-${++sequence}`;

    DB.configure({
        default    : 'app',
        connections: {
            app: { database, migrations: [CreateUsersTable], seeders },
        },
    });
}

/**
 * Collect the database events dispatched while the callback runs.
 */
async function recorded(types: string[], callback: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const listeners: [string, (event: Event) => void][] = types.map((type: string): [string, (event: Event) => void] => {
        function listener(event: Event): void {
            seen.push(event.type);
        }

        Dispatcher.listen(type, listener);

        return [type, listener];
    });

    try {
        await callback();
    } catch {
        // The caller asserts on the failure itself; here only the events matter.
    }

    for (const [type, listener] of listeners) {
        Dispatcher.forget(type, listener);
    }

    return seen;
}

beforeEach((): void => {
    configure([UserSeeder]);
});

describe('DB.seed', (): void => {
    test('runs every registered seeder and reports their names', async (): Promise<void> => {
        configure([UserSeeder, RoleSeeder]);

        expect(await DB.seed('app')).toEqual(['UserSeeder', 'RoleSeeder']);
        expect(await DB.table<User>('users').count()).toEqual(2);
    });

    test('runs the seeders in the order they were registered', async (): Promise<void> => {
        configure([UserSeeder, RoleSeeder]);

        await DB.seed('app');

        expect(await DB.table<User>('users').where('name', 'Alice').value('role')).toEqual('admin');
    });

    test('migrates before it seeds, so the tables exist', async (): Promise<void> => {
        expect(await DB.seed('app')).toEqual(['UserSeeder']);
        expect(await DB.getTables()).toEqual(['users']);
    });

    test('reports nothing for a connection with no seeders', async (): Promise<void> => {
        configure([]);

        expect(await DB.seed('app')).toEqual([]);
    });

    test('runs again on a second call, leaving idempotency to the seeder', async (): Promise<void> => {
        // UserSeeder inserts against a unique index, so a second run collides rather than duplicating.
        await DB.seed('app');

        await expect(DB.seed('app')).rejects.toThrow(/Unique constraint/);
        expect(await DB.table<User>('users').count()).toEqual(2);
    });

    test('lets an idempotent seeder run repeatedly', async (): Promise<void> => {
        class IdempotentSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                await DB.table<User>('users').upsert([{ name: 'Alice' }], 'name');
            }
        }

        configure([IdempotentSeeder]);

        await DB.seed('app');
        await DB.seed('app');

        expect(await DB.table<User>('users').count()).toEqual(1);
    });

    test('requires the connection to be named', (): void => {
        expect(DB.seed.length).toEqual(1);
    });

    test('fails for a connection that is not configured', (): void => {
        expect((): Promise<string[]> => DB.seed('missing')).toThrow(new ConnectionNotConfiguredException('missing'));
    });

    test('propagates a failure from a seeder', async (): Promise<void> => {
        class FailingSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override run(): void {
                throw new Error('Nope.');
            }
        }

        configure([UserSeeder, FailingSeeder]);

        await expect(DB.seed('app')).rejects.toThrow('Nope.');

        // Seeding is not atomic across seeders, so the earlier one has already committed.
        expect(await DB.table<User>('users').count()).toEqual(2);
    });

    test('lets a seeder await work outside the database', async (): Promise<void> => {
        class NetworkSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                const fetched: string[] = await new Promise<string[]>((resolve: (value: string[]) => void): void => {
                    setTimeout((): void => resolve(['Carol']), 5);
                });

                await DB.table<User>('users').insert(fetched.map((name: string): Partial<User> => ({ name })));
            }
        }

        configure([NetworkSeeder]);

        expect(await DB.seed('app')).toEqual(['NetworkSeeder']);
        expect(await DB.table<User>('users').pluck<string>('name')).toEqual(['Carol']);
    });

    test('lets a seeder wrap its own writes in a transaction', async (): Promise<void> => {
        class TransactionalSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                await DB.transaction(async (transaction: Transaction): Promise<void> => {
                    await transaction.table<User>('users').insert({ name: 'Alice' });
                    await transaction.table<User>('users').insert({ name: 'Bob' });
                });
            }
        }

        configure([TransactionalSeeder]);

        await DB.seed('app');

        expect(await DB.table<User>('users').count()).toEqual(2);
    });

    test('seeds a named connection other than the default', async (): Promise<void> => {
        DB.configure({
            default    : 'app',
            connections: {
                app      : { database: `seeding-app-${++sequence}`, migrations: [CreateUsersTable] },
                reporting: { database: `seeding-reporting-${sequence}`, migrations: [CreateUsersTable], seeders: [UserSeeder] },
            },
        });

        expect(await DB.seed('reporting')).toEqual(['UserSeeder']);
        expect(await DB.connection('reporting').table<User>('users').count()).toEqual(2);
        expect(await DB.table<User>('users').count()).toEqual(0);
    });
});

describe('Seeding events', (): void => {
    test('announces the run', async (): Promise<void> => {
        configure([UserSeeder, RoleSeeder]);

        const seen: string[] = await recorded([
            'db:seeding-started',
            'db:seeder-started',
            'db:seeder-ended',
            'db:seeding-ended',
        ], async (): Promise<unknown> => DB.seed('app'));

        expect(seen).toEqual([
            'db:seeding-started',
            'db:seeder-started',
            'db:seeder-ended',
            'db:seeder-started',
            'db:seeder-ended',
            'db:seeding-ended',
        ]);
    });

    test('announces nothing for a connection with no seeders', async (): Promise<void> => {
        configure([]);

        const seen: string[] = await recorded([
            'db:seeding-started',
            'db:seeding-ended',
        ], async (): Promise<unknown> => DB.seed('app'));

        expect(seen).toEqual([]);
    });

    test('names the seeders on the run events', async (): Promise<void> => {
        const names: string[] = [];
        const seeders: string[][] = [];

        DB.onSeedingStarted((event: SeedingStarted): void => {
            seeders.push(event.seeders);
        }, { once: true });

        DB.onSeederStarted((event: SeederStarted): void => {
            names.push(event.seeder);
        }, { once: true });

        DB.onSeederEnded((event: SeederEnded): void => {
            names.push(event.seeder);
        }, { once: true });

        DB.onSeedingEnded((event: SeedingEnded): void => {
            seeders.push(event.seeders);
        }, { once: true });

        await DB.seed('app');

        expect(names).toEqual(['UserSeeder', 'UserSeeder']);
        expect(seeders).toEqual([['UserSeeder'], ['UserSeeder']]);
    });

    test('does not announce the end when a seeder fails', async (): Promise<void> => {
        class FailingSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override run(): void {
                throw new Error('Nope.');
            }
        }

        configure([FailingSeeder]);

        const seen: string[] = await recorded([
            'db:seeding-started',
            'db:seeding-ended',
        ], async (): Promise<unknown> => DB.seed('app'));

        expect(seen).toEqual(['db:seeding-started']);
    });
});

describe('DB.fresh with seeding', (): void => {
    test('replays the migrations without seeding by default', async (): Promise<void> => {
        await DB.seed('app');

        expect(await DB.fresh('app')).toEqual(['CreateUsersTable']);
        expect(await DB.table<User>('users').count()).toEqual(0);
    });

    test('seeds when asked to', async (): Promise<void> => {
        await DB.seed('app');

        expect(await DB.fresh('app', { seed: true })).toEqual(['CreateUsersTable']);
        expect(await DB.table<User>('users').count()).toEqual(2);
    });

    test('seeds a connection with no seeders without complaint', async (): Promise<void> => {
        configure([]);

        expect(await DB.fresh('app', { seed: true })).toEqual(['CreateUsersTable']);
        expect(await DB.table<User>('users').count()).toEqual(0);
    });
});

describe('Default connection while seeding', (): void => {
    /**
     * Register two connections, with the seeders on the one that is not the default.
     */
    function pair(seeders: SeederConstructor[]): void {
        const suffix: number = ++sequence;

        DB.configure({
            default    : 'app',
            connections: {
                app      : { database: `scoped-app-${suffix}`, migrations: [CreateUsersTable] },
                reporting: { database: `scoped-reporting-${suffix}`, migrations: [CreateUsersTable], seeders },
            },
        });
    }

    test('stands the seeded connection in as the default', async (): Promise<void> => {
        const seen: string[] = [];

        class ReportingSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override run(): void {
                seen.push(DB.connection().name);
            }
        }

        pair([ReportingSeeder]);

        await DB.seed('reporting');

        expect(seen).toEqual(['reporting']);
    });

    test('restores the configured default afterwards', async (): Promise<void> => {
        pair([UserSeeder]);

        await DB.seed('reporting');

        expect(DB.connection().name).toEqual('app');
    });

    test('restores the configured default even when a seeder fails', async (): Promise<void> => {
        class FailingSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override run(): void {
                throw new Error('Nope.');
            }
        }

        pair([FailingSeeder]);

        await expect(DB.seed('reporting')).rejects.toThrow('Nope.');

        expect(DB.connection().name).toEqual('app');
    });

    test('lets a seeder name a connection explicitly, overriding the stand in', async (): Promise<void> => {
        class CrossSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                await DB.connection('app').table<User>('users').insert({ name: 'Alice' });
            }
        }

        pair([CrossSeeder]);

        await DB.seed('reporting');

        expect(await DB.connection('app').table<User>('users').count()).toEqual(1);
        expect(await DB.connection('reporting').table<User>('users').count()).toEqual(0);
    });

    test('nests, so an inner run restores the outer stand in', async (): Promise<void> => {
        const seen: string[] = [];

        class InnerSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override run(): void {
                seen.push(DB.connection().name);
            }
        }

        class OuterSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                seen.push(DB.connection().name);

                await DB.seed('app');

                seen.push(DB.connection().name);
            }
        }

        const suffix: number = ++sequence;

        DB.configure({
            default    : 'app',
            connections: {
                app      : { database: `nested-app-${suffix}`, migrations: [CreateUsersTable], seeders: [InnerSeeder] },
                reporting: { database: `nested-reporting-${suffix}`, migrations: [CreateUsersTable], seeders: [OuterSeeder] },
            },
        });

        await DB.seed('reporting');

        expect(seen).toEqual(['reporting', 'app', 'reporting']);
    });
});

describe('One seeder registered on two connections', (): void => {
    test('resolves to whichever connection is being seeded', async (): Promise<void> => {
        const seen: string[] = [];

        class SharedSeeder extends Seeder {
            /**
             * Seed the database.
             */
            override async run(): Promise<void> {
                seen.push(DB.connection().name);

                await DB.table<User>('users').insert({ name: 'Alice' });
            }
        }

        const suffix: number = ++sequence;

        DB.configure({
            default    : 'app',
            connections: {
                app      : { database: `shared-app-${suffix}`, migrations: [CreateUsersTable], seeders: [SharedSeeder] },
                reporting: { database: `shared-reporting-${suffix}`, migrations: [CreateUsersTable], seeders: [SharedSeeder] },
            },
        });

        await DB.seed('app');
        await DB.seed('reporting');

        expect(seen).toEqual(['app', 'reporting']);
        expect(await DB.connection('app').table<User>('users').count()).toEqual(1);
        expect(await DB.connection('reporting').table<User>('users').count()).toEqual(1);
    });
});
