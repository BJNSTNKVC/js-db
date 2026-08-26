import { beforeAll, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
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

