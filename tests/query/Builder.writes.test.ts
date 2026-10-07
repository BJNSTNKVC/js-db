import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import {
    NotNullConstraintViolationException,
    SchemaException,
    UniqueConstraintViolationException,
} from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { Transaction } from '../../src/database/Transaction';
import type { QueryExecuted } from '../../src/events';
import type { MockInstance } from 'vitest';

interface User {
    id: number;
    name: string;
    email: string;
    role: string;
    visits: number;
    nickname: string | null;
    score: number | null;
    created_at: Date | null;
    updated_at: Date | null;
}

interface Birthday {
    id: number;
    name: string;
    born: Date | null;
    seen: Date | null;
    noted: Date;
    visits: number;
}

interface Ranked {
    id: number;
    name: string;
    rank: number | null;
}

interface Entry {
    id: number;
    label: string;
    position: number;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('email').unique();
            table.string('role').default('member');
            table.integer('visits').default(0);
            table.string('nickname').nullable();
            table.integer('score').nullable();
            table.timestamps();
        });

        await Schema.create('slugs', (table: Blueprint): void => {
            table.uuid('slug').primary();
            table.string('label');
        });

        await Schema.create('nullables', (table: Blueprint): void => {
            table.id();
            table.string('nickname').nullable().unique();
            table.string('email').unique();
        });

        await Schema.create('pairs', (table: Blueprint): void => {
            table.id();
            table.string('left');
            table.string('right');
            table.integer('count').default(0);
            table.unique(['left', 'right']);
        });

        await Schema.create('entries', (table: Blueprint): void => {
            table.id();
            table.string('label');
            table.integer('position').index();
        });

        await Schema.create('codes', (table: Blueprint): void => {
            table.id();
            table.integer('code').unique();
            table.string('label');
        });

        await Schema.create('schedules', (table: Blueprint): void => {
            table.id();
            table.string('label');
            table.json('slots').unique();
        });

        await Schema.create('tagged', (table: Blueprint): void => {
            table.id();
            table.string('title');
            table.json('tags').nullable().unique().multiEntry();
            table.string('slug').nullable().unique();
            table.integer('visits').default(0);
        });

        await Schema.create('profiles', (table: Blueprint): void => {
            table.id();
            table.json('meta').unique();
            table.string('email').unique();
        });

        await Schema.create('contacts', (table: Blueprint): void => {
            table.id();
            table.string('email').unique();
            table.json('meta').unique();
        });

        await Schema.create('seats', (table: Blueprint): void => {
            table.id();
            table.string('label');
            table.integer('seat').nullable().unique();
        });

        await Schema.create('birthdays', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.date('born').nullable().unique();
            table.datetime('seen').nullable();
            table.date('noted').default('2024-01-15');
            table.integer('visits').default(0);
        });
    }
}

class CreateRanksTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('ranks', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('rank').index();
        });
    }
}

let connection: Connection;
let sequence: number = 0;

/**
 * Begin a query against the users table.
 */
function users(): Builder<User> {
    return connection.table<User>('users');
}

beforeEach(async (): Promise<void> => {
    connection?.disconnect();

    connection = new Connection('app', { database: `builder-writes-${++sequence}`, migrations: [CreateUsersTable] });

    await connection.migrate();
});

describe('Builder insert', (): void => {
    test('inserts a single record', async (): Promise<void> => {
        expect(await users().insert({ name: 'Alice', email: 'alice@example.com' })).toEqual(1);
        expect((await users().firstOrFail()).name).toEqual('Alice');
    });

    test('inserts several records', async (): Promise<void> => {
        expect(await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
        ])).toEqual(2);

        expect(await users().count()).toEqual(2);
    });

    test('applies declared defaults', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        const alice: User = await users().firstOrFail();

        expect(alice.role).toEqual('member');
        expect(alice.visits).toEqual(0);
    });

    test('fills both timestamps', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        const alice: User = await users().firstOrFail();

        expect(alice.created_at).toBeInstanceOf(Date);
        expect(alice.updated_at).toBeInstanceOf(Date);
    });

    test('coerces a declared column', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', visits: '7' as unknown as number });

        expect((await users().firstOrFail()).visits).toEqual(7);
    });

    test('leaves a nullable column null', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect((await users().firstOrFail()).nickname).toBeNull();
    });

    test('fails for an absent non nullable column', async (): Promise<void> => {
        await expect(users().insert({ email: 'alice@example.com' })).rejects.toBeInstanceOf(NotNullConstraintViolationException);
    });

    test('generates the key', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect((await users().firstOrFail()).id).toEqual(1);
    });

    test('reports a violated unique index by name', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        await expect(users().insert({ name: 'Bob', email: 'alice@example.com' })).rejects.toThrow(
            new UniqueConstraintViolationException('users', 'users_email_unique'),
        );
    });

    test('reports a violated unique index by name when the explicit key is free', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        await expect(users().insert({ id: 5, name: 'Bob', email: 'alice@example.com' })).rejects.toThrow(
            new UniqueConstraintViolationException('users', 'users_email_unique'),
        );
    });

    test('reports a violated key path by name', async (): Promise<void> => {
        await connection.table('slugs').insert({ slug: 'a', label: 'A' });

        await expect(connection.table('slugs').insert({ slug: 'a', label: 'B' })).rejects.toThrow(
            new UniqueConstraintViolationException('slugs', 'slug'),
        );
    });

    test('reports a violated compound unique index by name', async (): Promise<void> => {
        await connection.table('pairs').insert({ left: 'a', right: 'b' });

        await expect(connection.table('pairs').insert({ left: 'a', right: 'b' })).rejects.toThrow(
            new UniqueConstraintViolationException('pairs', 'pairs_left_right_unique'),
        );
    });

    test('announces the insert', async (): Promise<void> => {
        const seen: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void, true);

        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(seen).toEqual(['insert']);
    });
});

describe('Builder insertGetId', (): void => {
    test('returns the generated key', async (): Promise<void> => {
        expect(await users().insertGetId({ name: 'Alice', email: 'alice@example.com' })).toEqual(1);
    });

    test('returns an explicit key', async (): Promise<void> => {
        expect(await connection.table('slugs').insertGetId({ slug: 'a', label: 'A' })).toEqual('a');
    });

    test('reports a violated constraint', async (): Promise<void> => {
        await users().insertGetId({ name: 'Alice', email: 'alice@example.com' });

        await expect(users().insertGetId({ name: 'Bob', email: 'alice@example.com' })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    });
});

describe('Builder update', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', role: 'admin', visits: 1 },
            { name: 'Bob', email: 'bob@example.com', role: 'member', visits: 2 },
            { name: 'Carol', email: 'carol@example.com', role: 'member', visits: 3 },
        ]);
    });

    test('updates every matching record and returns the count', async (): Promise<void> => {
        expect(await users().where('role', 'member').update({ role: 'owner' })).toEqual(2);
        expect(await users().where('role', 'owner').count()).toEqual(2);
    });

    test('updates nothing when nothing matches', async (): Promise<void> => {
        expect(await users().where('role', 'ghost').update({ role: 'owner' })).toEqual(0);
    });

    test('touches the update timestamp', async (): Promise<void> => {
        const before: Date = (await users().where('name', 'Alice').firstOrFail()).updated_at as Date;

        await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, 5);
        });

        await users().where('name', 'Alice').update({ role: 'owner' });

        const after: Date = (await users().where('name', 'Alice').firstOrFail()).updated_at as Date;

        expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    test('does not touch the creation timestamp', async (): Promise<void> => {
        const before: Date = (await users().where('name', 'Alice').firstOrFail()).created_at as Date;

        await users().where('name', 'Alice').update({ role: 'owner' });

        expect((await users().where('name', 'Alice').firstOrFail()).created_at).toEqual(before);
    });

    test('coerces provided columns', async (): Promise<void> => {
        await users().where('name', 'Alice').update({ visits: '9' as unknown as number });

        expect((await users().where('name', 'Alice').firstOrFail()).visits).toEqual(9);
    });

    test('fails for an explicit null in a non nullable column', async (): Promise<void> => {
        await expect(users().where('name', 'Alice').update({ role: null as unknown as string })).rejects.toBeInstanceOf(NotNullConstraintViolationException);
    });

    test('refuses to update the key path', async (): Promise<void> => {
        await expect(users().where('name', 'Alice').update({ id: 9 })).rejects.toThrow(
            new SchemaException('Column [id] is the key path of table [users] and may not be updated.'),
        );
    });

    test('honours a limit', async (): Promise<void> => {
        expect(await users().where('role', 'member').limit(1).update({ role: 'owner' })).toEqual(1);
        expect(await users().where('role', 'member').count()).toEqual(1);
    });

    test('honours an offset', async (): Promise<void> => {
        expect(await users().where('role', 'member').offset(1).update({ role: 'owner' })).toEqual(1);
    });

    test('updates through an index range', async (): Promise<void> => {
        expect(await users().where('email', 'bob@example.com').update({ role: 'owner' })).toEqual(1);
    });

    test('updates through point lookups', async (): Promise<void> => {
        expect(await users().whereIn('email', ['bob@example.com', 'carol@example.com']).update({ role: 'owner' })).toEqual(2);
    });
});

describe('Builder updateOrInsert', (): void => {
    test('inserts when nothing matches', async (): Promise<void> => {
        expect(await users().updateOrInsert({ email: 'alice@example.com' }, { name: 'Alice' })).toEqual(true);
        expect((await users().firstOrFail()).name).toEqual('Alice');
    });

    test('updates when a record matches', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().updateOrInsert({ email: 'alice@example.com' }, { name: 'Alicia' })).toEqual(false);
        expect((await users().firstOrFail()).name).toEqual('Alicia');
        expect(await users().count()).toEqual(1);
    });

    test('inserts with only the attributes when no values are given', async (): Promise<void> => {
        expect(await users().updateOrInsert({ name: 'Alice', email: 'alice@example.com' })).toEqual(true);
    });
});

describe('Builder upsert', (): void => {
    test('puts records when the conflict target is the key path', async (): Promise<void> => {
        await connection.table('slugs').upsert([{ slug: 'a', label: 'A' }], 'slug');
        await connection.table('slugs').upsert([{ slug: 'a', label: 'Updated' }], 'slug');

        expect(await connection.table('slugs').where('slug', 'a').value('label')).toEqual('Updated');
        expect(await connection.table('slugs').count()).toEqual(1);
    });

    test('inserts through a unique index when nothing matches', async (): Promise<void> => {
        expect(await users().upsert([{ name: 'Alice', email: 'alice@example.com' }], 'email')).toEqual(1);
        expect(await users().count()).toEqual(1);
    });

    test('merges every column through a unique index when a record matches', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', visits: 1 });
        await users().upsert([{ name: 'Alicia', email: 'alice@example.com', visits: 5 }], 'email');

        const alice: User = await users().firstOrFail();

        expect(alice.name).toEqual('Alicia');
        expect(alice.visits).toEqual(5);
        expect(await users().count()).toEqual(1);
    });

    test('merges only the named columns when they are given', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', visits: 1 });
        await users().upsert([{ name: 'Alicia', email: 'alice@example.com', visits: 5 }], 'email', ['visits']);

        const alice: User = await users().firstOrFail();

        expect(alice.name).toEqual('Alice');
        expect(alice.visits).toEqual(5);
    });

    test('accepts a compound unique index', async (): Promise<void> => {
        await connection.table('pairs').insert({ left: 'a', right: 'b', count: 1 });
        await connection.table('pairs').upsert([{ left: 'a', right: 'b', count: 9 }], ['left', 'right'], ['count']);

        expect(await connection.table('pairs').value('count')).toEqual(9);
        expect(await connection.table('pairs').count()).toEqual(1);
    });

    test('refuses a conflict target that is neither the key path nor a unique index', async (): Promise<void> => {
        await expect(users().upsert([{ name: 'Alice', email: 'alice@example.com' }], 'name')).rejects.toThrow(
            new SchemaException('Upsert on table [users] requires [name] to be the key path or a unique index.'),
        );
    });

    test('refuses a compound target that is not a unique index', async (): Promise<void> => {
        await expect(users().upsert([{ name: 'Alice', email: 'alice@example.com' }], ['name', 'role'])).rejects.toBeInstanceOf(SchemaException);
    });

    test('merges into the record holding an integer conflict key given as a string', async (): Promise<void> => {
        await connection.table('codes').insert({ code: 5, label: 'A' });

        expect(await connection.table('codes').upsert([{ code: '5', label: 'B' }], 'code')).toEqual(1);
        expect(await connection.table('codes').get()).toEqual([{ id: 1, code: 5, label: 'B' }]);
    });

    test('refuses to merge the key path', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        await expect(users().upsert([{ id: 9, email: 'alice@example.com' } as Partial<User>], 'email')).rejects.toBeInstanceOf(SchemaException);
    });
});

describe('Builder increment and decrement', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 5 },
            { name: 'Bob', email: 'bob@example.com', visits: 10 },
        ]);
    });

    test('increments by one', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').increment('visits')).toEqual(1);
        expect(await users().where('name', 'Alice').value('visits')).toEqual(6);
    });

    test('increments by an amount', async (): Promise<void> => {
        await users().where('name', 'Alice').increment('visits', 4);

        expect(await users().where('name', 'Alice').value('visits')).toEqual(9);
    });

    test('decrements by one', async (): Promise<void> => {
        await users().where('name', 'Bob').decrement('visits');

        expect(await users().where('name', 'Bob').value('visits')).toEqual(9);
    });

    test('decrements by an amount', async (): Promise<void> => {
        await users().where('name', 'Bob').decrement('visits', 3);

        expect(await users().where('name', 'Bob').value('visits')).toEqual(7);
    });

    test('applies extra columns alongside the step', async (): Promise<void> => {
        await users().where('name', 'Alice').increment('visits', 1, { role: 'owner' });

        const alice: User = await users().where('name', 'Alice').firstOrFail();

        expect(alice.visits).toEqual(6);
        expect(alice.role).toEqual('owner');
    });

    test('steps a column holding zero', async (): Promise<void> => {
        await users().where('name', 'Alice').update({ visits: 0 });
        await users().where('name', 'Alice').increment('visits', 2);

        expect(await users().where('name', 'Alice').value('visits')).toEqual(2);
    });

    test('refuses extra columns that touch the key path', async (): Promise<void> => {
        await expect(users().increment('visits', 1, { id: 9 })).rejects.toBeInstanceOf(SchemaException);
    });

    test('increments every record when unconstrained', async (): Promise<void> => {
        expect(await users().increment('visits')).toEqual(2);
    });
});

describe('Builder writes that move records along the index they walk', (): void => {
    /**
     * Begin a query against the entries table.
     */
    function entries(): Builder<Entry> {
        return connection.table<Entry>('entries');
    }

    beforeEach(async (): Promise<void> => {
        await entries().insert(['a', 'b', 'c', 'd', 'e'].map((label: string, position: number): Partial<Entry> => ({ label, position })));
    });

    afterEach((): void => {
        vi.restoreAllMocks();
    });

    test('makes room in an ordered list by shifting each position once', async (): Promise<void> => {
        expect(await entries().where('position', '>=', 2).increment('position')).toEqual(3);
        expect(await entries().orderBy('id').pluck('position')).toEqual([0, 1, 3, 4, 5]);
    }, 2000);

    test('shifts each of a limited run in index order once', async (): Promise<void> => {
        expect(await entries().orderBy('position').limit(3).increment('position')).toEqual(3);
        expect(await entries().orderBy('id').pluck('position')).toEqual([1, 2, 3, 3, 4]);
    }, 2000);

    test('walks the index once when the write leaves its column alone', async (): Promise<void> => {
        const walks: MockInstance[] = [
            vi.spyOn(IDBIndex.prototype, 'openCursor'),
            vi.spyOn(IDBIndex.prototype, 'openKeyCursor'),
            vi.spyOn(IDBObjectStore.prototype, 'openCursor'),
        ];

        expect(await entries().where('position', '>=', 2).update({ label: 'moved' })).toEqual(3);
        expect(walks.map((walk: MockInstance): number => walk.mock.calls.length)).toEqual([1, 2, 0]);
        expect(walks[1]?.mock.calls).toEqual([[null, 'next'], [null, 'prev']]);
        expect(await entries().orderBy('id').pluck('label')).toEqual(['a', 'b', 'moved', 'moved', 'moved']);
    });
});

describe('Builder delete', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', role: 'admin' },
            { name: 'Bob', email: 'bob@example.com', role: 'member' },
            { name: 'Carol', email: 'carol@example.com', role: 'member' },
        ]);
    });

    test('deletes every matching record and returns the count', async (): Promise<void> => {
        expect(await users().where('role', 'member').delete()).toEqual(2);
        expect(await users().count()).toEqual(1);
    });

    test('deletes nothing when nothing matches', async (): Promise<void> => {
        expect(await users().where('role', 'ghost').delete()).toEqual(0);
    });

    test('honours a limit', async (): Promise<void> => {
        expect(await users().where('role', 'member').limit(1).delete()).toEqual(1);
        expect(await users().count()).toEqual(2);
    });

    test('ignores a negative limit', async (): Promise<void> => {
        expect(await users().where('role', 'member').limit(-1).delete()).toEqual(2);
        expect(await users().pluck('name')).toEqual(['Alice']);
    });

    test('deletes through an index range', async (): Promise<void> => {
        expect(await users().where('email', 'bob@example.com').delete()).toEqual(1);
    });

    test('deletes every record when unconstrained', async (): Promise<void> => {
        expect(await users().delete()).toEqual(3);
    });
});

describe('Builder ordered writes with a limit or offset', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
            { name: 'Alice', email: 'alice@example.com' },
        ]);
    });

    test('updates the first record in the requested order', async (): Promise<void> => {
        expect(await users().orderBy('name').limit(1).update({ role: 'owner' })).toEqual(1);
        expect(await users().where('role', 'owner').pluck('name')).toEqual(['Alice']);
    });

    test('deletes the first record in the requested order', async (): Promise<void> => {
        expect(await users().orderBy('name').limit(1).delete()).toEqual(1);
        expect(await users().orderBy('name').pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('increments the first record in a descending order', async (): Promise<void> => {
        expect(await users().orderBy('name', 'desc').limit(1).increment('visits')).toEqual(1);
        expect(await users().where('visits', 1).pluck('name')).toEqual(['Carol']);
    });

    test('skips the offset in the requested order', async (): Promise<void> => {
        expect(await users().orderBy('name').offset(1).delete()).toEqual(2);
        expect(await users().pluck('name')).toEqual(['Alice']);
    });

    test('applies both the offset and the limit in the requested order', async (): Promise<void> => {
        expect(await users().orderBy('name').offset(1).limit(1).update({ role: 'owner' })).toEqual(1);
        expect(await users().where('role', 'owner').pluck('name')).toEqual(['Bob']);
    });

    test('honors the order among records found through point lookups', async (): Promise<void> => {
        expect(await users().whereIn('id', [1, 3]).orderBy('name').limit(1).delete()).toEqual(1);
        expect(await users().orderBy('name').pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('honors the order inside a transaction', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            expect(await transaction.table<User>('users').orderBy('name').limit(1).delete()).toEqual(1);
        });

        expect(await users().orderBy('name').pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('announces the write once with the number of records affected', async (): Promise<void> => {
        const seen: [string, number][] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push([event.plan, event.records]);
        }) as (event: Event) => void, true);

        await users().orderBy('name').limit(2).delete();

        expect(seen).toEqual([['scan', 2]]);
    });

    test('walks an index that serves the order', async (): Promise<void> => {
        const seen: [string, number][] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push([event.plan, event.records]);
        }) as (event: Event) => void, true);

        expect(await users().orderBy('email', 'desc').limit(1).delete()).toEqual(1);
        expect(seen).toEqual([['index:users_email_unique', 1]]);
        expect(await users().orderBy('name').pluck('name')).toEqual(['Alice', 'Bob']);
    });
});

describe('Builder ordered writes through an index that leaves records out', (): void => {
    let loose: Connection;

    /**
     * Begin a query against the ranks table on the loose connection.
     */
    function ranks(): Builder<Ranked> {
        return loose.table<Ranked>('ranks');
    }

    beforeEach(async (): Promise<void> => {
        loose = new Connection('app', { database: `builder-writes-ranks-${++sequence}`, migrations: [CreateRanksTable], strict: false });

        await loose.migrate();
        await ranks().insert([{ name: 'Alice', rank: null }, { name: 'Bob', rank: 1 }, { name: 'Carol', rank: 2 }]);
    });

    afterEach((): void => {
        loose.disconnect();
    });

    test('deletes the first record in the requested order', async (): Promise<void> => {
        expect(await ranks().orderBy('rank').limit(1).delete()).toEqual(1);
        expect(await ranks().pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('skips the offset in a descending order', async (): Promise<void> => {
        expect(await ranks().orderBy('rank', 'desc').offset(2).delete()).toEqual(1);
        expect(await ranks().pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('updates the first record when the write changes the ordering column', async (): Promise<void> => {
        expect(await ranks().orderBy('rank').limit(1).update({ rank: 5 })).toEqual(1);
        expect(await ranks().pluck('rank')).toEqual([5, 1, 2]);
    });

    test('counts a record whose ordering column stays null among those an increment of it reaches', async (): Promise<void> => {
        expect(await ranks().orderBy('rank').limit(2).increment('rank')).toEqual(2);
        expect(await ranks().pluck('rank')).toEqual([null, 2, 2]);
    });

    test('leaves a record holding null out of a range on the column an increment of it walks', async (): Promise<void> => {
        expect(await ranks().where('rank', '>=', 1).orderBy('rank').limit(1).increment('rank')).toEqual(1);
        expect(await ranks().pluck('rank')).toEqual([null, 2, 2]);
    });

    test('deletes the first record in the requested order inside a transaction', async (): Promise<void> => {
        await loose.transaction(async (transaction: Transaction): Promise<void> => {
            expect(await transaction.table<Ranked>('ranks').orderBy('rank').limit(1).delete()).toEqual(1);
        });

        expect(await ranks().pluck('name')).toEqual(['Bob', 'Carol']);
    });

    test('announces the write as the scan it falls back to', async (): Promise<void> => {
        const seen: [string, number][] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push([event.plan, event.records]);
        }) as (event: Event) => void, true);

        await ranks().orderBy('rank').limit(1).delete();

        expect(seen).toEqual([['scan', 1]]);
    });
});

describe('Builder writes in a random order', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
            { name: 'Alice', email: 'alice@example.com' },
        ]);

        // Fisher and Yates always drawing the first position turns Bob, Carol, Alice into Carol,
        // Alice, Bob, which is neither key order nor name order.
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach((): void => {
        vi.restoreAllMocks();
    });

    test('deletes a record chosen from the shuffled match', async (): Promise<void> => {
        expect(await users().orderBy('name').inRandomOrder().limit(1).delete()).toEqual(1);
        expect(await users().reorder().pluck('name')).toEqual(['Bob', 'Alice']);
    });

    test('skips the offset in the shuffled match', async (): Promise<void> => {
        expect(await users().inRandomOrder().offset(1).update({ role: 'owner' })).toEqual(2);
        expect(await users().where('role', 'owner').pluck('name')).toEqual(['Bob', 'Alice']);
    });

    test('shuffles inside a transaction', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            expect(await transaction.table<User>('users').inRandomOrder().limit(1).increment('visits')).toEqual(1);
        });

        expect(await users().where('visits', 1).pluck('name')).toEqual(['Carol']);
    });

    test('touches every match without shuffling when nothing limits the write', async (): Promise<void> => {
        expect(await users().inRandomOrder().update({ role: 'owner' })).toEqual(3);
        expect(Math.random).not.toHaveBeenCalled();
    });
});

describe('Builder chunking over records that change', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
            { name: 'Dave', email: 'dave@example.com' },
            { name: 'Erin', email: 'erin@example.com' },
        ]);
    });

    test('leaves out a record that stops matching before its page', async (): Promise<void> => {
        const pages: string[][] = [];

        await users().where('role', 'member').orderBy('name').chunk(2, async (records: User[]): Promise<void> => {
            pages.push(records.map((user: User): string => user.name));

            if (pages.length === 1) {
                await users().where('name', 'Carol').update({ role: 'owner' });
            }
        });

        expect(pages).toEqual([['Alice', 'Bob'], ['Dave'], ['Erin']]);
    });

    test('rechecks the constraint that drove the scan', async (): Promise<void> => {
        const pages: string[][] = [];

        await users().where('email', '<', 'e').orderBy('name').chunk(2, async (records: User[]): Promise<void> => {
            pages.push(records.map((user: User): string => user.name));

            if (pages.length === 1) {
                await users().where('name', 'Carol').update({ email: 'zed@example.com' });
            }
        });

        expect(pages).toEqual([['Alice', 'Bob'], ['Dave']]);
    });

    test('skips a record deleted before its page', async (): Promise<void> => {
        const pages: string[][] = [];

        await users().orderBy('name').chunk(2, async (records: User[]): Promise<void> => {
            pages.push(records.map((user: User): string => user.name));

            if (pages.length === 1) {
                await users().where('name', 'Carol').delete();
            }
        });

        expect(pages).toEqual([['Alice', 'Bob'], ['Dave'], ['Erin']]);
    });

    test('skips a page left empty and numbers the next one after the last delivered', async (): Promise<void> => {
        const pages: [number, string[]][] = [];

        await users().where('role', 'member').orderBy('name').chunk(2, async (records: User[], page: number): Promise<void> => {
            pages.push([page, records.map((user: User): string => user.name)]);

            if (page === 1) {
                await users().whereIn('name', ['Carol', 'Dave']).update({ role: 'owner' });
            }
        });

        expect(pages).toEqual([[1, ['Alice', 'Bob']], [2, ['Erin']]]);
    });

    test('leaves out a record that stops matching while walking lazily', async (): Promise<void> => {
        const seen: string[] = [];

        for await (const user of users().where('role', 'member').orderBy('name').lazy(2)) {
            seen.push(user.name);

            if (user.name === 'Bob') {
                await users().where('name', 'Carol').update({ role: 'owner' });
            }
        }

        expect(seen).toEqual(['Alice', 'Bob', 'Dave', 'Erin']);
    });
});

describe('Builder truncate', (): void => {
    test('empties the table', async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
        ]);

        await users().truncate();

        expect(await users().count()).toEqual(0);
    });

    test('announces the truncate', async (): Promise<void> => {
        const seen: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void, true);

        await users().truncate();

        expect(seen).toEqual(['truncate']);
    });
});

describe('Builder unattributable constraint violations', (): void => {
    test('surfaces the platform error when the violated index cannot be found', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        // Report every index as holding nothing, so the violation cannot be attributed.
        const empty: MockInstance = vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(function (this: IDBIndex): IDBRequest<number> {
            const request: Partial<IDBRequest<number>> = { result: 0 };

            setTimeout((): void => {
                (request.onsuccess as ((event: Event) => void) | null)?.(new Event('success'));
            }, 0);

            return request as IDBRequest<number>;
        });

        await expect(users().insert({ name: 'Bob', email: 'alice@example.com' })).rejects.toBeInstanceOf(DOMException);

        empty.mockRestore();
    });
});

describe('Builder constraint attribution across nullable unique indexes', (): void => {
    test('skips a unique index the record has no value for', async (): Promise<void> => {
        await connection.table('nullables').insert({ nickname: null, email: 'a@b.c' });

        await expect(connection.table('nullables').insert({ nickname: null, email: 'a@b.c' })).rejects.toThrow(
            new UniqueConstraintViolationException('nullables', 'nullables_email_unique'),
        );
    });
});

describe('Builder unique violations on every write', (): void => {
    type Table = (name: string) => Builder<Record<string, unknown>>;

    type Collision = [string, (table: Table) => Promise<unknown>, string, string];

    const COLLISIONS: Collision[] = [
        [
            'an insert',
            (table: Table): Promise<unknown> => table('users').insert({ name: 'Eve', email: 'carol@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an upsert that inserts',
            (table: Table): Promise<unknown> => table('nullables').upsert([{ nickname: 'al', email: 'eve@example.com' }], 'email'),
            'nullables',
            'nullables_nickname_unique',
        ],
        [
            'an update',
            (table: Table): Promise<unknown> => table('users').where('name', 'Bob').update({ email: 'carol@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an upsert whose update breaks another unique index',
            (table: Table): Promise<unknown> => table('nullables').upsert([{ nickname: 'al', email: 'bob@example.com' }], 'email'),
            'nullables',
            'nullables_nickname_unique',
        ],
        [
            'an upsert whose update breaks a unique index checked after its conflict target',
            (table: Table): Promise<unknown> => table('nullables').upsert([{ nickname: 'bo', email: 'alice@example.com' }], 'nickname'),
            'nullables',
            'nullables_email_unique',
        ],
        [
            'an upsert on the key path that breaks a unique index',
            (table: Table): Promise<unknown> => table('users').upsert([{ id: 2, name: 'Bob', email: 'carol@example.com' }], 'id'),
            'users',
            'users_email_unique',
        ],
        [
            'an upsert on the key path that inserts under a free key',
            (table: Table): Promise<unknown> => table('users').upsert([{ id: 9, name: 'Eve', email: 'carol@example.com' }], 'id'),
            'users',
            'users_email_unique',
        ],
        [
            'an upsert on the key path that inserts under a generated key',
            (table: Table): Promise<unknown> => table('users').upsert([{ name: 'Eve', email: 'carol@example.com' }], 'id'),
            'users',
            'users_email_unique',
        ],
        [
            'an increment',
            (table: Table): Promise<unknown> => table('codes').where('code', 3).increment('code'),
            'codes',
            'codes_code_unique',
        ],
        [
            'a collision on the second of several matched rows',
            (table: Table): Promise<unknown> => table('codes').increment('code'),
            'codes',
            'codes_code_unique',
        ],
        [
            'a collision with a row the same write changed',
            (table: Table): Promise<unknown> => table('users').update({ email: 'same@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an update ordered and limited through an index',
            (table: Table): Promise<unknown> => table('nullables').orderBy('email').limit(1).update({ nickname: 'bo' }),
            'nullables',
            'nullables_nickname_unique',
        ],
        [
            'an update of the column whose index it walks',
            (table: Table): Promise<unknown> => table('users').where('email', 'bob@example.com').update({ email: 'carol@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an update ordered and limited by a column no index serves',
            (table: Table): Promise<unknown> => table('users').orderBy('name', 'desc').limit(3).update({ email: 'same@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an update through a join',
            (table: Table): Promise<unknown> => table('users').join('codes', 'users.visits', '=', 'codes.code').update({ email: 'same@example.com' }),
            'users',
            'users_email_unique',
        ],
        [
            'an insert under a key the table holds',
            (table: Table): Promise<unknown> => table('users').insert({ id: 1, name: 'Eve', email: 'eve@example.com' }),
            'users',
            'id',
        ],
        [
            'an insert colliding on a compound unique index',
            (table: Table): Promise<unknown> => table('pairs').insert({ left: 'a', right: 'b' }),
            'pairs',
            'pairs_left_right_unique',
        ],
        [
            'a multi-entry insert sharing an element',
            (table: Table): Promise<unknown> => table('tagged').insert({ title: 'C', tags: ['y', 'w'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry insert sharing an element beside elements that cannot be keys',
            (table: Table): Promise<unknown> => table('tagged').insert({ title: 'C', tags: [{}, Number.NaN, true, new Date('nope'), 'y'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry insert of a single value another record holds as an element',
            (table: Table): Promise<unknown> => table('tagged').insert({ title: 'C', tags: 7 }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry insertGetId',
            (table: Table): Promise<unknown> => table('tagged').insertGetId({ title: 'C', tags: ['x'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry update onto an element another record holds',
            (table: Table): Promise<unknown> => table('tagged').where('title', 'B').update({ tags: ['x'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry update keeping its own elements and adding one another record holds',
            (table: Table): Promise<unknown> => table('tagged').where('title', 'A').update({ tags: ['x', 'y', 'z'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry increment with an extra',
            (table: Table): Promise<unknown> => table('tagged').where('title', 'B').increment('visits', 1, { tags: ['y'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry decrement with an extra',
            (table: Table): Promise<unknown> => table('tagged').where('title', 'B').decrement('visits', 1, { tags: ['y'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry upsert inserting by another unique column',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ slug: 'c', title: 'C', tags: ['x'] }], 'slug'),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry upsert merging by another unique column',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ slug: 'b', title: 'B', tags: ['x'] }], 'slug'),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'an upsert whose elements two records hold',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ title: 'N', tags: ['x', 'z'] }], 'tags'),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'an upsert naming its update columns whose elements two records hold',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ title: 'N', tags: ['x', 'z'] }], 'tags', ['title']),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'an upsert whose second value has elements two records hold',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ title: 'N', tags: ['w'] }, { title: 'M', tags: ['y', 7] }], 'tags'),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'an upsert merging by an element into a record its other unique column then collides on',
            (table: Table): Promise<unknown> => table('tagged').upsert([{ title: 'N', slug: 'b', tags: ['x'] }], 'tags'),
            'tagged',
            'tagged_slug_unique',
        ],
        [
            'a multi-entry updateOrInsert that inserts',
            (table: Table): Promise<unknown> => table('tagged').updateOrInsert({ title: 'C' }, { tags: ['x'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'a multi-entry updateOrInsert that updates',
            (table: Table): Promise<unknown> => table('tagged').updateOrInsert({ title: 'B' }, { tags: ['y'] }),
            'tagged',
            'tagged_tags_unique',
        ],
        [
            'an insert colliding beside an object in a unique column checked before it',
            (table: Table): Promise<unknown> => table('profiles').insert({ meta: { b: 2 }, email: 'a@x' }),
            'profiles',
            'profiles_email_unique',
        ],
        [
            'an insert colliding beside an array holding an object in a unique column checked before it',
            (table: Table): Promise<unknown> => table('profiles').insert({ meta: ['q', {}], email: 'a@x' }),
            'profiles',
            'profiles_email_unique',
        ],
        [
            'an insert colliding beside a boolean in a unique column checked before it',
            (table: Table): Promise<unknown> => table('profiles').insert({ meta: true, email: 'a@x' }),
            'profiles',
            'profiles_email_unique',
        ],
        [
            'an update colliding beside an object it writes to a unique column checked before it',
            (table: Table): Promise<unknown> => table('profiles').where('email', 'bin@x').update({ meta: { d: 4 }, email: 'a@x' }),
            'profiles',
            'profiles_email_unique',
        ],
        [
            'an insert colliding beside an object in a unique column checked after it',
            (table: Table): Promise<unknown> => table('contacts').insert({ email: 'a@x', meta: { b: 2 } }),
            'contacts',
            'contacts_email_unique',
        ],
        [
            'an insert colliding on a binary value',
            (table: Table): Promise<unknown> => table('profiles').insert({ meta: new Uint8Array([1, 2]), email: 'new@x' }),
            'profiles',
            'profiles_meta_unique',
        ],
    ];

    /**
     * Get every record of the tables the writes touch, in key order.
     */
    async function snapshot(): Promise<Record<string, unknown>[][]> {
        return Promise.all(['users', 'nullables', 'codes', 'pairs', 'tagged', 'profiles', 'contacts'].map((name: string): Promise<Record<string, unknown>[]> => connection.table(name).orderBy('id').get()));
    }

    /**
     * Get every record of the tagged table, in key order.
     */
    async function tagged(): Promise<Record<string, unknown>[]> {
        return connection.table('tagged').orderBy('id').get();
    }

    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 1 },
            { name: 'Bob', email: 'bob@example.com', visits: 3 },
            { name: 'Carol', email: 'carol@example.com', visits: 4 },
        ]);

        await connection.table('nullables').insert([
            { nickname: 'al', email: 'alice@example.com' },
            { nickname: 'bo', email: 'bob@example.com' },
        ]);

        await connection.table('codes').insert([
            { code: 1, label: 'A' },
            { code: 3, label: 'B' },
            { code: 4, label: 'C' },
        ]);

        await connection.table('pairs').insert({ left: 'a', right: 'b' });

        await connection.table('tagged').insert([
            { title: 'A', slug: 'a', tags: ['x', 'y'] },
            { title: 'B', slug: 'b', tags: ['z', 7] },
        ]);

        await connection.table('profiles').insert([
            { meta: { a: 1 }, email: 'a@x' },
            { meta: new Uint8Array([1, 2]), email: 'bin@x' },
        ]);

        await connection.table('contacts').insert({ email: 'a@x', meta: { a: 1 } });
    });

    test.each(COLLISIONS)('%s throws naming the index and leaves every row as it was', async (_: string, write: (table: Table) => Promise<unknown>, table: string, index: string): Promise<void> => {
        const before: Record<string, unknown>[][] = await snapshot();
        const failure: Promise<unknown> = write((name: string): Builder<Record<string, unknown>> => connection.table(name));

        await expect(failure).rejects.toBeInstanceOf(UniqueConstraintViolationException);
        await expect(failure).rejects.toThrow(new UniqueConstraintViolationException(table, index));

        expect(await snapshot()).toEqual(before);
    });

    test.each(COLLISIONS)('%s inside a transaction rejects and rolls the whole transaction back', async (_: string, write: (table: Table) => Promise<unknown>, table: string, index: string): Promise<void> => {
        const before: Record<string, unknown>[][] = await snapshot();

        const failure: Promise<void> = connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table('users').insert({ name: 'Dave', email: 'dave@example.com' });

            await write((name: string): Builder<Record<string, unknown>> => transaction.table(name));
        });

        await expect(failure).rejects.toBeInstanceOf(UniqueConstraintViolationException);
        await expect(failure).rejects.toThrow(new UniqueConstraintViolationException(table, index));

        expect(await snapshot()).toEqual(before);
    });

    test('ignores a collision inside a transaction and keeps the rest', async (): Promise<void> => {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            expect(await transaction.table('users').insertOrIgnore([
                { name: 'Dave', email: 'dave@example.com' },
                { name: 'Eve', email: 'carol@example.com' },
            ])).toEqual(1);
        });

        expect(await users().orderBy('id').pluck('name')).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
    });

    test.each(COLLISIONS.filter((collision: Collision): boolean => collision[2] === 'tagged'))('%s inside a transaction scoped to its table rejects and rolls the whole transaction back', async (_: string, write: (table: Table) => Promise<unknown>, table: string, index: string): Promise<void> => {
        const before: Record<string, unknown>[][] = await snapshot();

        const failure: Promise<void> = connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table('tagged').insert({ title: 'D', tags: ['d'] });

            await write((name: string): Builder<Record<string, unknown>> => transaction.table(name));
        }, { tables: ['tagged'] });

        await expect(failure).rejects.toThrow(new UniqueConstraintViolationException(table, index));

        expect(await snapshot()).toEqual(before);
    });

    test('ignores a multi-entry collision and keeps the rest', async (): Promise<void> => {
        expect(await connection.table('tagged').insertOrIgnore([
            { title: 'C', tags: ['w'] },
            { title: 'D', tags: ['v', 'y'] },
            { title: 'E', tags: ['u', 'u'] },
        ])).toEqual(2);

        expect(await connection.table('tagged').orderBy('id').pluck('title')).toEqual(['A', 'B', 'C', 'E']);
    });

    test('merges an upsert into the one record holding an element of its array', async (): Promise<void> => {
        expect(await connection.table('tagged').upsert([{ title: 'N', tags: ['x', 'w'] }], 'tags')).toEqual(1);

        expect(await tagged()).toEqual([
            { id: 1, title: 'N', slug: 'a', visits: 0, tags: ['x', 'w'] },
            { id: 2, title: 'B', slug: 'b', visits: 0, tags: ['z', 7] },
        ]);
    });

    test('merges an upsert into the record holding every element of its array', async (): Promise<void> => {
        expect(await connection.table('tagged').upsert([{ title: 'N', tags: ['y', 'x'] }], 'tags')).toEqual(1);

        expect(await tagged()).toEqual([
            { id: 1, title: 'N', slug: 'a', visits: 0, tags: ['y', 'x'] },
            { id: 2, title: 'B', slug: 'b', visits: 0, tags: ['z', 7] },
        ]);
    });

    test('merges only the named columns into the record holding an element', async (): Promise<void> => {
        expect(await connection.table('tagged').upsert([{ title: 'N', tags: ['x', 'w'] }], 'tags', ['title'])).toEqual(1);

        expect(await tagged()).toEqual([
            { id: 1, title: 'N', slug: 'a', visits: 0, tags: ['x', 'y'] },
            { id: 2, title: 'B', slug: 'b', visits: 0, tags: ['z', 7] },
        ]);
    });

    test('merges a single value into the record holding it as an element', async (): Promise<void> => {
        expect(await connection.table('tagged').upsert([{ title: 'N', tags: 7 }], 'tags')).toEqual(1);

        expect(await tagged()).toEqual([
            { id: 1, title: 'A', slug: 'a', visits: 0, tags: ['x', 'y'] },
            { id: 2, title: 'N', slug: 'b', visits: 0, tags: 7 },
        ]);
    });

    test('merges an upsert repeating an element into the record it inserted', async (): Promise<void> => {
        await connection.table('tagged').upsert([{ title: 'N', tags: ['w', 'w'] }], 'tags');
        await connection.table('tagged').upsert([{ title: 'M', tags: ['w', 'w'] }], 'tags');

        expect(await connection.table('tagged').orderBy('id').pluck('title')).toEqual(['A', 'B', 'M']);
    });

    test('inserts an upsert whose array shares no element', async (): Promise<void> => {
        expect(await connection.table('tagged').upsert([{ title: 'N', tags: ['w'] }], 'tags')).toEqual(1);

        expect(await connection.table('tagged').orderBy('id').pluck('title')).toEqual(['A', 'B', 'N']);
    });

    test.each([
        ['an empty array', []],
        ['null', null],
        ['an object', { a: 1 }],
        ['a boolean', true],
    ])('inserts an upsert whose multi-entry conflict value is %s every time', async (_: string, tags: unknown): Promise<void> => {
        await connection.table('tagged').upsert([{ title: 'N', tags }], 'tags');
        await connection.table('tagged').upsert([{ title: 'M', tags }], 'tags');

        expect(await connection.table('tagged').orderBy('id').pluck('title')).toEqual(['A', 'B', 'N', 'M']);
    });

    test('inserts an upsert whose plain unique conflict value cannot be a key', async (): Promise<void> => {
        expect(await connection.table('profiles').upsert([{ meta: { a: 1 }, email: 'new@x' }], 'meta')).toEqual(1);

        expect(await connection.table('profiles').orderBy('id').pluck('email')).toEqual(['a@x', 'bin@x', 'new@x']);
    });
});

describe('Builder unique violations on a JSON column', (): void => {
    beforeEach(async (): Promise<void> => {
        await connection.table('schedules').insert([
            { label: 'A', slots: [new Date(0)] },
            { label: 'B', slots: [new Date(0).toISOString()] },
        ]);
    });

    test('names the index when an update replaces a date string with the date it spells', async (): Promise<void> => {
        const before: Record<string, unknown>[] = await connection.table('schedules').orderBy('id').get();
        const failure: Promise<number> = connection.table('schedules').where('label', 'B').update({ slots: [new Date(0)] });

        await expect(failure).rejects.toThrow(new UniqueConstraintViolationException('schedules', 'schedules_slots_unique'));
        expect(await connection.table('schedules').orderBy('id').get()).toEqual(before);
    });

    test('names the index when an upsert does the same', async (): Promise<void> => {
        const failure: Promise<number> = connection.table('schedules').upsert([{ id: 2, label: 'B', slots: [new Date(0)] }], 'id');

        await expect(failure).rejects.toThrow(new UniqueConstraintViolationException('schedules', 'schedules_slots_unique'));
    });
});

describe('Builder writes through key path point lookups', (): void => {
    test('updates several records by key', async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
        ]);

        expect(await users().whereIn('id', [1, 3]).update({ role: 'owner' })).toEqual(2);
        expect(await users().where('role', 'owner').count()).toEqual(2);
    });

    test('honors a limit across several keys', async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
        ]);

        expect(await users().whereIn('id', [1, 2, 3]).limit(1).delete()).toEqual(1);
        expect(await users().count()).toEqual(2);
    });
});

describe('Builder increment on a null column', (): void => {
    const EPOCH: Date = new Date(0);

    /**
     * Write records to the users table past the package.
     */
    async function planted(records: Record<string, unknown>[]): Promise<void> {
        const database: IDBDatabase = await connection.open();
        const transaction: IDBTransaction = database.transaction('users', 'readwrite');

        for (const record of records) {
            transaction.objectStore('users').add(record);
        }

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            transaction.oncomplete = (): void => resolve();
            transaction.onerror = (): void => reject(transaction.error);
        });
    }

    test('leaves a null value null', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().where('name', 'Alice').value('score')).toBeNull();

        await users().where('name', 'Alice').increment('score', 3);

        expect(await users().where('name', 'Alice').value('score')).toBeNull();
    });

    test('leaves a null value null on a decrement', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().decrement('score', 3)).toEqual(1);
        expect(await users().value('score')).toBeNull();
    });

    test('applies the extra columns and touches updated_at while the column stays null', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', created_at: EPOCH, updated_at: EPOCH });

        await users().increment('score', 1, { role: 'owner' });

        const alice: User = await users().firstOrFail();

        expect([alice.score, alice.role, alice.created_at]).toEqual([null, 'owner', EPOCH]);
        expect(alice.updated_at?.getTime()).toBeGreaterThan(0);
    });

    test('steps a column holding a number beside one holding null, counting both', async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com', score: 4 },
        ]);

        expect(await users().increment('score', 3)).toEqual(2);
        expect(await users().orderBy('id').pluck('score')).toEqual([null, 7]);
    });

    test('leaves a column absent from the record absent', async (): Promise<void> => {
        await planted([{ id: 1, name: 'Alice', email: 'alice@example.com', role: 'member', visits: 0, nickname: null, updated_at: EPOCH }]);

        expect(await users().increment('score', 1, { role: 'owner' })).toEqual(1);

        const alice: Record<string, unknown> = await users().firstOrFail() as unknown as Record<string, unknown>;

        expect(Object.hasOwn(alice, 'score')).toEqual(false);
        expect(alice.role).toEqual('owner');
        expect((alice.updated_at as Date).getTime()).toBeGreaterThan(0);
    });

    test('leaves null in a required column without refusing the write', async (): Promise<void> => {
        await planted([{ id: 1, name: 'Alice', email: 'alice@example.com', role: 'member', visits: null, nickname: null, score: null }]);

        expect(await users().increment('visits', 1, { role: 'owner' })).toEqual(1);
        expect(await users().firstOrFail()).toMatchObject({ visits: null, role: 'owner' });
    });

    test('leaves a null value null under a fractional amount', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().increment('score', 0.5)).toEqual(1);
        expect(await users().value('score')).toBeNull();
    });

    test('still refuses an amount that is not a finite number on a null value', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        await expect(users().increment('score', Number.NaN)).rejects.toThrow(TypeError);
    });

    test('leaves a null value out of a unique index the other records step through', async (): Promise<void> => {
        await connection.table('seats').insert([{ label: 'A', seat: null }, { label: 'B', seat: 5 }]);

        expect(await connection.table('seats').increment('seat', 5)).toEqual(2);
        expect(await connection.table('seats').orderBy('id').pluck('seat')).toEqual([null, 10]);
    });

    describe('with an extra naming the stepped column', (): void => {
        beforeEach(async (): Promise<void> => {
            await users().insert([
                { name: 'Alice', email: 'alice@example.com' },
                { name: 'Bob', email: 'bob@example.com', score: 4 },
            ]);
        });

        test('writes the extra over a null and a number, beside the other extras', async (): Promise<void> => {
            expect(await users().increment('score', 1, { score: 10, role: 'owner' })).toEqual(2);
            expect(await users().orderBy('id').get()).toMatchObject([
                { score: 10, role: 'owner' },
                { score: 10, role: 'owner' },
            ]);
        });

        test('writes the extra on a decrement', async (): Promise<void> => {
            expect(await users().decrement('score', 1, { score: 10 })).toEqual(2);
            expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
        });

        test('writes the extra when it names the column with its table', async (): Promise<void> => {
            expect(await users().increment('score', 1, { 'users.score': 10 } as Partial<User>)).toEqual(2);
            expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
        });

        test('coerces the extra as an update does', async (): Promise<void> => {
            expect(await users().increment('score', 1, { score: '10' as unknown as number })).toEqual(2);
            expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
        });

        test('writes the extra where the step cannot be taken', async (): Promise<void> => {
            expect(await users().increment('visits', 0.5, { visits: 10 })).toEqual(2);
            expect(await users().orderBy('id').pluck('visits')).toEqual([10, 10]);
        });

        test('still refuses an amount that is not a finite number', async (): Promise<void> => {
            await expect(users().increment('score', Number.NaN, { score: 10 })).rejects.toThrow(TypeError);

            expect(await users().orderBy('id').pluck('score')).toEqual([null, 4]);
        });

        test('refuses an extra the column cannot hold and writes none of the records', async (): Promise<void> => {
            await expect(users().increment('score', 1, { score: 'abc' as unknown as number })).rejects.toThrow(TypeError);
            await expect(users().increment('visits', 1, { visits: null as unknown as number })).rejects.toBeInstanceOf(NotNullConstraintViolationException);

            expect(await users().orderBy('id').get()).toMatchObject([
                { score: null, visits: 0 },
                { score: 4, visits: 0 },
            ]);
        });

        test('writes the extra on a joined query', async (): Promise<void> => {
            await connection.table('pairs').insert([{ left: 'Alice', right: 'a' }, { left: 'Bob', right: 'b' }]);

            expect(await users().join('pairs', 'pairs.left', '=', 'users.name').increment('score', 1, { 'users.score': 10 } as Partial<User>)).toEqual(2);
            expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
        });

        test('writes the extra inside a transaction', async (): Promise<void> => {
            await connection.transaction(async (transaction: Transaction): Promise<void> => {
                expect(await transaction.table<User>('users').increment('score', 1, { score: 10 })).toEqual(2);
            });

            expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
        });
    });

    test('writes an extra naming the stepped column into a record the column is absent from', async (): Promise<void> => {
        await planted([{ id: 1, name: 'Alice', email: 'alice@example.com', role: 'member', visits: 0, nickname: null }]);

        expect(await users().increment('score', 1, { score: 10 })).toEqual(1);
        expect(await users().value('score')).toEqual(10);
    });

    test('writes an extra naming the stepped column over held values Number cannot read', async (): Promise<void> => {
        await planted([
            { id: 1, name: 'Alice', email: 'alice@example.com', role: 'member', visits: 0, nickname: null, score: 'abc' },
            { id: 2, name: 'Bob', email: 'bob@example.com', role: 'member', visits: 0, nickname: null, score: '4' },
        ]);

        expect(await users().increment('score', 1, { score: 10 })).toEqual(2);
        expect(await users().orderBy('id').pluck('score')).toEqual([10, 10]);
    });
});

describe('Builder writes of values a strict connection cannot store faithfully', (): void => {
    test('stores null for a blank string in a nullable number column on insert', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', score: '' as unknown as number });

        expect(await users().value('score')).toBeNull();
    });

    test('refuses a blank string in a required number column on insert', async (): Promise<void> => {
        await expect(users().insert({ name: 'Alice', email: 'alice@example.com', visits: ' ' as unknown as number })).rejects.toThrow(
            new NotNullConstraintViolationException('users', 'visits'),
        );

        expect(await users().count()).toEqual(0);
    });

    test('stores null for a blank string in a nullable number column on update', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', score: 4 });
        await users().update({ score: ' ' as unknown as number });

        expect(await users().value('score')).toBeNull();
    });

    test('refuses a blank string in a required number column on update', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', visits: 4 });

        await expect(users().update({ visits: '' as unknown as number })).rejects.toThrow(new NotNullConstraintViolationException('users', 'visits'));

        expect(await users().value('visits')).toEqual(4);
    });

    test('stores null for a blank string in a nullable datetime column', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', created_at: '' as unknown as Date });

        expect(await users().value('created_at')).toBeNull();
    });

    test.each([
        ['a fraction in an integer column', { visits: 1.9 }],
        ['a fractional string in an integer column', { visits: '1.9' }],
        ['a boolean in a number column', { score: true }],
        ['an empty array in a number column', { score: [] }],
        ['an object in a string column', { nickname: {} }],
        ['a number string in a datetime column', { created_at: '1' }],
        ['a date that rolls over in a datetime column', { created_at: '2024-02-30' }],
    ] as [string, Record<string, unknown>][])('refuses %s', async (_: string, values: Record<string, unknown>): Promise<void> => {
        await expect(users().insert({ name: 'Alice', email: 'alice@example.com', ...values } as Partial<User>)).rejects.toThrow(TypeError);

        expect(await users().count()).toEqual(0);
    });

    test('stores a date written to a string column as its ISO string', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com', nickname: new Date('2024-01-15T10:00:00.000Z') as unknown as string });

        expect(await users().value('nickname')).toEqual('2024-01-15T10:00:00.000Z');
    });
});

describe('Builder upsert conflict keys a strict connection coerces', (): void => {
    test('refuses a fractional integer conflict key rather than merging', async (): Promise<void> => {
        await connection.table('codes').insert({ code: 5, label: 'A' });

        await expect(connection.table('codes').upsert([{ code: '5.5', label: 'B' }], 'code')).rejects.toThrow(TypeError);

        expect(await connection.table('codes').get()).toEqual([{ id: 1, code: 5, label: 'A' }]);
    });

    test('refuses a fractional key path', async (): Promise<void> => {
        await expect(users().upsert([{ id: 1.5, name: 'Alice', email: 'alice@example.com' }], 'id')).rejects.toThrow(TypeError);

        expect(await users().count()).toEqual(0);
    });

    test('inserts when a blank conflict key reads as null, rather than merging into zero', async (): Promise<void> => {
        await connection.table('seats').insert({ label: 'Zero', seat: 0 });

        expect(await connection.table('seats').upsert([{ label: 'Blank', seat: '' }], 'seat')).toEqual(1);
        expect(await connection.table('seats').orderBy('id').get()).toEqual([{ id: 1, label: 'Zero', seat: 0 }, { id: 2, label: 'Blank', seat: null }]);
    });

    test('inserts every record whose conflict key is null', async (): Promise<void> => {
        await connection.table('nullables').upsert([{ nickname: null, email: 'alice@example.com' }], 'nickname');
        await connection.table('nullables').upsert([{ nickname: null, email: 'bob@example.com' }], 'nickname');

        expect(await connection.table('nullables').orderBy('id').pluck('email')).toEqual(['alice@example.com', 'bob@example.com']);
    });

    test('inserts a record missing its conflict key', async (): Promise<void> => {
        await connection.table('nullables').insert({ nickname: 'al', email: 'alice@example.com' });
        await connection.table('nullables').upsert([{ email: 'bob@example.com' }], 'nickname');

        expect(await connection.table('nullables').orderBy('id').pluck('nickname')).toEqual(['al', null]);
    });

    test('reports a null in a required column of a compound conflict key as the insert would', async (): Promise<void> => {
        await connection.table('pairs').insert({ left: 'a', right: 'b', count: 1 });

        await expect(connection.table('pairs').upsert([{ left: 'a', right: null, count: 9 }], ['left', 'right'])).rejects.toThrow(
            new NotNullConstraintViolationException('pairs', 'right'),
        );

        expect(await connection.table('pairs').count()).toEqual(1);
    });
});

describe('Builder writes of a date-only string', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let dated: Connection;

    /**
     * Begin a query against the birthdays table.
     */
    function birthdays(): Builder<Birthday> {
        return dated.table<Birthday>('birthdays');
    }

    /**
     * Get the local calendar day and hour a stored value falls on.
     */
    function local(value: Date | null): number[] {
        return value === null ? [] : [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours()];
    }

    /**
     * Migrate a database of its own on a connection set to the given timezone.
     */
    async function connect(timezone: string): Promise<void> {
        dated?.disconnect();

        dated = new Connection('app', { database: `builder-writes-dated-${++sequence}`, migrations: [CreateUsersTable], timezone });

        await dated.migrate();
    }

    afterEach((): void => {
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    describe('on a local connection', (): void => {
        beforeEach(async (): Promise<void> => {
            await connect('local');
        });

        describe.each(['America/New_York', 'Asia/Tokyo', 'America/Santiago'])('in %s', (timezone: string): void => {
            beforeEach((): void => {
                vi.stubEnv('TZ', timezone);
            });

            test('stores it as the local day in a date and a datetime column, and a date-only default too', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([local(alice.born), local(alice.seen), local(alice.noted)]).toEqual([[2024, 1, 15, 0], [2024, 1, 15, 0], [2024, 1, 15, 0]]);
            });

            test('stores it as the local day on update and alongside an increment', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice' });

                await birthdays().update({ born: '2024-02-29' as unknown as Date });
                await birthdays().increment('visits', 1, { seen: '2024-03-01' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([local(alice.born), local(alice.seen)]).toEqual([[2024, 2, 29, 0], [2024, 3, 1, 0]]);
            });

            test('finds the row it wrote by the same string', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date });

                expect(await birthdays().where('born', '2024-01-15').explain()).toEqual('index:birthdays_born_unique');
                expect(await birthdays().where('born', '2024-01-15').pluck('name')).toEqual(['Alice']);
            });

            test('merges an upsert keyed on it into the row the same string wrote', async (): Promise<void> => {
                await birthdays().upsert([{ name: 'Alice', born: '2024-01-15' as unknown as Date }], 'born');
                await birthdays().upsert([{ name: 'Alicia', born: '2024-01-15' as unknown as Date }], 'born');

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('updates through updateOrInsert the row the same string wrote', async (): Promise<void> => {
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alice' })).toEqual(true);
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alicia' })).toEqual(false);

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('refuses a day the calendar does not have, and a date-only string padded with spaces', async (): Promise<void> => {
                await expect(birthdays().insert({ name: 'Alice', born: '2024-02-30' as unknown as Date })).rejects.toThrow(TypeError);
                await expect(birthdays().insert({ name: 'Alice', born: ' 2024-01-15 ' as unknown as Date })).rejects.toThrow(TypeError);

                expect(await birthdays().count()).toEqual(0);
            });
        });

        test('stores a day whose midnight is skipped as its first moment', async (): Promise<void> => {
            vi.stubEnv('TZ', 'America/Santiago');

            await birthdays().insert({ name: 'Alice', born: '2024-09-08' as unknown as Date });

            expect(local((await birthdays().firstOrFail()).born)).toEqual([2024, 9, 8, 1]);
            expect(await birthdays().where('born', '2024-09-08').pluck('name')).toEqual(['Alice']);
        });
    });

    describe.each([
        ['UTC', '2024-01-15T00:00:00.000Z', '2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z', '2024-01-15T10:00:00.000Z'],
        ['America/New_York', '2024-01-15T05:00:00.000Z', '2024-02-29T05:00:00.000Z', '2024-03-01T05:00:00.000Z', '2024-01-15T15:00:00.000Z'],
    ])('on a connection set to %s', (timezone: string, january: string, leap: string, march: string, morning: string): void => {
        beforeEach(async (): Promise<void> => {
            await connect(timezone);
        });

        describe.each(['America/New_York', 'Asia/Tokyo', 'America/Santiago'])('with the process in %s', (process: string): void => {
            beforeEach((): void => {
                vi.stubEnv('TZ', process);
            });

            test('stores it as midnight in that timezone in a date and a datetime column, and a date-only default too', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([alice.born?.toISOString(), alice.seen?.toISOString(), alice.noted.toISOString()]).toEqual([january, january, january]);
            });

            test('stores it as midnight in that timezone on update and alongside an increment', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice' });

                await birthdays().update({ born: '2024-02-29' as unknown as Date });
                await birthdays().increment('visits', 1, { seen: '2024-03-01' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([alice.born?.toISOString(), alice.seen?.toISOString()]).toEqual([leap, march]);
            });

            test.each([
                ['born', 'index:birthdays_born_unique'],
                ['seen', 'scan'],
            ] as ['born' | 'seen', string][])('finds the row it wrote in %s by the same string under every constraint', async (column: 'born' | 'seen', plan: string): Promise<void> => {
                await birthdays().insert([
                    { name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date },
                    { name: 'Bob', born: '2024-01-16' as unknown as Date, seen: '2024-01-16' as unknown as Date },
                ]);

                expect(await birthdays().where(column, '2024-01-15').explain()).toEqual(plan);
                expect(await birthdays().where(column, '2024-01-15').pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereIn(column, ['2024-01-15']).pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereBetween(column, ['2024-01-15', '2024-01-15']).pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereDate(column, '2024-01-15').pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereDay(column, 15).pluck('name')).toEqual(['Alice']);
            });

            test('merges an upsert keyed on it into the row the same string wrote', async (): Promise<void> => {
                await birthdays().upsert([{ name: 'Alice', born: '2024-01-15' as unknown as Date }], 'born');
                await birthdays().upsert([{ name: 'Alicia', born: '2024-01-15' as unknown as Date }], 'born');

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('updates through updateOrInsert the row the same string wrote', async (): Promise<void> => {
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alice' })).toEqual(true);
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alicia' })).toEqual(false);

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('stores a time without an offset as that wall clock, and one with an offset as the moment it names', async (): Promise<void> => {
                await birthdays().insert([
                    { name: 'Alice', seen: '2024-01-15 10:00' as unknown as Date },
                    { name: 'Bob', seen: '2024-01-15T10:00:00+02:00' as unknown as Date },
                    { name: 'Carol', seen: '2024-01-15T12:00:00Z' as unknown as Date },
                ]);

                expect((await birthdays().orderBy('id').get()).map((birthday: Birthday): string | undefined => birthday.seen?.toISOString())).toEqual([
                    morning,
                    '2024-01-15T08:00:00.000Z',
                    '2024-01-15T12:00:00.000Z',
                ]);
                expect(await birthdays().where('seen', '2024-01-15 10:00').pluck('name')).toEqual(['Alice']);
            });

            test('refuses a day the calendar does not have, and a date-only string padded with spaces', async (): Promise<void> => {
                await expect(birthdays().insert({ name: 'Alice', born: '2024-02-30' as unknown as Date })).rejects.toThrow(TypeError);
                await expect(birthdays().insert({ name: 'Alice', born: ' 2024-01-15 ' as unknown as Date })).rejects.toThrow(TypeError);

                expect(await birthdays().count()).toEqual(0);
            });
        });
    });

    test('stores a day whose midnight Santiago skips as its first moment there, whatever the process', async (): Promise<void> => {
        await connect('America/Santiago');

        vi.stubEnv('TZ', 'Asia/Tokyo');

        await birthdays().insert({ name: 'Alice', born: '2024-09-08' as unknown as Date });

        expect((await birthdays().firstOrFail()).born?.toISOString()).toEqual('2024-09-08T04:00:00.000Z');
        expect(await birthdays().where('born', '2024-09-08').pluck('name')).toEqual(['Alice']);
    });
});

describe('Builder increment and decrement by values a column cannot hold', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 5 },
            { name: 'Bob', email: 'bob@example.com', visits: 10 },
        ]);
    });

    test('refuses a step that leaves a fraction in an integer column and writes none of the records', async (): Promise<void> => {
        await expect(users().increment('visits', 0.5)).rejects.toThrow(TypeError);

        expect(await users().orderBy('id').pluck('visits')).toEqual([5, 10]);
    }, 2000);

    test('refuses a decrement that leaves a fraction in an integer column', async (): Promise<void> => {
        await expect(users().where('name', 'Bob').decrement('visits', 1.5)).rejects.toThrow(TypeError);

        expect(await users().orderBy('id').pluck('visits')).toEqual([5, 10]);
    }, 2000);

    test('refuses a fractional step inside a transaction and rolls it back', async (): Promise<void> => {
        await expect(connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').where('name', 'Alice').update({ name: 'Alicia' });
            await transaction.table<User>('users').increment('visits', 0.5);
        })).rejects.toThrow(TypeError);

        expect(await users().orderBy('id').pluck('name')).toEqual(['Alice', 'Bob']);
        expect(await users().orderBy('id').pluck('visits')).toEqual([5, 10]);
    }, 2000);

    test.each([
        [Number.NaN],
        [Number.POSITIVE_INFINITY],
        [Number.NEGATIVE_INFINITY],
        ['5'],
        [null],
    ] as [unknown][])('refuses the amount %o', async (amount: unknown): Promise<void> => {
        await expect(users().increment('visits', amount as number)).rejects.toThrow(
            new TypeError(`Unable to step column [visits] by [${String(amount)}], which is not a finite number.`),
        );

        expect(await users().orderBy('id').pluck('visits')).toEqual([5, 10]);
    });

    test('refuses a step that leaves a column holding no number', async (): Promise<void> => {
        await expect(users().increment('name', 1)).rejects.toThrow(TypeError);

        expect(await users().orderBy('id').pluck('name')).toEqual(['Alice', 'Bob']);
    }, 2000);

    test('refuses a fractional step on a joined query', async (): Promise<void> => {
        await connection.table('pairs').insert({ left: 'a', right: 'b', count: 5 });

        await expect(users().join('pairs', 'pairs.count', '=', 'users.visits').increment('visits', 0.5)).rejects.toThrow(TypeError);

        expect(await users().orderBy('id').pluck('visits')).toEqual([5, 10]);
    }, 2000);
});

describe('Builder writes of values a loose connection cannot store faithfully', (): void => {
    let loose: Connection;

    /**
     * Begin a query against the users table on the loose connection.
     */
    function people(): Builder<User> {
        return loose.table<User>('users');
    }

    beforeEach(async (): Promise<void> => {
        loose = new Connection('app', { database: `builder-writes-loose-${++sequence}`, migrations: [CreateUsersTable], strict: false });

        await loose.migrate();
    });

    afterEach((): void => {
        loose.disconnect();
    });

    test('writes null for what it cannot store', async (): Promise<void> => {
        await people().insert({
            name      : {} as unknown as string,
            email     : 'alice@example.com',
            visits    : '' as unknown as number,
            score     : true as unknown as number,
            created_at: '1' as unknown as Date,
        });

        const alice: User = await people().firstOrFail();

        expect([alice.name, alice.visits, alice.score, alice.created_at]).toEqual([null, null, null, null]);
    });

    test('rounds a fraction written to an integer column', async (): Promise<void> => {
        await people().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 1.5 },
            { name: 'Bob', email: 'bob@example.com', visits: -1.5 },
            { name: 'Carol', email: 'carol@example.com', visits: '7.9' as unknown as number },
        ]);

        expect(await people().orderBy('id').pluck('visits')).toEqual([2, -1, 8]);
    });

    test('rounds a step that leaves a fraction in an integer column', async (): Promise<void> => {
        await people().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 5 },
            { name: 'Bob', email: 'bob@example.com', visits: 10 },
        ]);

        expect(await people().increment('visits', 0.5)).toEqual(2);
        expect(await people().orderBy('id').pluck('visits')).toEqual([6, 11]);
    }, 2000);

    test('still refuses an amount that is not a finite number', async (): Promise<void> => {
        await people().insert({ name: 'Alice', email: 'alice@example.com', visits: 5 });

        await expect(people().increment('visits', Number.NaN)).rejects.toThrow(TypeError);
    });

    test('leaves null in a nullable and a required column as null', async (): Promise<void> => {
        await people().insert([
            { name: 'Alice', email: 'alice@example.com', visits: '' as unknown as number },
            { name: 'Bob', email: 'bob@example.com', visits: 4, score: 4 },
        ]);

        expect(await people().increment('visits', 1, { role: 'owner' })).toEqual(2);
        expect(await people().decrement('score', 2)).toEqual(2);
        expect(await people().orderBy('id').get()).toMatchObject([
            { visits: null, score: null, role: 'owner' },
            { visits: 5, score: 2, role: 'owner' },
        ]);
    });

    test('writes null for an extra naming the stepped column that it cannot store', async (): Promise<void> => {
        await people().insert([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com', score: 4 },
        ]);

        expect(await people().increment('score', 1, { score: 'abc' as unknown as number })).toEqual(2);
        expect(await people().orderBy('id').pluck('score')).toEqual([null, null]);
    });
});

describe('Builder writes naming a column with the query\'s own table', (): void => {
    beforeEach(async (): Promise<void> => {
        await users().insert([
            { name: 'Alice', email: 'alice@example.com', visits: 5 },
            { name: 'Bob', email: 'bob@example.com', visits: 10 },
        ]);
    });

    test('updates the column, writing no key named after the table', async (): Promise<void> => {
        expect(await users().where('users.name', 'Alice').update({ 'users.visits': 9, 'users.nickname': 'Al' } as Partial<User>)).toEqual(1);

        const alice: Record<string, unknown> = await users().where('name', 'Alice').firstOrFail() as unknown as Record<string, unknown>;

        expect([alice.visits, alice.nickname]).toEqual([9, 'Al']);
        expect(Object.keys(alice).filter((key: string): boolean => key.includes('.'))).toEqual([]);
    });

    test('increments and decrements the column, with extras named the same way', async (): Promise<void> => {
        expect(await users().where('name', 'Alice').increment('users.visits', 2, { 'users.nickname': 'Al' } as Partial<User>)).toEqual(1);
        expect(await users().where('name', 'Bob').decrement('users.visits')).toEqual(1);

        expect(await users().orderBy('id').pluck('visits')).toEqual([7, 9]);
        expect(await users().where('name', 'Alice').value('nickname')).toEqual('Al');
    });

    test('upserts through the column as the conflict target and as a column to update', async (): Promise<void> => {
        expect(await users().upsert([{ name: 'Alicia', email: 'alice@example.com', visits: 1 }], 'users.email', ['users.visits'])).toEqual(1);

        expect(await users().where('email', 'alice@example.com').first()).toMatchObject({ name: 'Alice', visits: 1 });
        expect(await users().count()).toEqual(2);
    });

    test.each([
        ['update', (): Promise<unknown> => users().update({ 'codes.label': 'x' } as Partial<User>)],
        ['increment', (): Promise<unknown> => users().increment('codes.code')],
        ['decrement', (): Promise<unknown> => users().decrement('visits', 1, { 'codes.label': 'x' } as Partial<User>)],
        ['an upsert conflict target', (): Promise<unknown> => users().upsert([{ name: 'Alice', email: 'alice@example.com' }], 'codes.code')],
        ['an upsert column to update', (): Promise<unknown> => users().upsert([{ name: 'Alice', email: 'alice@example.com' }], 'email', ['codes.label'])],
    ] as [string, () => Promise<unknown>][])('refuses another table\'s column in %s, writing nothing', async (_: string, write: () => Promise<unknown>): Promise<void> => {
        const before: User[] = await users().get();

        await expect(write()).rejects.toThrow('names table [codes], which this query does not read.');
        expect(await users().get()).toEqual(before);
    });
});
