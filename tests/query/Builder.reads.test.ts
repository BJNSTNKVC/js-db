import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { RecordsNotFoundException, SchemaException, TableNotFoundException } from '../../src/exceptions';
import { Executor } from '../../src/query/Executor';
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

        await Schema.create('visits', (table: Blueprint): void => {
            table.id();
            table.string('label');
            table.datetime('at').nullable().index();
        });

        await Schema.create('tallies', (table: Blueprint): void => {
            table.integer('count');
        });
    }
}

class CreateRanksTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('ranks', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('rank').index();
        });

        await Schema.create('levels', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('level').index();
        });

        await Schema.create('flags', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.boolean('active').index();
        });
    }
}

class AddTierToRanksTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('ranks', (table: Blueprint): void => {
            table.integer('tier').index();
        });
    }
}

interface Named {
    id: number;
    name: string;
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

interface Visit {
    id: number;
    label: string;
    at: Date | string | null;
}

// Built from local parts, since a time of day is read in local time.
const visits: Omit<Visit, 'id'>[] = [
    { label: 'morning', at: new Date(2026, 0, 5, 9, 30, 0) },
    { label: 'later', at: new Date(2026, 1, 10, 9, 30, 15) },
    { label: 'evening', at: new Date(2026, 2, 1, 18, 45, 0) },
    { label: 'never', at: null },
    { label: 'garbled', at: 'not a date' },
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
function users(): Builder<User> {
    return connection.table<User>('users');
}

/**
 * Get the names of the records a query returns.
 */
async function names(query: Builder<User>): Promise<string[]> {
    return (await query.get()).map((user: User): string => user.name);
}

/**
 * Fail a walk that keeps fetching pages long after the seeded table has run out.
 */
function bound(): void {
    const fetch: Executor<User>['fetch'] = Executor.prototype.fetch;
    let pages: number = 0;

    vi.spyOn(Executor.prototype, 'fetch').mockImplementation(function (this: Executor<User>, keys: IDBValidKey[]): Promise<User[]> {
        if (++pages > 100) {
            throw new Error('The walk fetched more than 100 pages without finishing.');
        }

        return fetch.call(this, keys);
    });
}

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'builder-reads', migrations: [CreateUsersTable] });

    await connection.migrate();

    const database: IDBDatabase = await connection.open();
    const transaction: IDBTransaction = database.transaction(['users', 'logs', 'visits'], 'readwrite');

    for (const user of seed) {
        transaction.objectStore('users').add(user);
    }

    for (const log of logs) {
        transaction.objectStore('logs').add(log);
    }

    for (const visit of visits) {
        transaction.objectStore('visits').add(visit);
    }

    await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
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

    test('keeps an explicit operator when the value is undefined', async (): Promise<void> => {
        expect((await names(users().where('role', '!=', undefined))).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test.each([
        [null],
        [undefined],
    ])('treats equality with %s as whereNull', async (absent: null | undefined): Promise<void> => {
        expect(await names(users().where('age', absent))).toEqual(['Dave']);
        expect(await names(users().where('age', '=', absent))).toEqual(['Dave']);
        expect(await names(users().where('age', '==', absent))).toEqual(['Dave']);
        expect(await names(users().where('age', '===', absent))).toEqual(['Dave']);
        expect(await names(users().where({ age: absent }))).toEqual(['Dave']);
    });

    test.each([
        [null],
        [undefined],
    ])('treats inequality with %s as whereNotNull', async (absent: null | undefined): Promise<void> => {
        expect(await names(users().where('age', '!=', absent))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
        expect(await names(users().where('age', '<>', absent))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
        expect(await names(users().where('age', '!==', absent))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
    });

    test('flips the null check when negated', async (): Promise<void> => {
        expect(await names(users().whereNot('age', null))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
        expect(await names(users().whereNot('age', '!=', null))).toEqual(['Dave']);
        expect(await names(users().whereNot({ age: null }))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
        expect(await names(users().whereNone(['age'], null))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
    });

    test('keeps the conjunction of a null check', async (): Promise<void> => {
        expect(await names(users().where('name', 'Alice').orWhere('age', null))).toEqual(['Alice', 'Dave']);
        expect(await names(users().where('role', 'member').where('age', '!=', null))).toEqual(['Bob', 'Erin']);
    });

    test('matches nothing when an ordering operator compares against null', async (): Promise<void> => {
        expect(await names(users().where('age', '>', null))).toEqual([]);
        expect(await names(users().whereNot('age', '>', null))).toEqual([]);
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

    test('leaves a null comparison unknown inside a negated nested group', async (): Promise<void> => {
        const found: string[] = await names(users().whereNot((query: Builder<User>): void => {
            query.where('age', '>', 26);
        }));

        expect(found.sort()).toEqual(['Bob', 'Erin']);
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

    test('matches neither like nor not like against a column that does not hold strings', async (): Promise<void> => {
        expect(await names(users().whereNotLike('age', '3%'))).toEqual([]);
        expect(await names(users().whereLike('age', '3%'))).toEqual([]);
    });

    test('leaves not in unknown for a value missing from a list that holds null', async (): Promise<void> => {
        expect(await names(users().whereNotIn('role', ['admin', null]))).toEqual([]);
        expect((await names(users().whereIn('role', ['admin', null]))).sort()).toEqual(['Alice']);
    });

    test('leaves not between unknown unless the bound that is not null rules the value out', async (): Promise<void> => {
        expect((await names(users().whereNotBetween('age', [null, 26]))).sort()).toEqual(['Alice', 'Carol']);
        expect(await names(users().whereBetween('age', [null, 26]))).toEqual([]);
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

    test('ignores a negative limit', async (): Promise<void> => {
        expect(await names(users().orderBy('name').limit(-1))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('keeps the earlier limit when a negative one follows', async (): Promise<void> => {
        expect(await names(users().orderBy('name').limit(2).limit(-1))).toEqual(['Alice', 'Bob']);
    });

    test.each([NaN, Infinity])('ignores a limit of %s', async (limit: number): Promise<void> => {
        expect(await names(users().orderBy('name').limit(limit))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('treats a negative offset as none', async (): Promise<void> => {
        expect(await names(users().orderBy('name').offset(-2))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test.each([NaN, Infinity])('treats an offset of %s as none', async (offset: number): Promise<void> => {
        expect(await names(users().orderBy('name').offset(offset))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('truncates a fractional limit and offset', async (): Promise<void> => {
        expect(await names(users().orderBy('name').offset(1.5).limit(1.5))).toEqual(['Bob']);
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

    test('dumps its random order', async (): Promise<void> => {
        const log: MockInstance = vi.spyOn(console, 'log').mockImplementation((): void => {});

        users().inRandomOrder().dump();

        expect(log).toHaveBeenCalledWith(expect.objectContaining({ random: true }));
    });

    test('dumps its joins', async (): Promise<void> => {
        const log: MockInstance = vi.spyOn(console, 'log').mockImplementation((): void => {});

        users().join('posts', 'users.id', 'posts.user_id').dump();

        expect(log).toHaveBeenCalledWith(expect.objectContaining({
            joins: [{ table: 'posts', type: 'inner', conditions: [{ first: 'users.id', operator: '=', second: 'posts.user_id', conjunction: 'and' }] }],
        }));
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

    test('finds a record by a key given as a string, as a route parameter arrives', async (): Promise<void> => {
        const alice: User = await users().where('name', 'Alice').firstOrFail();

        expect((await users().find(String(alice.id)))?.name).toEqual('Alice');
    });

    test('finds nothing for a string that is not a key of the key path\'s type', async (): Promise<void> => {
        expect(await users().find('alice')).toBeNull();
    });

    test.each([null, undefined])('finds nothing for %o without touching the store', async (key: null | undefined): Promise<void> => {
        const read: MockInstance = vi.spyOn(IDBObjectStore.prototype, 'get');

        expect(await users().find(key)).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });

    test.each([
        ['a boolean', true],
        ['an object', { id: 1 }],
        ['an invalid date', new Date('')],
    ])('finds nothing for %s, which is not a key', async (_: string, key: unknown): Promise<void> => {
        expect(await users().find(key as IDBValidKey)).toBeNull();
    });

    test('fails for a null key', async (): Promise<void> => {
        await expect(users().findOrFail(null)).rejects.toBeInstanceOf(RecordsNotFoundException);
    });

    test('finds a record by the key a table without a key path generated', async (): Promise<void> => {
        await connection.table('tallies').insert({ count: 3 });

        expect(await connection.table('tallies').find(1)).toEqual({ count: 3 });
        expect(await connection.table('tallies').find(null)).toBeNull();
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

    test('aggregates a query in random order without shuffling it', async (): Promise<void> => {
        const random: MockInstance = vi.spyOn(Math, 'random').mockReturnValue(0);
        const members: () => Builder<User> = (): Builder<User> => users().where('role', 'member').inRandomOrder().limit(1);

        expect([
            await members().count(),
            await members().sum('age'),
            await members().avg('age'),
            await members().min('age'),
            await members().max('age'),
        ]).toEqual([3, 50, 25, 25, 25]);
        expect(random).not.toHaveBeenCalled();
    });

    test('leaves the paging and order of the query it aggregates alone', async (): Promise<void> => {
        const query: Builder<User> = users().orderBy('name').offset(1).limit(2);

        expect([await query.count(), await query.sum('age'), await query.min('age')]).toEqual([5, 115, 25]);
        expect(await names(query)).toEqual(['Bob', 'Carol']);
    });

    test('checks and walks only the page a limit and an offset leave', async (): Promise<void> => {
        const pages: string[][] = [];
        const each: string[] = [];
        const lazy: string[] = [];

        await users().orderBy('name').offset(1).limit(3).chunk(2, (records: User[]): void => {
            pages.push(records.map((user: User): string => user.name));
        });

        await users().orderBy('name').offset(3).each((user: User): void => {
            each.push(user.name);
        });

        for await (const user of users().orderBy('name').limit(2).lazy(1)) {
            lazy.push(user.name);
        }

        expect(await users().offset(9).exists()).toEqual(false);
        expect(await users().where('role', 'member').offset(2).exists()).toEqual(true);
        expect(pages).toEqual([['Bob', 'Carol'], ['Dave']]);
        expect(each).toEqual(['Dave', 'Erin']);
        expect(lazy).toEqual(['Alice', 'Bob']);
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

    test.each([0, -1, 1.5, NaN])('refuses a chunk size of %s', async (size: number): Promise<void> => {
        const pages: User[][] = [];

        bound();

        await expect(users().orderBy('name').chunk(size, (records: User[]): void => {
            pages.push(records);
        })).rejects.toThrow(SchemaException);

        expect(pages).toEqual([]);
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
        ['key', (query: Builder<User>): Builder<User> => query.where('id', '1')],
        ['index:users_age_index', (query: Builder<User>): Builder<User> => query.where('age', '>', '30')],
        ['scan', (query: Builder<User>): Builder<User> => query.where('age', '>', 'thirty')],
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

describe('Builder ordering through an index that leaves records out', (): void => {
    let loose: Connection;

    /**
     * Begin a query against a table on the loose connection.
     */
    function table(name: string): Builder<Named> {
        return loose.table<Named>(name);
    }

    /**
     * Run a query, collecting the plans it announces.
     */
    async function planned(run: () => Promise<unknown>): Promise<string[]> {
        const plans: string[] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            plans.push(event.plan);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        try {
            await run();
        } finally {
            Dispatcher.forget('db:query', listener);
        }

        return plans;
    }

    beforeAll(async (): Promise<void> => {
        loose = new Connection('app', { database: 'builder-reads-ranks', migrations: [CreateRanksTables], strict: false });

        await loose.migrate();
        await loose.table('ranks').insert([{ name: 'Alice', rank: null }, { name: 'Bob', rank: 1 }, { name: 'Carol', rank: 2 }]);
        await loose.table('levels').insert([{ name: 'Bob', level: 2 }, { name: 'Carol', level: 1 }]);
        await loose.table('flags').insert([{ name: 'Alice', active: true }, { name: 'Bob', active: false }, { name: 'Carol', active: true }]);

        const database: IDBDatabase = await loose.open();
        const transaction: IDBTransaction = database.transaction('levels', 'readwrite');

        transaction.objectStore('levels').add({ name: 'Alice' });

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            transaction.oncomplete = (): void => resolve();
            transaction.onerror = (): void => reject(transaction.error);
        });
    });

    test.each([
        ['ranks', 'rank', 'asc', ['Alice', 'Bob', 'Carol']],
        ['ranks', 'rank', 'desc', ['Carol', 'Bob', 'Alice']],
        ['levels', 'level', 'asc', ['Alice', 'Carol', 'Bob']],
        ['levels', 'level', 'desc', ['Bob', 'Carol', 'Alice']],
        ['flags', 'active', 'asc', ['Bob', 'Alice', 'Carol']],
        ['flags', 'active', 'desc', ['Alice', 'Carol', 'Bob']],
    ] as [string, string, 'asc' | 'desc', string[]][])('orders every record of %s by %s %s', async (name: string, column: string, direction: 'asc' | 'desc', expected: string[]): Promise<void> => {
        expect(await table(name).orderBy(column, direction).pluck('name')).toEqual(expected);
    });

    test('gets the first record in the requested order', async (): Promise<void> => {
        expect((await table('ranks').orderBy('rank').first())?.name).toEqual('Alice');
        expect((await table('levels').orderBy('level').first())?.name).toEqual('Alice');
        expect((await table('ranks').orderBy('rank', 'desc').first())?.name).toEqual('Carol');
    });

    test('applies a limit and an offset in the requested order', async (): Promise<void> => {
        expect(await table('ranks').orderBy('rank').limit(2).pluck('name')).toEqual(['Alice', 'Bob']);
        expect(await table('ranks').orderBy('rank', 'desc').offset(2).limit(1).pluck('name')).toEqual(['Alice']);
        expect(await table('flags').orderBy('active').limit(1).pluck('name')).toEqual(['Bob']);
    });

    test.each([
        ['ranks', 'rank'],
        ['levels', 'level'],
        ['flags', 'active'],
    ])('counts every record of %s ordered by %s', async (name: string, column: string): Promise<void> => {
        expect(await table(name).orderBy(column).count()).toEqual(3);
    });

    test('sorts in memory once the index proves incomplete', async (): Promise<void> => {
        expect(await planned((): Promise<unknown> => table('ranks').orderBy('rank').get())).toEqual(['scan']);
        expect(await table('ranks').orderBy('rank').explain()).toEqual('scan');
    });

    test('still orders through an index that holds every record', async (): Promise<void> => {
        expect(await planned((): Promise<unknown> => users().orderBy('name', 'desc').get())).toEqual(['index:users_name_index']);
        expect(await users().orderBy('name', 'desc').explain()).toEqual('index:users_name_index');
        expect(await names(users().orderBy('name', 'desc'))).toEqual(['Erin', 'Dave', 'Carol', 'Bob', 'Alice']);
    });

    test.each([
        ['a range on the ordering column', 'index:ranks_rank_index', (query: Builder<Named>): Builder<Named> => query.where('rank', '>', 0).orderBy('rank'), ['Bob', 'Carol']],
        ['a point lookup on the ordering column', 'index:ranks_rank_index', (query: Builder<Named>): Builder<Named> => query.where('rank', 2).orderBy('rank', 'desc'), ['Carol']],
        ['point lookups on the ordering column', 'index:ranks_rank_index', (query: Builder<Named>): Builder<Named> => query.whereIn('rank', [2, 1]).orderBy('rank'), ['Bob', 'Carol']],
        ['the key path', 'key', (query: Builder<Named>): Builder<Named> => query.orderBy('id', 'desc'), ['Carol', 'Bob', 'Alice']],
    ] as [string, string, (query: Builder<Named>) => Builder<Named>, string[]][])('orders through %s without counting', async (_: string, plan: string, shape: (query: Builder<Named>) => Builder<Named>, expected: string[]): Promise<void> => {
        const counts: MockInstance[] = [vi.spyOn(IDBIndex.prototype, 'count'), vi.spyOn(IDBObjectStore.prototype, 'count')];
        let found: string[] = [];

        expect(await planned(async (): Promise<void> => {
            found = (await shape(table('ranks')).get()).map((record: Named): string => record.name);
        })).toEqual([plan]);
        expect(found).toEqual(expected);
        expect(counts.map((count: MockInstance): number => count.mock.calls.length)).toEqual([0, 0]);
    });

    test('orders the rows that existed before a migration added the column', async (): Promise<void> => {
        const first: Connection = new Connection('app', { database: 'builder-reads-tiers', migrations: [CreateRanksTables] });

        await first.migrate();
        await first.table('ranks').insert([{ name: 'Old One', rank: 1 }, { name: 'Old Two', rank: 2 }]);

        first.disconnect();

        const second: Connection = new Connection('app', { database: 'builder-reads-tiers', migrations: [CreateRanksTables, AddTierToRanksTable] });

        await second.migrate();
        await second.table('ranks').insert([{ name: 'New', rank: 3, tier: 1 }]);

        expect(await second.table<Named>('ranks').orderBy('tier').pluck('name')).toEqual(['Old One', 'Old Two', 'New']);
        expect(await second.table<Named>('ranks').orderBy('tier', 'desc').pluck('name')).toEqual(['New', 'Old One', 'Old Two']);

        second.disconnect();
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

    test('drops the records the remaining constraints reject', async (): Promise<void> => {
        const found: User[] = await users().whereIn('id', [1, 2, 3]).where('role', 'member').get();

        expect(found.map((user: User): string => user.name)).toEqual(['Bob']);
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

describe('Builder.reorder', (): void => {
    test('clears every order', async (): Promise<void> => {
        expect(await names(users().orderBy('name', 'desc').reorder())).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('replaces the orders with the one given', async (): Promise<void> => {
        expect(await names(users().orderBy('age').orderBy('role').reorder('name', 'desc'))).toEqual(['Erin', 'Dave', 'Carol', 'Bob', 'Alice']);
    });

    test('sorts ascending by default', async (): Promise<void> => {
        expect(await names(users().latest('name').reorder('name'))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('clears a random order', async (): Promise<void> => {
        const random: MockInstance = vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await names(users().inRandomOrder().reorder('name'))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
        expect(random).not.toHaveBeenCalled();
    });

    test('lets an index serve the new order', async (): Promise<void> => {
        expect(await users().orderBy('role').reorder('name').explain()).toEqual('index:users_name_index');
    });
});

describe('Builder.inRandomOrder', (): void => {
    test('returns every matching record', async (): Promise<void> => {
        expect((await names(users().inRandomOrder())).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('shuffles the records', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        // Fisher and Yates always drawing the first position rotates the list by one.
        expect(await names(users().inRandomOrder())).toEqual(['Bob', 'Carol', 'Dave', 'Erin', 'Alice']);
    });

    test('ignores any other order', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0.999);

        expect(await names(users().orderBy('name', 'desc').inRandomOrder().latest('age'))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('never cursors an index for the order', async (): Promise<void> => {
        expect(await users().orderBy('name').inRandomOrder().explain()).toEqual('scan');
    });

    test('shuffles the whole match before the limit and offset', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await names(users().orderBy('name').inRandomOrder().limit(2))).toEqual(['Bob', 'Carol']);
        expect(await names(users().orderBy('name').inRandomOrder().offset(1).limit(2))).toEqual(['Carol', 'Dave']);
    });

    test('shuffles the whole match for the first record', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        expect((await users().orderBy('name').inRandomOrder().first())?.name).toEqual('Bob');
    });

    test('honors the constraints of the query', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await names(users().where('role', 'member').inRandomOrder())).toEqual(['Dave', 'Erin', 'Bob']);
    });

    test('shuffles the keys chunk walks', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const pages: string[][] = [];

        await users().inRandomOrder().chunk(2, (records: User[]): void => {
            pages.push(records.map((user: User): string => user.name));
        });

        expect(pages).toEqual([['Bob', 'Carol'], ['Dave', 'Erin'], ['Alice']]);
    });

    test('shuffles the keys lazy walks', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const seen: string[] = [];

        for await (const user of users().inRandomOrder().lazy(2)) {
            seen.push(user.name);
        }

        expect(seen).toEqual(['Bob', 'Carol', 'Dave', 'Erin', 'Alice']);
    });

    test('shuffles the rows of a joined query', async (): Promise<void> => {
        const random: MockInstance = vi.spyOn(Math, 'random').mockReturnValue(0.999);

        expect(await users().crossJoin('logs').orderBy('users.name').inRandomOrder().get()).toHaveLength(15);
        expect(random).toHaveBeenCalledTimes(14);
    });

    test('is carried over by clone', async (): Promise<void> => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await names(users().orderBy('name').inRandomOrder().clone())).toEqual(['Bob', 'Carol', 'Dave', 'Erin', 'Alice']);
    });

    test('is dropped by a grouping, which orders its own groups', async (): Promise<void> => {
        const random: MockInstance = vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await users().inRandomOrder().groupBy('role').orderBy('role').get()).toEqual([{ role: 'admin' }, { role: 'member' }, { role: 'owner' }]);
        expect(random).not.toHaveBeenCalled();
    });

    test('reports no orders on the executed query', async (): Promise<void> => {
        const seen: unknown[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.orders);
        }) as (event: Event) => void, true);

        await users().orderBy('name').inRandomOrder().get();

        expect(seen).toEqual([[]]);
    });
});

describe('Builder.whereTime', (): void => {
    /**
     * Begin a query against the seeded visits table.
     */
    function times(): Builder<Visit> {
        return connection.table<Visit>('visits');
    }

    /**
     * Get the labels of the visits a query returns.
     */
    async function labels(query: Builder<Visit>): Promise<string[]> {
        return (await query.get()).map((visit: Visit): string => visit.label);
    }

    test('matches a time given with seconds', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '09:30:15'))).toEqual(['later']);
    });

    test('pads a time given without seconds', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '09:30'))).toEqual(['morning']);
    });

    test('ignores the date', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '18:45:00'))).toEqual(['evening']);
    });

    test('compares with an explicit operator', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '>=', '09:30'))).toEqual(['morning', 'later', 'evening']);
        expect(await labels(times().whereTime('at', '<', '12:00'))).toEqual(['morning', 'later']);
        expect(await labels(times().whereTime('at', '>', '09:30:00'))).toEqual(['later', 'evening']);
    });

    test('matches nothing where the column is null or holds no date', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '!=', '09:30'))).toEqual(['later', 'evening']);
    });

    test('combines with other constraints', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '<', '12:00').where('label', 'later'))).toEqual(['later']);
    });

    test('never drives the scan, even over an indexed column', async (): Promise<void> => {
        expect(await times().whereTime('at', '09:30').explain()).toEqual('scan');
    });

    test('takes every operator a date part takes', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '=', '09:30'))).toEqual(['morning']);
        expect(await labels(times().whereTime('at', '<>', '09:30'))).toEqual(['later', 'evening']);
        expect(await labels(times().whereTime('at', '<=', '09:30:15'))).toEqual(['morning', 'later']);
    });

    test.each(['==', '===', '!==', 'like', 'not like', 'between'])('refuses the operator %s', (operator: string): void => {
        expect((): Builder<Visit> => times().whereTime('at', operator as '=', '09:30')).toThrow(SchemaException);
    });

    test('reads a time given alone, or beside an undefined value, as the time to equal', async (): Promise<void> => {
        expect(await labels(times().whereTime('at', '>='))).toEqual([]);
        expect(await labels(times().whereTime('at', '09:30' as '=', undefined as unknown as string))).toEqual(['morning']);
    });
});

describe('Builder.whereAny, whereAll and whereNone', (): void => {
    test('matches when any of the columns meets the comparison', async (): Promise<void> => {
        expect(await names(users().whereAny(['name', 'role'], 'like', '%o%'))).toEqual(['Bob', 'Carol']);
    });

    test('matches when every one of the columns meets the comparison', async (): Promise<void> => {
        expect(await names(users().whereAll(['name', 'role'], 'like', '%o%'))).toEqual(['Carol']);
    });

    test('matches when none of the columns meets the comparison', async (): Promise<void> => {
        expect(await names(users().whereNone(['name', 'role'], 'like', '%o%'))).toEqual(['Alice', 'Dave', 'Erin']);
    });

    test('excludes a record whose column is null from none', async (): Promise<void> => {
        expect(await names(users().whereNone(['age'], '>', 26))).toEqual(['Bob', 'Erin']);
    });

    test('compares with an implicit equals', async (): Promise<void> => {
        expect(await names(users().whereAny(['name', 'role'], 'owner'))).toEqual(['Carol']);
        expect(await names(users().whereAll(['name', 'email'], 'Alice'))).toEqual([]);
        expect(await names(users().whereNone(['name', 'role'], 'member'))).toEqual(['Alice', 'Carol']);
    });

    test('joins the group to the rest of the query with and', async (): Promise<void> => {
        expect(await names(users().whereAny(['name', 'role'], 'like', '%o%').where('age', 25))).toEqual(['Bob']);
        expect(await names(users().where('age', 25).whereAny(['name', 'role'], 'like', '%o%'))).toEqual(['Bob']);
    });

    test('keeps its comparisons inside the group', async (): Promise<void> => {
        // Were the or to leak out of the group, the email of Alice, who is no member, would match.
        expect(await names(users().where('role', 'member').whereAny(['name', 'email'], 'like', 'a%'))).toEqual([]);
    });
});
