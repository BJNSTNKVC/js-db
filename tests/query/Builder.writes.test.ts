import { beforeEach, describe, expect, test, vi } from 'vitest';
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

    test('deletes through an index range', async (): Promise<void> => {
        expect(await users().where('email', 'bob@example.com').delete()).toEqual(1);
    });

    test('deletes every record when unconstrained', async (): Promise<void> => {
        expect(await users().delete()).toEqual(3);
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
});

describe('Builder increment on a null column', (): void => {
    test('treats a null value as zero', async (): Promise<void> => {
        await users().insert({ name: 'Alice', email: 'alice@example.com' });

        expect(await users().where('name', 'Alice').value('score')).toBeNull();

        await users().where('name', 'Alice').increment('score', 3);

        expect(await users().where('name', 'Alice').value('score')).toEqual(3);
    });
});
