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

    test('treats an absent column as zero', async (): Promise<void> => {
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
        expect(walks.map((walk: MockInstance): number => walk.mock.calls.length)).toEqual([1, 0, 0]);
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
    ];

    /**
     * Get every record of the tables the writes touch, in key order.
     */
    async function snapshot(): Promise<Record<string, unknown>[][]> {
        return Promise.all(['users', 'nullables', 'codes'].map((name: string): Promise<Record<string, unknown>[]> => connection.table(name).orderBy('id').get()));
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
    test('treats a null value as zero', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().where('name', 'Alice').value('score')).toBeNull();

        await users().where('name', 'Alice').increment('score', 3);

        expect(await users().where('name', 'Alice').value('score')).toEqual(3);
    });
});
