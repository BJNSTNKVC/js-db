import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { MultipleRecordsFoundException, RecordsNotFoundException, SchemaException, UniqueConstraintViolationException } from '../../src/exceptions';
import { Executor } from '../../src/query/Executor';
import type { Builder } from '../../src/query/Builder';
import type { Paginated } from '../../src/query/types';
import type { MockInstance } from 'vitest';

interface User {
    id: number;
    name: string;
    email: string;
    role: string;
    seen_at: Date | null;
}

interface Moment {
    id: number;
    name: string;
    indexed: Date;
    plain: Date;
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

class CreateMomentsTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('moments', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.datetime('indexed').index();
            table.datetime('plain');
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
    connection = new Connection('app', { database: 'builder-extras', migrations: [CreateUsersTable] });

    await connection.migrate();
    await users().insert(seed);
});

afterEach((): void => {
    vi.restoreAllMocks();
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

    test.each([
        ['no order', (query: Builder<User>): Builder<User> => query],
        ['an order', (query: Builder<User>): Builder<User> => query.orderBy('name', 'desc')],
        ['the paging the query carried', (query: Builder<User>): Builder<User> => query.orderBy('name').offset(4).limit(1)],
    ])('counts every match with %s', async (_: string, shape: (query: Builder<User>) => Builder<User>): Promise<void> => {
        const page: Paginated<User> = await shape(users().where('role', 'member')).paginate(1, 2);

        expect(page.data).toHaveLength(2);
        expect(page.total).toEqual(3);
        expect(page.lastPage).toEqual(2);
    });

    test('counts every match in random order without shuffling it', async (): Promise<void> => {
        const random: MockInstance = vi.spyOn(Math, 'random').mockReturnValue(0);
        const page: Paginated<User> = await users().where('role', 'member').inRandomOrder().paginate(1, 2);

        expect(page.data.map((user: User): string => user.name)).toEqual(['Carol', 'Dave']);
        expect(page.total).toEqual(3);
        expect(random).toHaveBeenCalledTimes(2);
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

    test.each([-1, 0, 1.5, NaN])('reads a page of %s as the first', async (number: number): Promise<void> => {
        const page: Paginated<User> = await users().orderBy('name').paginate(number, 2);

        expect(page.data.map((user: User): string => user.name)).toEqual(['Alice', 'Bob']);
        expect(page.currentPage).toEqual(1);
    });

    test.each([0, -1, 1.5, NaN])('refuses a page size of %s', async (size: number): Promise<void> => {
        await expect(users().paginate(1, size)).rejects.toThrow(SchemaException);
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

    test.each([0, -1, 1.5, NaN])('refuses a size of %s', async (size: number): Promise<void> => {
        bound();

        await expect(users().orderBy('name').lazy(size).next()).rejects.toThrow(SchemaException);
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

describe('Builder.whereDate in the local timezone', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let days: Connection;

    /**
     * Begin a query against the moments table.
     */
    function moments(): Builder<Moment> {
        return days.table<Moment>('moments');
    }

    /**
     * Build a moment in the local timezone, keeping a year below 100 as given.
     */
    function local(year: number, month: number, day: number, hour: number = 12): Date {
        const date: Date = new Date(2000, 0, 1);

        date.setFullYear(year, month - 1, day);
        date.setHours(hour, 0, 0, 0);

        return date;
    }

    /**
     * Run the rest of the test in the given timezone, and store the named moments in both columns.
     */
    async function store(timezone: string, rows: Record<string, () => Date>): Promise<void> {
        vi.stubEnv('TZ', timezone);

        await moments().truncate();
        await moments().insert(Object.entries(rows).map(([name, at]: [string, () => Date]): Omit<Moment, 'id'> => ({ name, indexed: at(), plain: at() })));
    }

    /**
     * Get the names of the moments a query returns, sorted.
     */
    async function named(query: Builder<Moment>): Promise<string[]> {
        return (await query.get()).map((moment: Moment): string => moment.name).sort();
    }

    beforeAll(async (): Promise<void> => {
        days = new Connection('app', { database: 'builder-extras-days', migrations: [CreateMomentsTable] });

        await days.migrate();
    });

    afterEach((): void => {
        // Node keeps the last timezone it was given once TZ is deleted, so the starting one is
        // given back before the variable is removed.
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    const WEEK: Record<string, () => Date> = {
        sunday   : (): Date => local(2024, 1, 14),
        monday   : (): Date => local(2024, 1, 15),
        tuesday  : (): Date => local(2024, 1, 16),
        leap     : (): Date => local(2024, 2, 29),
        march    : (): Date => local(2024, 3, 1),
        antiquity: (): Date => local(50, 1, 15),
        modern   : (): Date => local(1950, 1, 15),
    };

    describe.each([
        ['America/New_York', 'indexed', 'index:moments_indexed_index'],
        ['America/New_York', 'plain', 'scan'],
        ['Asia/Tokyo', 'indexed', 'index:moments_indexed_index'],
        ['Asia/Tokyo', 'plain', 'scan'],
    ] as [string, 'indexed' | 'plain', string][])('in %s through the %s column', (timezone: string, column: 'indexed' | 'plain', plan: string): void => {
        test('selects the day a date string names', async (): Promise<void> => {
            await store(timezone, WEEK);

            expect(await moments().whereDate(column, '2024-01-15').explain()).toEqual(plan);
            expect(await named(moments().whereDate(column, '2024-01-15'))).toEqual(['monday']);
        });

        test('selects the same rows from a date string and the matching date', async (): Promise<void> => {
            await store(timezone, WEEK);

            expect(await named(moments().whereDate(column, '2024-01-15'))).toEqual(await named(moments().whereDate(column, local(2024, 1, 15, 18))));
            expect(await named(moments().whereDate(column, local(2024, 1, 15, 18)))).toEqual(['monday']);
        });

        test('selects nothing for a day the calendar does not have', async (): Promise<void> => {
            await store(timezone, WEEK);

            expect(await named(moments().whereDate(column, '2024-02-30'))).toEqual([]);
            expect(await named(moments().whereDate(column, '2024-13-01'))).toEqual([]);
        });

        test('reads a year below 100 as given', async (): Promise<void> => {
            await store(timezone, WEEK);

            expect(await named(moments().whereDate(column, '0050-01-15'))).toEqual(['antiquity']);
            expect(await named(moments().whereDate(column, local(50, 1, 15)))).toEqual(['antiquity']);
        });
    });

    test.each(['indexed', 'plain'] as const)('covers the whole of a day whose midnight is skipped, through the %s column', async (column: 'indexed' | 'plain'): Promise<void> => {
        await store('America/Santiago', {
            before: (): Date => new Date(new Date(2024, 8, 8).getTime() - 1),
            first : (): Date => new Date(2024, 8, 8),
            last  : (): Date => new Date(new Date(2024, 8, 9).getTime() - 1),
            after : (): Date => new Date(2024, 8, 9),
        });

        expect(new Date(2024, 8, 8).getHours()).toEqual(1);
        expect(await named(moments().whereDate(column, '2024-09-08'))).toEqual(['first', 'last']);
        expect(await named(moments().whereDate(column, new Date(2024, 8, 8, 12)))).toEqual(['first', 'last']);
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


describe('Builder.unless', (): void => {
    test('applies the callback when the value is falsy', async (): Promise<void> => {
        expect(await names(users().unless(false, (query: Builder<User>): void => {
            query.where('name', 'Alice');
        }))).toEqual(['Alice']);
    });

    test('skips the callback when the value is truthy', async (): Promise<void> => {
        // Counted rather than hardcoded, so the assertion does not depend on what other suites wrote.
        const every: number = await users().count();

        expect(await names(users().unless('yes', (query: Builder<User>): void => {
            query.where('name', 'Alice');
        }))).toHaveLength(every);
    });

    test('passes the value to the callback', async (): Promise<void> => {
        const seen: unknown[] = [];

        await users().unless(0, (_query: Builder<User>, value: unknown): void => {
            seen.push(value);
        }).get();

        expect(seen).toEqual([0]);
    });
});

