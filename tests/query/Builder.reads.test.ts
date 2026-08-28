import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { RecordsNotFoundException, TableNotFoundException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { QueryExecuted } from '../../src/events';
import type { MockInstance } from 'vitest';

interface User {
    id: number;
    name: string;
    email: string;
    age: number | null;
    role: string;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name').index();
            table.string('email').unique();
            table.integer('age').nullable().index();
            table.string('role');
        });

        await Schema.create('empties', (table: Blueprint): void => {
            table.id();
            table.integer('score').nullable().index();
        });

        await Schema.create('logs', (table: Blueprint): void => {
            table.id();
            table.string('level');
            table.integer('weight').nullable();
            table.datetime('seen_at').nullable();
        });
    }
}

interface Log {
    id: number;
    level: string;
    weight: number | null;
    seen_at: Date | null;
}

const logs: Omit<Log, 'id'>[] = [
    { level: 'info', weight: null, seen_at: new Date('2026-03-01T00:00:00.000Z') },
    { level: 'info', weight: null, seen_at: new Date('2026-01-01T00:00:00.000Z') },
    { level: 'warn', weight: 1, seen_at: new Date('2026-02-01T00:00:00.000Z') },
];

const seed: Omit<User, 'id'>[] = [
    { name: 'Alice', email: 'alice@example.com', age: 30, role: 'admin' },
    { name: 'Bob', email: 'bob@example.com', age: 25, role: 'member' },
    { name: 'Carol', email: 'carol@example.com', age: 35, role: 'owner' },
    { name: 'Dave', email: 'dave@example.com', age: null, role: 'member' },
    { name: 'Erin', email: 'erin@example.com', age: 25, role: 'member' },
];

let connection: Connection;

/**
 * Begin a query against the seeded users table.
 */
const users = (): Builder<User> => connection.table<User>('users');

/**
 * Get the names of the records a query returns.
 */
const names = async (query: Builder<User>): Promise<string[]> => (await query.get()).map((user: User): string => user.name);

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'builder-reads', migrations: [CreateUsersTable] });

    await connection.migrate();

    const database: IDBDatabase = await connection.open();
    const transaction: IDBTransaction = database.transaction(['users', 'logs'], 'readwrite');

    for (const user of seed) {
        transaction.objectStore('users').add(user);
    }

    for (const log of logs) {
        transaction.objectStore('logs').add(log);
    }

    await new Promise<void>((resolve, reject): void => {
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = (): void => reject(transaction.error);
    });
});

afterEach((): void => {
    vi.restoreAllMocks();
});

describe('Builder where', (): void => {
    test('constrains with an implicit equals', async (): Promise<void> => {
        expect(await names(users().where('name', 'Alice'))).toEqual(['Alice']);
    });

    test('constrains with an explicit operator', async (): Promise<void> => {
        expect((await names(users().where('age', '>=', 30))).sort()).toEqual(['Alice', 'Carol']);
    });

    test('constrains with an object', async (): Promise<void> => {
        expect(await names(users().where({ role: 'member', age: 25 }))).toEqual(['Bob', 'Erin']);
    });

    test('constrains with a nested group', async (): Promise<void> => {
        const found: string[] = await names(users().where('role', 'member').where((query: Builder<User>): void => {
            query.where('age', 25).orWhere('name', 'Dave');
        }));

        expect(found.sort()).toEqual(['Bob', 'Dave', 'Erin']);
    });

    test('accepts a disjunctive constraint', async (): Promise<void> => {
        expect((await names(users().where('name', 'Alice').orWhere('name', 'Bob'))).sort()).toEqual(['Alice', 'Bob']);
    });

    test('accepts a negated constraint', async (): Promise<void> => {
        expect((await names(users().whereNot('role', 'member'))).sort()).toEqual(['Alice', 'Carol']);
    });

    test('accepts a negated nested group', async (): Promise<void> => {
        const found: string[] = await names(users().whereNot((query: Builder<User>): void => {
            query.where('role', 'member');
        }));

        expect(found.sort()).toEqual(['Alice', 'Carol']);
    });

    test('constrains to a list of values', async (): Promise<void> => {
        expect((await names(users().whereIn('email', ['alice@example.com', 'bob@example.com']))).sort()).toEqual(['Alice', 'Bob']);
    });

    test('constrains away from a list of values', async (): Promise<void> => {
        expect((await names(users().whereNotIn('role', ['member']))).sort()).toEqual(['Alice', 'Carol']);
    });

    test('constrains to null', async (): Promise<void> => {
        expect(await names(users().whereNull('age'))).toEqual(['Dave']);
    });

    test('constrains away from null', async (): Promise<void> => {
        expect((await names(users().whereNotNull('age'))).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
    });

    test('constrains to a range', async (): Promise<void> => {
        expect((await names(users().whereBetween('age', [25, 30]))).sort()).toEqual(['Alice', 'Bob', 'Erin']);
    });

    test('constrains outside a range', async (): Promise<void> => {
        expect(await names(users().whereNotBetween('age', [25, 30]))).toEqual(['Carol']);
    });

    test('constrains by a pattern', async (): Promise<void> => {
        expect(await names(users().whereLike('name', 'A%'))).toEqual(['Alice']);
    });

    test('constrains away from a pattern', async (): Promise<void> => {
        expect((await names(users().whereNotLike('name', 'A%'))).sort()).toEqual(['Bob', 'Carol', 'Dave', 'Erin']);
    });
});

describe('Builder shaping', (): void => {
    test('projects only the selected columns', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').select('name', 'role').get()).toEqual([{ name: 'Alice', role: 'admin' }]);
    });

    test('accepts an array of selected columns', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').select(['name']).get()).toEqual([{ name: 'Alice' }]);
    });

    test('removes duplicates', async (): Promise<void> => {
        expect(await users().select('role').distinct().get()).toEqual([{ role: 'admin' }, { role: 'member' }, { role: 'owner' }]);
    });

    test('keeps duplicates when distinct is turned off', async (): Promise<void> => {
        expect(await users().select('role').distinct(false).get()).toHaveLength(5);
    });

    test('sorts ascending', async (): Promise<void> => {
        expect(await names(users().orderBy('name'))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('sorts descending', async (): Promise<void> => {
        expect(await names(users().orderBy('name', 'desc'))).toEqual(['Erin', 'Dave', 'Carol', 'Bob', 'Alice']);
    });

    test('sorts nulls lowest, as SQL does', async (): Promise<void> => {
        expect(await names(users().orderBy('age').orderBy('name'))).toEqual(['Dave', 'Bob', 'Erin', 'Alice', 'Carol']);
    });

    test('breaks ties with a second order', async (): Promise<void> => {
        expect(await names(users().orderBy('age').orderBy('name', 'desc'))).toEqual(['Dave', 'Erin', 'Bob', 'Alice', 'Carol']);
    });

    test('sorts by the newest first', async (): Promise<void> => {
        expect(await names(users().latest('name'))).toEqual(['Erin', 'Dave', 'Carol', 'Bob', 'Alice']);
    });

    test('sorts by the oldest first', async (): Promise<void> => {
        expect(await names(users().oldest('name'))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('limits the result', async (): Promise<void> => {
        expect(await names(users().orderBy('name').limit(2))).toEqual(['Alice', 'Bob']);
    });

    test('limits the result through take', async (): Promise<void> => {
        expect(await names(users().orderBy('name').take(1))).toEqual(['Alice']);
    });

    test('offsets the result', async (): Promise<void> => {
        expect(await names(users().orderBy('name').offset(3))).toEqual(['Dave', 'Erin']);
    });

    test('offsets the result through skip', async (): Promise<void> => {
        expect(await names(users().orderBy('name').skip(4))).toEqual(['Erin']);
    });

    test('pages the result', async (): Promise<void> => {
        expect(await names(users().orderBy('name').forPage(2, 2))).toEqual(['Carol', 'Dave']);
    });

    test('pages the result with the default page size', async (): Promise<void> => {
        expect(await names(users().orderBy('name').forPage(1))).toHaveLength(5);
    });

    test('applies a conditional constraint when the value is truthy', async (): Promise<void> => {
        expect(await names(users().when('Alice', (query: Builder<User>, value: unknown): void => {
            query.where('name', value);
        }))).toEqual(['Alice']);
    });

    test('skips a conditional constraint when the value is falsy', async (): Promise<void> => {
        expect(await names(users().when(false, (query: Builder<User>): void => {
            query.where('name', 'Alice');
        }))).toHaveLength(5);
    });

    test('passes itself to a tap callback', async (): Promise<void> => {
        expect(await names(users().tap((query: Builder<User>): void => {
            query.where('name', 'Bob');
        }))).toEqual(['Bob']);
    });

    test('clones without sharing state', async (): Promise<void> => {
        const original: Builder<User> = users().where('role', 'member').orderBy('name').limit(1).offset(0).select('name').distinct();
        const clone: Builder<User> = original.clone();

        clone.where('name', 'Erin');

        expect(await original.get()).toEqual([{ name: 'Bob' }]);
        expect(await clone.get()).toEqual([{ name: 'Erin' }]);
    });

    test('exposes the table it queries', (): void => {
        expect(users().table).toEqual('users');
    });

    test('dumps its state', async (): Promise<void> => {
        const log: MockInstance = vi.spyOn(console, 'log').mockImplementation((): void => {});
        const query: Builder<User> = users().where('name', 'Alice');

        expect(query.dump()).toBe(query);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ table: 'users' }));
    });
});

describe('Builder terminals', (): void => {
    test('gets the first record', async (): Promise<void> => {
        expect((await users().orderBy('name').first())?.name).toEqual('Alice');
    });

    test('gets null when nothing matches', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').first()).toBeNull();
    });

    test('fails when nothing matches', async (): Promise<void> => {
        await expect(users().where('name', 'Nobody').firstOrFail()).rejects.toBeInstanceOf(RecordsNotFoundException);
    });

    test('finds a record by key', async (): Promise<void> => {
        const alice: User = await users().where('name', 'Alice').firstOrFail();

        expect((await users().find(alice.id))?.name).toEqual('Alice');
    });

    test('finds nothing for a key that does not exist', async (): Promise<void> => {
        expect(await users().find(9999)).toBeNull();
    });

    test('finds a record by key or fails', async (): Promise<void> => {
        const alice: User = await users().where('name', 'Alice').firstOrFail();

        expect((await users().findOrFail(alice.id)).name).toEqual('Alice');
    });

    test('fails for a key that does not exist', async (): Promise<void> => {
        await expect(users().findOrFail(9999)).rejects.toBeInstanceOf(RecordsNotFoundException);
    });

    test('gets a single column value', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').value('email')).toEqual('alice@example.com');
    });

    test('gets null for a column value when nothing matches', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').value('email')).toBeNull();
    });

    test('gets null for a column that holds null', async (): Promise<void> => {
        expect(await users().where('name', 'Dave').value('age')).toBeNull();
    });

    test('plucks a column', async (): Promise<void> => {
        expect((await users().pluck<string>('name')).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('plucks a column keyed by another', async (): Promise<void> => {
        expect(await users().where('role', 'admin').pluck<string>('email', 'name')).toEqual({ Alice: 'alice@example.com' });
    });

    test('reports that a record exists', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').exists()).toEqual(true);
    });

    test('reports that no record exists', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').exists()).toEqual(false);
    });

    test('reports that a record is missing', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').doesntExist()).toEqual(true);
    });

    test('counts every record', async (): Promise<void> => {
        expect(await users().count()).toEqual(5);
    });

    test('counts an indexed range without reading records', async (): Promise<void> => {
        const database: IDBDatabase = await connection.open();
        const opened: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'openCursor');

        expect(await users().where('age', '>=', 30).count()).toEqual(2);
        expect(opened).not.toHaveBeenCalled();
        expect(database.name).toEqual('builder-reads');
    });

    test('counts by reading records when a residual constraint remains', async (): Promise<void> => {
        expect(await users().where('role', 'member').count()).toEqual(3);
    });

    test('counts point lookups by reading records', async (): Promise<void> => {
        expect(await users().whereIn('email', ['alice@example.com', 'bob@example.com']).count()).toEqual(2);
    });

    test('sums a column', async (): Promise<void> => {
        expect(await users().sum('age')).toEqual(115);
    });

    test('averages a column', async (): Promise<void> => {
        expect(await users().where('age', 25).avg('age')).toEqual(25);
    });

    test('averages nothing as null', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').avg('age')).toBeNull();
    });

    test('gets the smallest value of a column', async (): Promise<void> => {
        expect(await users().min('age')).toEqual(25);
    });

    test('gets the smallest value of nothing as null', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').min('age')).toBeNull();
    });

    test('gets the largest value of a column', async (): Promise<void> => {
        expect(await users().max('age')).toEqual(35);
    });

    test('gets the largest value of nothing as null', async (): Promise<void> => {
        expect(await users().where('name', 'Nobody').max('age')).toBeNull();
    });
});

describe('Builder chunking', (): void => {
    test('walks every record in chunks', async (): Promise<void> => {
        const pages: string[][] = [];

        const completed: boolean = await users().orderBy('name').chunk(2, (records: User[]): void => {
            pages.push(records.map((user: User): string => user.name));
        });

        expect(completed).toEqual(true);
        expect(pages).toEqual([['Alice', 'Bob'], ['Carol', 'Dave'], ['Erin']]);
    });

    test('reports the page number', async (): Promise<void> => {
        const seen: number[] = [];

        await users().orderBy('name').chunk(2, (_records: User[], page: number): void => {
            seen.push(page);
        });

        expect(seen).toEqual([1, 2, 3]);
    });

    test('stops when the callback returns false', async (): Promise<void> => {
        const pages: string[][] = [];

        const completed: boolean = await users().orderBy('name').chunk(2, (records: User[]): boolean => {
            pages.push(records.map((user: User): string => user.name));

            return false;
        });

        expect(completed).toEqual(false);
        expect(pages).toEqual([['Alice', 'Bob']]);
    });

    test('projects the selected columns in each chunk', async (): Promise<void> => {
        const pages: User[][] = [];

        await users().orderBy('name').select('name').chunk(5, (records: User[]): void => {
            pages.push(records);
        });

        expect(pages[0]?.[0]).toEqual({ name: 'Alice' });
    });

    test('walks every record one at a time', async (): Promise<void> => {
        const seen: string[] = [];

        const completed: boolean = await users().orderBy('name').each((user: User): void => {
            seen.push(user.name);
        });

        expect(completed).toEqual(true);
        expect(seen).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('reports the index while walking one at a time', async (): Promise<void> => {
        const seen: number[] = [];

        await users().orderBy('name').each((_user: User, index: number): void => {
            seen.push(index);
        });

        expect(seen).toEqual([0, 1, 2, 3, 4]);
    });

    test('stops walking one at a time when the callback returns false', async (): Promise<void> => {
        const seen: string[] = [];

        const completed: boolean = await users().orderBy('name').each((user: User): boolean => {
            seen.push(user.name);

            return false;
        });

        expect(completed).toEqual(false);
        expect(seen).toEqual(['Alice']);
    });
});

describe('Builder plans', (): void => {
    test.each([
        ['key', (query: Builder<User>): Builder<User> => query.where('id', 1)],
        ['index:users_email_unique', (query: Builder<User>): Builder<User> => query.where('email', 'alice@example.com')],
        ['scan', (query: Builder<User>): Builder<User> => query.where('role', 'admin')],
    ] as [string, (query: Builder<User>) => Builder<User>][])('explains a query as %s', async (plan: string, constrain: (query: Builder<User>) => Builder<User>): Promise<void> => {
        expect(await constrain(users()).explain()).toEqual(plan);
    });

    test('stops an ordered index scan once the limit is met', async (): Promise<void> => {
        const advanced: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            advanced.push(event.plan);
        }) as (event: Event) => void, true);

        expect(await names(users().orderBy('name').limit(2))).toEqual(['Alice', 'Bob']);
        expect(advanced).toEqual(['index:users_name_index']);
    });

    test('announces every query it runs', async (): Promise<void> => {
        const seen: QueryExecuted[] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            seen.push(event);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        await users().where('role', 'member').orderBy('name').limit(2).get();

        Dispatcher.forget('db:query', listener);

        expect(seen).toHaveLength(1);
        expect(seen[0]?.table).toEqual('users');
        expect(seen[0]?.connection).toEqual('app');
        expect(seen[0]?.plan).toEqual('index:users_name_index');
        expect(seen[0]?.records).toEqual(2);
        expect(seen[0]?.limit).toEqual(2);
        expect(seen[0]?.duration).toEqual(expect.any(Number));
    });

    test('announces a find as a key lookup', async (): Promise<void> => {
        const seen: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void, true);

        await users().find(1);

        expect(seen).toEqual(['key']);
    });
});

describe('Builder against a missing table', (): void => {
    test.each([
        ['get', async (query: Builder<User>): Promise<unknown> => query.get()],
        ['count', async (query: Builder<User>): Promise<unknown> => query.count()],
        ['find', async (query: Builder<User>): Promise<unknown> => query.find(1)],
        ['explain', async (query: Builder<User>): Promise<unknown> => query.explain()],
    ] as [string, (query: Builder<User>) => Promise<unknown>][])('fails on %s', async (_name: string, run: (query: Builder<User>) => Promise<unknown>): Promise<void> => {
        await expect(run(connection.table<User>('missing'))).rejects.toBeInstanceOf(TableNotFoundException);
    });
});

describe('Builder sorting edge cases', (): void => {
    test('treats two null values as equal', async (): Promise<void> => {
        const sorted: Log[] = await connection.table<Log>('logs').orderBy('weight').get();

        expect(sorted.map((log: Log): number | null => log.weight)).toEqual([null, null, 1]);
    });

    test('leaves records tied on every order in their original order', async (): Promise<void> => {
        const sorted: Log[] = await connection.table<Log>('logs').orderBy('level').get();

        expect(sorted.map((log: Log): string => log.level)).toEqual(['info', 'info', 'warn']);
    });

    test('returns records unsorted when no order is given', async (): Promise<void> => {
        expect(await connection.table<Log>('logs').get()).toHaveLength(3);
    });
});

describe('Builder point lookups on the key path', (): void => {
    test('reads several records by key', async (): Promise<void> => {
        const found: User[] = await users().whereIn('id', [1, 3]).get();

        expect(found.map((user: User): string => user.name).sort()).toEqual(['Alice', 'Carol']);
    });
});

describe('Builder in memory sorting of dates', (): void => {
    test('sorts a nullable date column by its time value', async (): Promise<void> => {
        const sorted: Log[] = await connection.table<Log>('logs').orderBy('seen_at').get();

        expect(sorted.map((log: Log): string => (log.seen_at as Date).toISOString())).toEqual([
            '2026-01-01T00:00:00.000Z',
            '2026-02-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
        ]);
    });

    test('sorts a nullable date column in reverse', async (): Promise<void> => {
        const sorted: Log[] = await connection.table<Log>('logs').orderBy('seen_at', 'desc').get();

        expect((sorted[0]?.seen_at as Date).toISOString()).toEqual('2026-03-01T00:00:00.000Z');
    });
});

describe('Builder index driven extremes', (): void => {
    test('reads the smallest value from the index rather than the records', async (): Promise<void> => {
        const opened: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'openCursor');

        expect(await users().min('age')).toEqual(25);
        expect(opened).not.toHaveBeenCalled();
    });

    test('reads the largest value from the index rather than the records', async (): Promise<void> => {
        const opened: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'openCursor');

        expect(await users().max('age')).toEqual(35);
        expect(opened).not.toHaveBeenCalled();
    });

    test('announces the index it read the extreme from', async (): Promise<void> => {
        const seen: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void, true);

        await users().min('age');

        expect(seen).toEqual(['index:users_age_index']);
    });

    test('falls back to the records once a constraint narrows the query', async (): Promise<void> => {
        expect(await users().where('role', 'member').min('age')).toEqual(25);
        expect(await users().where('role', 'member').max('age')).toEqual(25);
    });

    test('falls back to the records for an unindexed column', async (): Promise<void> => {
        expect(await connection.table<Log>('logs').min('weight')).toEqual(1);
        expect(await connection.table<Log>('logs').max('weight')).toEqual(1);
    });

    test('yields null from the index when the table holds no value for the column', async (): Promise<void> => {
        await connection.table('empties').truncate();

        expect(await connection.table('empties').min('score')).toBeNull();
        expect(await connection.table('empties').max('score')).toBeNull();
    });
});

describe('Builder disjunctive constraints', (): void => {
    test('accepts a disjunctive list', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Alice').orWhereIn('role', ['owner']));

        expect(found.sort()).toEqual(['Alice', 'Carol']);
    });

    test('accepts a disjunctive excluded list', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Alice').orWhereNotIn('role', ['member', 'admin']));

        expect(found.sort()).toEqual(['Alice', 'Carol']);
    });

    test('accepts a disjunctive null', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Alice').orWhereNull('age'));

        expect(found.sort()).toEqual(['Alice', 'Dave']);
    });

    test('accepts a disjunctive not null', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Nobody').orWhereNotNull('age'));

        expect(found.sort()).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
    });

    test('accepts a disjunctive range', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Dave').orWhereBetween('age', [34, 36]));

        expect(found.sort()).toEqual(['Carol', 'Dave']);
    });

    test('accepts a disjunctive excluded range', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Dave').orWhereNotBetween('age', [25, 30]));

        expect(found.sort()).toEqual(['Carol', 'Dave']);
    });

    test('accepts a disjunctive pattern', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Bob').orWhereLike('name', 'A%'));

        expect(found.sort()).toEqual(['Alice', 'Bob']);
    });

    test('accepts a disjunctive negated pattern', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Alice').orWhereNotLike('name', '%o%'));

        expect(found.sort()).toEqual(['Alice', 'Dave', 'Erin']);
    });

    test('accepts a disjunctive column comparison', async (): Promise<void> => {
        const found: string[] = await names(users().where('name', 'Alice').orWhereColumn('name', '=', 'role'));

        expect(found).toEqual(['Alice']);
    });

    test('reads the same as a nested group would', async (): Promise<void> => {
        const chained: string[] = await names(users().where('name', 'Alice').orWhereNull('age'));

        const nested: string[] = await names(users().where((query: Builder<User>): void => {
            query.where('name', 'Alice').orWhereNull('age');
        }));

        expect(chained.sort()).toEqual(nested.sort());
    });
});
