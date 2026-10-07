import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { QuotaExceededException, SchemaException, TransactionClosedException, UniqueConstraintViolationException } from '../../src/exceptions';
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

const EVENTS: string[] = ['db:transaction-beginning', 'db:transaction-committed', 'db:transaction-rolled-back'];

const CALLS: [string, (transaction: Transaction) => Promise<unknown>][] = [
    ['get', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').get()],
    ['first', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').first()],
    ['find', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').find(1)],
    ['count', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').where('name', 'Alice').count()],
    ['exists', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').exists()],
    ['pluck', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').pluck('name')],
    ['value', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').value('name')],
    ['sum', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').sum('id')],
    ['max', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').max('id')],
    ['explain', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').explain()],
    ['paginate', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').paginate(1, 10)],
    ['chunk', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').chunk(10, (): void => {})],
    ['lazy', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').lazy(10).next()],
    ['each', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').each((): void => {})],
    ['a grouping', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').groupBy('role').get()],
    ['a joined read', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').join('posts', 'users.id', '=', 'posts.user_id').get()],
    ['a joined count', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').join('posts', 'users.id', '=', 'posts.user_id').count()],
    ['insert', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').insert({ name: 'Alice' })],
    ['insertGetId', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').insertGetId({ name: 'Alice' })],
    ['insertOrIgnore', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').insertOrIgnore({ name: 'Alice' })],
    ['update', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').where('name', 'Alice').update({ role: 'owner' })],
    ['increment', (transaction: Transaction): Promise<unknown> => transaction.table<Post>('posts').increment('user_id')],
    ['delete', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').where('name', 'Alice').delete()],
    ['upsert', (transaction: Transaction): Promise<unknown> => transaction.table('tags').upsert([{ slug: 'a', label: 'x' }], 'slug')],
    ['updateOrInsert', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').updateOrInsert({ name: 'Alice' }, { role: 'owner' })],
    ['truncate', (transaction: Transaction): Promise<unknown> => transaction.table<User>('users').truncate()],
    ['a joined update', (transaction: Transaction): Promise<unknown> => transaction.table<Post>('posts').join('users', 'users.id', '=', 'posts.user_id').where('users.name', 'Alice').update({ title: 'Hello' })],
    ['a joined delete', (transaction: Transaction): Promise<unknown> => transaction.table<Post>('posts').join('users', 'users.id', '=', 'posts.user_id').where('users.name', 'Alice').delete()],
];

let connection: Connection;
let sequence: number = 0;

/**
 * Wait on a timer, as a callback awaiting work outside the package would.
 */
function elsewhere(): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 5);
    });
}

/**
 * Make every transaction refuse requests from now on, as a browser's does once its callback awaits outside work, and refuse its abort too unless told it is not yet committing.
 */
function deactivate(committing: boolean = true): void {
    const get: IDBObjectStore['get'] = IDBObjectStore.prototype.get;

    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
        if (query === undefined) {
            throw new DOMException('The transaction is not active.', 'TransactionInactiveError');
        }

        return get.call(this, query);
    });

    if (committing) {
        vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation((): void => {
            throw new DOMException('The transaction is committing.', 'InvalidStateError');
        });
    }
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

/**
 * Run a transaction, returning the reason it rejects with and the transaction events it dispatches.
 */
async function rejected(callback: (transaction: Transaction) => Promise<unknown>): Promise<[unknown, string[]]> {
    let reason: unknown = null;

    const seen: string[] = await recorded(EVENTS, async (): Promise<void> => {
        try {
            await connection.transaction(callback);
        } catch (error: unknown) {
            reason = error;
        }
    });

    return [reason, seen];
}

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

    test('announces a rollback for a violated unique index', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });
            await transaction.table('tags').insert({ slug: 'b', label: 'x' });
        });

        expect(reason).toBeInstanceOf(UniqueConstraintViolationException);
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

    test('announces a commit the platform refuses as a rollback', async (): Promise<void> => {
        const open: IDBDatabase['transaction'] = IDBDatabase.prototype.transaction;
        let handle: IDBTransaction | null = null;

        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...parameters: Parameters<IDBDatabase['transaction']>): IDBTransaction {
            handle = open.apply(this, parameters);

            return handle;
        });

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            queueMicrotask((): void => {
                Object.defineProperty(handle, 'error', { value: new DOMException('Full.', 'QuotaExceededError') });

                (handle as unknown as IDBTransaction).abort();
            });
        });

        vi.restoreAllMocks();

        expect(reason).toBeInstanceOf(QuotaExceededException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(await connection.table<User>('users').count()).toEqual(0);
    });

    test('announces nothing extra for a nested call', async (): Promise<void> => {
        const seen: string[] = await recorded(['db:transaction-beginning', 'db:transaction-committed'], async (): Promise<unknown> => {
            return connection.transaction(async (): Promise<void> => {
                await connection.transaction(async (): Promise<void> => {});
            });
        });

        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
    });
});

describe('Transaction that closed early', (): void => {
    afterEach((): void => {
        vi.restoreAllMocks();
    });

    test('reports the close and keeps the work committed before it', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere();
            await transaction.table<User>('users').insert({ name: 'Bob' });
        });

        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    });

    test('throws from the next call inside the callback, and rejects even when the callback catches it', async (): Promise<void> => {
        let caught: unknown = null;

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere();

            try {
                await transaction.table<User>('users').insert({ name: 'Bob' });
            } catch (error: unknown) {
                caught = error;
            }

            return 'done';
        });

        expect(caught).toBeInstanceOf(TransactionClosedException);
        expect(caught).toEqual(new TransactionClosedException('app'));
        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
    });

    test('rejects once the callback settles, though it made no further call', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere();

            return 'done';
        });

        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    });

    test('carries an error the callback throws after the close as its cause', async (): Promise<void> => {
        const failure: Error = new Error('Too late.');

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere();

            throw failure;
        });

        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect((reason as Error).cause).toBe(failure);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    });

    test.each(CALLS)('refuses %s through the closed transaction', async (_: string, call: (transaction: Transaction) => Promise<unknown>): Promise<void> => {
        let caught: unknown = null;

        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await elsewhere();

            try {
                await call(transaction);
            } catch (error: unknown) {
                caught = error;
            }
        })).rejects.toBeInstanceOf(TransactionClosedException);

        expect(caught).toBeInstanceOf(TransactionClosedException);
        expect(caught).toEqual(new TransactionClosedException('app'));
    });

    test('refuses the next page of a chunk whose callback awaited outside work', async (): Promise<void> => {
        await connection.table<User>('users').insert([{ name: 'Alice' }, { name: 'Bob' }]);

        const pages: number[] = [];

        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').chunk(1, async (_: User[], page: number): Promise<void> => {
                pages.push(page);

                await elsewhere();
            });
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(pages).toEqual([1]);
    });

    test('refuses the next page of a lazy walk whose consumer awaited outside work', async (): Promise<void> => {
        await connection.table<User>('users').insert([{ name: 'Alice' }, { name: 'Bob' }]);

        const names: string[] = [];

        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            for await (const user of transaction.table<User>('users').lazy(1)) {
                names.push(user.name);

                await elsewhere();
            }
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(names).toEqual(['Alice']);
    });

    test('refuses a nested call made after the close', async (): Promise<void> => {
        let caught: unknown = null;

        await expect(connection.transaction(async (): Promise<void> => {
            await elsewhere();

            try {
                await connection.transaction(async (inner: Transaction): Promise<number> => inner.table<User>('users').insert({ name: 'Alice' }));
            } catch (error: unknown) {
                caught = error;
            }
        })).rejects.toBeInstanceOf(TransactionClosedException);

        expect(caught).toEqual(new TransactionClosedException('app'));
        expect(await connection.table<User>('users').count()).toEqual(0);
    });

    test('refuses a transaction kept past its call', async (): Promise<void> => {
        let kept: Transaction | null = null;

        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            kept = transaction;

            await transaction.table<User>('users').insert({ name: 'Alice' });
        });

        await expect((kept as unknown as Transaction).table<User>('users').get()).rejects.toThrow(new TransactionClosedException('app'));
    });

    test('reports a transaction the platform is still committing when the callback fails as closed', async (): Promise<void> => {
        const failure: Error = new Error('Too late.');

        vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation((): void => {
            throw new DOMException('The transaction is committing.', 'InvalidStateError');
        });

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            throw failure;
        });

        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect((reason as Error).cause).toBe(failure);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    });

    test('leaves the connection free for a later transaction', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await elsewhere();
            await transaction.table<User>('users').insert({ name: 'Alice' });
        })).rejects.toBeInstanceOf(TransactionClosedException);

        const seen: string[] = await recorded(EVENTS, async (): Promise<unknown> => {
            return connection.transaction(async (transaction: Transaction): Promise<void> => {
                await transaction.table<User>('users').insert({ name: 'Bob' });
            });
        });

        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Bob']);
    });
});

describe('Transaction that went inactive before it completed', (): void => {
    afterEach((): void => {
        vi.restoreAllMocks();
    });

    test('reports the close from the next query and keeps the work committed before it', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            deactivate();

            await transaction.table<User>('users').insert({ name: 'Bob' });
        });

        vi.restoreAllMocks();

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);

    test('rejects even when the callback catches the error', async (): Promise<void> => {
        let caught: unknown = null;

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            deactivate();

            try {
                await transaction.table<User>('users').insert({ name: 'Bob' });
            } catch (error: unknown) {
                caught = error;
            }

            return 'done';
        });

        vi.restoreAllMocks();

        expect(caught).toEqual(new TransactionClosedException('app'));
        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);

    test('rejects once the callback settles, though it made no further call', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            deactivate();

            return 'done';
        });

        vi.restoreAllMocks();

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);

    test.each(CALLS)('refuses %s through a transaction that went inactive', async (_: string, call: (transaction: Transaction) => Promise<unknown>): Promise<void> => {
        let caught: unknown = null;

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            deactivate();

            try {
                await call(transaction);
            } catch (error: unknown) {
                caught = error;
            }
        });

        expect(caught).toEqual(new TransactionClosedException('app'));
        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
    }, 2000);

    test('refuses the next page of a chunk whose callback let the transaction go inactive', async (): Promise<void> => {
        await connection.table<User>('users').insert([{ name: 'Alice' }, { name: 'Bob' }]);

        const pages: number[] = [];

        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').chunk(1, (_: User[], page: number): void => {
                pages.push(page);

                deactivate();
            });
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(pages).toEqual([1]);
    }, 2000);

    test('refuses the next page of a lazy walk whose consumer let the transaction go inactive', async (): Promise<void> => {
        await connection.table<User>('users').insert([{ name: 'Alice' }, { name: 'Bob' }]);

        const names: string[] = [];

        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            for await (const user of transaction.table<User>('users').lazy(1)) {
                names.push(user.name);

                deactivate();
            }
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(names).toEqual(['Alice']);
    }, 2000);

    test('refuses a nested call made after the transaction went inactive', async (): Promise<void> => {
        let caught: unknown = null;

        const [reason]: [unknown, string[]] = await rejected(async (): Promise<void> => {
            deactivate();

            try {
                await connection.transaction(async (inner: Transaction): Promise<number> => inner.table<User>('users').insert({ name: 'Alice' }));
            } catch (error: unknown) {
                caught = error;
            }
        });

        vi.restoreAllMocks();

        expect(caught).toEqual(new TransactionClosedException('app'));
        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(await connection.table<User>('users').count()).toEqual(0);
    }, 2000);

    test('refuses a builder made before the transaction went inactive', async (): Promise<void> => {
        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            const users: ReturnType<Transaction['table']> = transaction.table('users');

            deactivate();

            await users.get();
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
    }, 2000);

    test('rolls back a transaction that went inactive while it could still abort', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            deactivate(false);

            await transaction.table<User>('users').insert({ name: 'Bob' });
        });

        vi.restoreAllMocks();

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(await connection.table<User>('users').count()).toEqual(0);
    }, 2000);

    test('rolls back a commit the browser refuses after the transaction went inactive', async (): Promise<void> => {
        const open: IDBDatabase['transaction'] = IDBDatabase.prototype.transaction;
        const abort: IDBTransaction['abort'] = IDBTransaction.prototype.abort;
        const get: IDBObjectStore['get'] = IDBObjectStore.prototype.get;
        let handle: IDBTransaction | null = null;
        let inactive: boolean = false;

        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...parameters: Parameters<IDBDatabase['transaction']>): IDBTransaction {
            handle = open.apply(this, parameters);

            return handle;
        });

        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
            if (query === undefined && inactive) {
                queueMicrotask((): void => {
                    Object.defineProperty(handle, 'error', { value: new DOMException('Full.', 'QuotaExceededError') });

                    abort.call(handle as unknown as IDBTransaction);
                });

                throw new DOMException('The transaction is not active.', 'TransactionInactiveError');
            }

            return get.call(this, query);
        });

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });

            inactive = true;
        });

        vi.restoreAllMocks();

        expect(reason).toBeInstanceOf(QuotaExceededException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(await connection.table<User>('users').count()).toEqual(0);
    }, 2000);

    test('checks a transaction still in use without disturbing it, and again once the callback settles', async (): Promise<void> => {
        const get: IDBObjectStore['get'] = IDBObjectStore.prototype.get;
        const steps: string[] = [];

        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
            if (query !== undefined) {
                steps.push('get');

                return get.call(this, query);
            }

            try {
                return get.call(this, query);
            } catch (error: unknown) {
                steps.push(`check: ${(error as DOMException).name}`);

                throw error;
            }
        });

        const seen: string[] = await recorded(EVENTS, async (): Promise<unknown> => {
            return connection.transaction(async (transaction: Transaction): Promise<void> => {
                steps.push('insert');

                await transaction.table<User>('users').insert({ name: 'Alice' });

                steps.push('find');

                await transaction.table<User>('users').find(1);

                steps.push('settle');
            });
        });

        expect(steps).toEqual(['insert', 'check: DataError', 'find', 'check: DataError', 'get', 'settle', 'check: DataError']);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await connection.table<User>('users').pluck('name')).toEqual(['Alice']);
    });

    test('makes no check once the transaction has completed', async (): Promise<void> => {
        const read: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'get');

        const [reason]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere();

            read.mockClear();
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(read).not.toHaveBeenCalled();
    });

    test('makes no check once the transaction has aborted', async (): Promise<void> => {
        const read: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'get');

        vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore): IDBRequest<undefined> {
            return this.add({ slug: 'a', label: 'y' }) as IDBRequest<unknown> as IDBRequest<undefined>;
        });

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });

            try {
                await transaction.table('tags').truncate();
            } catch {
                read.mockClear();
            }

            return 'done';
        });

        expect(reason).toHaveProperty('name', 'ConstraintError');
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(read).not.toHaveBeenCalled();
        expect(await connection.table('tags').count()).toEqual(0);
    });
});

describe('Transaction aborted by a failed request', (): void => {
    afterEach((): void => {
        vi.restoreAllMocks();
    });

    test('reports a violated unique index and rolls the transaction back', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });
            await transaction.table('tags').upsert([{ slug: 'b', label: 'x' }], 'slug');
        })).rejects.toThrow(new UniqueConstraintViolationException('tags', 'tags_label_unique'));

        expect(await connection.table('tags').count()).toEqual(0);
    });

    test('surfaces a failure no write handles and rolls the transaction back', async (): Promise<void> => {
        vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore): IDBRequest<undefined> {
            return this.add({ slug: 'a', label: 'y' }) as IDBRequest<unknown> as IDBRequest<undefined>;
        });

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });
            await transaction.table('tags').truncate();
        });

        expect(reason).toBeInstanceOf(DOMException);
        expect(reason).toHaveProperty('name', 'ConstraintError');
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(await connection.table('tags').count()).toEqual(0);
    });

    test('surfaces a failure that lands after the callback returns and rolls the transaction back', async (): Promise<void> => {
        vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore): IDBRequest<undefined> {
            return this.add({ slug: 'a', label: 'y' }) as IDBRequest<unknown> as IDBRequest<undefined>;
        });

        let carried: unknown = null;

        Dispatcher.listen('db:transaction-rolled-back', ((event: TransactionRolledBack): void => {
            carried = event.reason;
        }) as (event: Event) => void, true);

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tags').insert({ slug: 'a', label: 'x' });

            transaction.table('tags').truncate().catch((): void => {});
        });

        expect(reason).toHaveProperty('name', 'ConstraintError');
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-rolled-back']);
        expect(carried).toBe(reason);
        expect(await connection.table('tags').count()).toEqual(0);
    });
});
