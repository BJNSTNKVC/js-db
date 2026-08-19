import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { SchemaException } from '../../src/exceptions';
import type { Transaction } from '../../src/database/Transaction';
import type { TransactionRolledBack } from '../../src/events';

interface User {
    id: number;
    name: string;
    role: string;
}

interface Post {
    id: number;
    user_id: number;
    title: string;
}

class CreateTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('role').default('member');
        });

        await Schema.create('tags', (table: Blueprint): void => {
            table.uuid('slug').primary();
            table.string('label').unique();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id');
            table.string('title');
        });
    }
}

let connection: Connection;
let sequence: number = 0;

/**
 * Collect the database events dispatched while the callback runs.
 */
const recorded = async (types: string[], callback: () => Promise<unknown>): Promise<string[]> => {
    const seen: string[] = [];
    const listeners: [string, (event: Event) => void][] = types.map((type: string): [string, (event: Event) => void] => {
        const listener = (event: Event): void => {
            seen.push(event.type);
        };

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
};

beforeEach(async (): Promise<void> => {
    connection?.disconnect();

    connection = new Connection('app', { database: `transactions-${++sequence}`, migrations: [CreateTables] });

    await connection.migrate();
});

describe('Connection transaction', (): void => {
    test('commits writes across two tables together', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            const id: IDBValidKey = await transaction.table<User>('users').insertGetId({ name: 'Alice' });

            await transaction.table<Post>('posts').insert({ user_id: id as number, title: 'Hello' });
        });

        expect(await connection.table<User>('users').count()).toEqual(1);
        expect(await connection.table<Post>('posts').value('title')).toEqual('Hello');
    });

    test('returns the value the callback resolves to', async (): Promise<void> => {
        const id: IDBValidKey = await connection.transaction(async (transaction: Transaction): Promise<IDBValidKey> => {
            return transaction.table<User>('users').insertGetId({ name: 'Alice' });
        });

        expect(id).toEqual(1);
    });

    test('accepts a synchronous callback', async (): Promise<void> => {
        expect(await connection.transaction((): string => 'done')).toEqual('done');
    });

    test('rolls both writes back when the callback throws', async (): Promise<void> => {
        const failure: Error = new Error('Nope.');

        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await transaction.table<Post>('posts').insert({ user_id: 1, title: 'Hello' });

            throw failure;
        })).rejects.toBe(failure);

        expect(await connection.table<User>('users').count()).toEqual(0);
        expect(await connection.table<Post>('posts').count()).toEqual(0);
    });

    test('rethrows the original failure, not the abort', async (): Promise<void> => {
        await expect(connection.transaction(async (): Promise<void> => {
            throw new SchemaException('Something specific.');
        })).rejects.toThrow('Something specific.');
    });

    test('applies column defaults inside a narrowed transaction', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
        }, { tables: ['users'] });

        expect(await connection.table<User>('users').value('role')).toEqual('member');
    });

    test('scopes a narrowed transaction to the named tables', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            expect(transaction.tables).toEqual(['users']);
        }, { tables: ['users'] });
    });

    test('refuses a table outside a narrowed transaction', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            transaction.table<Post>('posts');
        }, { tables: ['users'] })).rejects.toThrow(new SchemaException('Table [posts] is outside the scope of this transaction.'));
    });

    test('scopes an unnarrowed transaction to every table', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            expect(transaction.tables.sort()).toEqual(['migrations', 'posts', 'schema', 'tags', 'users']);
        });
    });

    test('reads inside the transaction see its own uncommitted writes', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            expect(await transaction.table<User>('users').count()).toEqual(1);
        });
    });

    test('updates inside a transaction', async (): Promise<void> => {
        await connection.table<User>('users').insert({ name: 'Alice' });

        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').where('name', 'Alice').update({ role: 'owner' });
        });

        expect(await connection.table<User>('users').value('role')).toEqual('owner');
    });
});

describe('Connection nested transaction', (): void => {
    test('joins the transaction already running rather than deadlocking', async (): Promise<void> => {
        await connection.transaction(async (outer: Transaction): Promise<void> => {
            await outer.table<User>('users').insert({ name: 'Alice' });

            await connection.transaction(async (inner: Transaction): Promise<void> => {
                await inner.table<User>('users').insert({ name: 'Bob' });
            });
        });

        expect(await connection.table<User>('users').count()).toEqual(2);
    });

    test('rolls the whole transaction back when a nested call fails, having no savepoints', async (): Promise<void> => {
        await expect(connection.transaction(async (outer: Transaction): Promise<void> => {
            await outer.table<User>('users').insert({ name: 'Alice' });

            await connection.transaction(async (): Promise<void> => {
                throw new Error('Nope.');
            });
        })).rejects.toThrow('Nope.');

        expect(await connection.table<User>('users').count()).toEqual(0);
    });

    test('releases the active transaction so a later one can begin', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
        });

        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Bob' });
        });

        expect(await connection.table<User>('users').count()).toEqual(2);
    });

    test('releases the active transaction even after a failure', async (): Promise<void> => {
        await expect(connection.transaction(async (): Promise<void> => {
            throw new Error('Nope.');
        })).rejects.toThrow('Nope.');

        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
        });

        expect(await connection.table<User>('users').count()).toEqual(1);
    });
});

describe('Transaction events', (): void => {
    test('announces a commit', async (): Promise<void> => {
        const seen: string[] = await recorded(['db:transaction-beginning', 'db:transaction-committed', 'db:transaction-rolled-back'], async (): Promise<unknown> => {
            return connection.transaction(async (transaction: Transaction): Promise<void> => {
                await transaction.table<User>('users').insert({ name: 'Alice' });
            });
        });

        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
    });

    test('announces a rollback', async (): Promise<void> => {
        const seen: string[] = await recorded(['db:transaction-beginning', 'db:transaction-committed', 'db:transaction-rolled-back'], async (): Promise<unknown> => {
            return connection.transaction(async (): Promise<void> => {
                throw new Error('Nope.');
            });
        });

        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
    });

    test('carries the reason on a rollback', async (): Promise<void> => {
        const failure: Error = new Error('Nope.');
        let reason: unknown = null;

        Dispatcher.listen('db:transaction-rolled-back', ((event: TransactionRolledBack): void => {
            reason = event.reason;
        }) as (event: Event) => void, true);

        await expect(connection.transaction(async (): Promise<void> => {
            throw failure;
        })).rejects.toBe(failure);

        expect(reason).toBe(failure);
    });

    test('announces nothing extra for a nested call', async (): Promise<void> => {
        const seen: string[] = await recorded(['db:transaction-beginning', 'db:transaction-committed'], async (): Promise<unknown> => {
            return connection.transaction(async (): Promise<void> => {
                await connection.transaction(async (): Promise<void> => {
                    // Joining the outer transaction announces nothing of its own.
                });
            });
        });

        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
    });
});

describe('Transaction that outlives its request queue', (): void => {
    test('does not claim a rollback for a transaction that already committed', async (): Promise<void> => {
        const seen: string[] = await recorded(['db:transaction-committed', 'db:transaction-rolled-back'], async (): Promise<unknown> => {
            return connection.transaction(async (transaction: Transaction): Promise<void> => {
                await transaction.table<User>('users').insert({ name: 'Alice' });

                // Awaiting a timer lets the transaction commit, which is the documented hazard.
                await new Promise<void>((resolve): void => {
                    setTimeout(resolve, 5);
                });

                throw new Error('Too late.');
            });
        });

        expect(seen).toEqual([]);
    });

    test('still reports the failure to the caller', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            await new Promise<void>((resolve): void => {
                setTimeout(resolve, 5);
            });

            throw new Error('Too late.');
        })).rejects.toThrow('Too late.');
    });
});

describe('Transaction aborted by a failed request', (): void => {
    test('surfaces the request failure and rolls the transaction back', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });

            // The put violates the unique index on label, which aborts the transaction.
            await transaction.table('tags').upsert([{ slug: 'b', label: 'x' }], 'slug');
        })).rejects.toBeDefined();

        expect(await connection.table('tags').count()).toEqual(0);
    });
});
