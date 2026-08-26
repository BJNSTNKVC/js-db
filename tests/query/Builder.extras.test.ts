import { beforeAll, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { MultipleRecordsFoundException, RecordsNotFoundException, UniqueConstraintViolationException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { Paginated } from '../../src/query/types';

interface User {
    id: number;
    name: string;
    email: string;
    role: string;
    seen_at: Date | null;
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
            table.string('role');
            table.datetime('seen_at').nullable();
        });
    }
}

const seed: Omit<User, 'id'>[] = [
    { name: 'Alice', email: 'alice@example.com', role: 'admin', seen_at: new Date('2026-02-01T09:30:00.000Z') },
    { name: 'Bob', email: 'bob@example.com', role: 'member', seen_at: new Date('2026-02-01T18:45:00.000Z') },
    { name: 'Carol', email: 'carol@example.com', role: 'member', seen_at: new Date('2026-03-15T00:00:00.000Z') },
    { name: 'Dave', email: 'dave@example.com', role: 'member', seen_at: null },
    { name: 'Erin', email: 'erin@example.com', role: 'owner', seen_at: new Date('2025-12-25T00:00:00.000Z') },
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
    connection = new Connection('app', { database: 'builder-extras', migrations: [CreateUsersTable] });

    await connection.migrate();
    await users().insert(seed);
});

describe('Builder.paginate', (): void => {
    test('returns a page alongside the totals', async (): Promise<void> => {
        const page: Paginated<User> = await users().orderBy('name').paginate(1, 2);

        expect(page.data.map((user: User): string => user.name)).toEqual(['Alice', 'Bob']);
        expect(page.total).toEqual(5);
        expect(page.perPage).toEqual(2);
        expect(page.currentPage).toEqual(1);
        expect(page.lastPage).toEqual(3);
    });

    test('counts what the query matches rather than what the page returns', async (): Promise<void> => {
        const page: Paginated<User> = await users().where('role', 'member').orderBy('name').paginate(1, 1);

        expect(page.data).toHaveLength(1);
        expect(page.total).toEqual(3);
        expect(page.lastPage).toEqual(3);
    });

    test('returns a later page', async (): Promise<void> => {
        const page: Paginated<User> = await users().orderBy('name').paginate(3, 2);

        expect(page.data.map((user: User): string => user.name)).toEqual(['Erin']);
        expect(page.currentPage).toEqual(3);
    });

    test('defaults to the first page of fifteen', async (): Promise<void> => {
        const page: Paginated<User> = await users().paginate();

        expect(page.perPage).toEqual(15);
        expect(page.currentPage).toEqual(1);
        expect(page.lastPage).toEqual(1);
    });

    test('reports one page when nothing matches', async (): Promise<void> => {
        const page: Paginated<User> = await users().where('name', 'Nobody').paginate();

        expect(page.data).toEqual([]);
        expect(page.total).toEqual(0);
        expect(page.lastPage).toEqual(1);
    });

    test('leaves the query it was called on alone', async (): Promise<void> => {
        const query: Builder<User> = users().orderBy('name');

        await query.paginate(1, 2);

        expect(await query.get()).toHaveLength(5);
    });
});


describe('Builder.lazy', (): void => {
    test('yields every matching record', async (): Promise<void> => {
        const seen: string[] = [];

        for await (const user of users().orderBy('name').lazy()) {
            seen.push(user.name);
        }

        expect(seen).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('yields across page boundaries', async (): Promise<void> => {
        const seen: string[] = [];

        for await (const user of users().orderBy('name').lazy(2)) {
            seen.push(user.name);
        }

        expect(seen).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('stops fetching once the caller breaks out', async (): Promise<void> => {
        const seen: string[] = [];

        for await (const user of users().orderBy('name').lazy(2)) {
            seen.push(user.name);

            if (seen.length === 2) {
                break;
            }
        }

        expect(seen).toEqual(['Alice', 'Bob']);
    });

    test('honours the constraints of the query', async (): Promise<void> => {
        const seen: string[] = [];

        for await (const user of users().where('role', 'member').orderBy('name').lazy()) {
            seen.push(user.name);
        }

        expect(seen).toEqual(['Bob', 'Carol', 'Dave']);
    });

    test('projects the selected columns', async (): Promise<void> => {
        const seen: User[] = [];

        for await (const user of users().orderBy('name').select('name').lazy()) {
            seen.push(user);
        }

        expect(seen[0]).toEqual({ name: 'Alice' });
    });

    test('yields nothing when nothing matches', async (): Promise<void> => {
        const seen: User[] = [];

        for await (const user of users().where('name', 'Nobody').lazy()) {
            seen.push(user);
        }

        expect(seen).toEqual([]);
    });

    test('yields the rows of a joined query', async (): Promise<void> => {
        const seen: unknown[] = [];

        for await (const row of users().crossJoin('users').lazy()) {
            seen.push(row);
        }

        expect(seen).toHaveLength(25);
    });
});


describe('Builder date parts', (): void => {
    test('constrains to a day, whatever time is stored', async (): Promise<void> => {
        expect((await names(users().whereDate('seen_at', '2026-02-01'))).sort()).toEqual(['Alice', 'Bob']);
    });

    test('accepts a date instance', async (): Promise<void> => {
        expect(await names(users().whereDate('seen_at', new Date('2026-03-15T12:00:00.000Z')))).toEqual(['Carol']);
    });

    test('constrains to a year', async (): Promise<void> => {
        expect(await users().whereYear('seen_at', 2026).count()).toEqual(3);
        expect(await users().whereYear('seen_at', 2025).count()).toEqual(1);
    });

    test('constrains to a month, numbered from one', async (): Promise<void> => {
        expect(await users().whereMonth('seen_at', 2).count()).toEqual(2);
        expect(await users().whereMonth('seen_at', 12).count()).toEqual(1);
    });

    test('constrains to a day of the month', async (): Promise<void> => {
        expect(await users().whereDay('seen_at', 15).count()).toEqual(1);
        expect(await users().whereDay('seen_at', 7).count()).toEqual(0);
    });

    test('matches nothing where the column holds no date', async (): Promise<void> => {
        expect(await users().whereYear('name', 2026).count()).toEqual(0);
    });

    test('matches nothing where the column is null', async (): Promise<void> => {
        expect(await names(users().whereYear('seen_at', 2026))).not.toContain('Dave');
    });
});


describe('Builder.sole', (): void => {
    test('returns the one matching record', async (): Promise<void> => {
        expect((await users().where('name', 'Alice').sole()).name).toEqual('Alice');
    });

    test('fails when nothing matches', async (): Promise<void> => {
        await expect(users().where('name', 'Nobody').sole()).rejects.toBeInstanceOf(RecordsNotFoundException);
    });

    test('fails when more than one matches', async (): Promise<void> => {
        await expect(users().where('role', 'member').sole()).rejects.toBeInstanceOf(MultipleRecordsFoundException);
    });

    test('names the table when more than one matches', async (): Promise<void> => {
        await expect(users().where('role', 'member').sole()).rejects.toThrow(
            new MultipleRecordsFoundException('users'),
        );
    });
});


describe('Builder.insertOrIgnore', (): void => {
    test('inserts the records the constraints allow', async (): Promise<void> => {
        const inserted: number = await users().insertOrIgnore([
            { name: 'Frank', email: 'frank@example.com', role: 'member' },
            { name: 'Clone', email: 'alice@example.com', role: 'member' },
        ]);

        expect(inserted).toEqual(1);
        expect(await users().where('name', 'Frank').count()).toEqual(1);
        expect(await users().where('name', 'Clone').count()).toEqual(0);
    });

    test('inserts a single record', async (): Promise<void> => {
        expect(await users().insertOrIgnore({ name: 'Grace', email: 'grace@example.com', role: 'member' })).toEqual(1);
    });

    test('ignores a record the unique index rejects', async (): Promise<void> => {
        expect(await users().insertOrIgnore({ name: 'Clone', email: 'alice@example.com', role: 'member' })).toEqual(0);
    });

    test('still reports a failure that is not a rejected constraint', async (): Promise<void> => {
        await expect(users().insertOrIgnore({ email: 'nameless@example.com', role: 'member' })).rejects.not.toBeInstanceOf(
            UniqueConstraintViolationException,
        );
    });
});

