import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { MultipleRecordsFoundException, RecordsNotFoundException, SchemaException, UniqueConstraintViolationException } from '../../src/exceptions';
import { Executor } from '../../src/query/Executor';
import type { Builder } from '../../src/query/Builder';
import type { DateOperator, Paginated } from '../../src/query/types';
import type { MockInstance } from 'vitest';

interface User {
    id: number;
    name: string;
    email: string;
    role: string;
    seen_at: Date | null;
}

interface Person {
    id: number;
    name: string;
}

interface Visit {
    id: number;
    name: string;
    person_id: number;
    at: Date | null;
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

class CreateVisitsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('people', (table: Blueprint): void => {
            table.id();
            table.string('name');
        });

        await Schema.create('visits', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('person_id');
            table.datetime('at').nullable().index();
        });
    }
}

interface Contact {
    id: number;
    name: string;
    email: string;
    role: string;
    seen_at: Date | null;
}

interface Mark {
    id: number;
    text: string;
}

class CreateContactsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('contacts', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('email');
            table.string('role');
            table.datetime('seen_at').nullable();
        });

        await Schema.create('marks', (table: Blueprint): void => {
            table.id();
            table.string('text');
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

describe('Builder date parts with an operator', (): void => {
    let parts: Connection;

    /**
     * Begin a query against the visits table.
     */
    function visits(): Builder<Visit> {
        return parts.table<Visit>('visits');
    }

    /**
     * Get the names of the visits a query returns, sorted.
     */
    async function visited(query: Builder<Visit>): Promise<string[]> {
        return (await query.get()).map((visit: Visit): string => visit.name).sort();
    }

    beforeAll(async (): Promise<void> => {
        parts = new Connection('app', { database: 'builder-extras-parts', migrations: [CreateVisitsTables], timezone: 'local' });

        await parts.migrate();
        await parts.table<Person>('people').insert([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }]);
        await visits().insert([
            { name: 'spring', person_id: 1, at: new Date(2024, 2, 10, 12) },
            { name: 'summer', person_id: 1, at: new Date(2024, 6, 7, 12) },
            { name: 'winter', person_id: 2, at: new Date(2023, 11, 31, 12) },
            { name: 'never', person_id: 2, at: null },
            { name: 'early', person_id: 3, at: new Date(2025, 0, 7, 12) },
        ]);
    });

    const COMPARISONS: [string, (query: Builder<Visit>) => Builder<Visit>, string[]][] = [
        ['whereYear(\'at\', \'=\', 2024)', (query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '=', 2024), ['spring', 'summer']],
        ['whereYear(\'at\', \'>\', 2023)', (query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '>', 2023), ['early', 'spring', 'summer']],
        ['whereYear(\'at\', \'<=\', 2023)', (query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '<=', 2023), ['winter']],
        ['whereYear(\'at\', \'!=\', 2024)', (query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '!=', 2024), ['early', 'winter']],
        ['whereMonth(\'at\', \'<\', 7)', (query: Builder<Visit>): Builder<Visit> => query.whereMonth('at', '<', 7), ['early', 'spring']],
        ['whereMonth(\'at\', \'>=\', 7)', (query: Builder<Visit>): Builder<Visit> => query.whereMonth('at', '>=', 7), ['summer', 'winter']],
        ['whereMonth(\'at\', \'<>\', 12)', (query: Builder<Visit>): Builder<Visit> => query.whereMonth('at', '<>', 12), ['early', 'spring', 'summer']],
        ['whereDay(\'at\', \'<=\', 7)', (query: Builder<Visit>): Builder<Visit> => query.whereDay('at', '<=', 7), ['early', 'summer']],
        ['whereDay(\'at\', \'>\', 10)', (query: Builder<Visit>): Builder<Visit> => query.whereDay('at', '>', 10), ['winter']],
        ['whereDay(\'at\', \'!=\', 7)', (query: Builder<Visit>): Builder<Visit> => query.whereDay('at', '!=', 7), ['spring', 'winter']],
    ];

    test.each(COMPARISONS)('%s compares the part with the operator', async (_: string, constrain: (query: Builder<Visit>) => Builder<Visit>, expected: string[]): Promise<void> => {
        expect(await visited(constrain(visits()))).toEqual(expected);
        expect(await constrain(visits()).count()).toEqual(expected.length);
    });

    test('reads a year, month or day written as a whole number in a string as that number', async (): Promise<void> => {
        expect(await visited(visits().whereYear('at', '2024'))).toEqual(await visited(visits().whereYear('at', 2024)));
        expect(await visited(visits().whereYear('at', '2024'))).toEqual(['spring', 'summer']);
        expect(await visited(visits().whereMonth('at', '07'))).toEqual(['summer']);
        expect(await visited(visits().whereDay('at', '0007'))).toEqual(['early', 'summer']);
        expect(await visited(visits().whereMonth('at', '<', '07'))).toEqual(['early', 'spring']);
        expect(await visited(visits().whereYear('at', '>=', '2024'))).toEqual(['early', 'spring', 'summer']);
    });

    describe.each(['whereYear', 'whereMonth', 'whereDay'] as const)('%s', (method: 'whereYear' | 'whereMonth' | 'whereDay'): void => {
        test.each(['', ' 2024', '2024.0', '-1', '1e3', 'twenty'])('refuses %j, which is not a whole number', (value: string): void => {
            expect((): Builder<Visit> => visits()[method]('at', value)).toThrow(SchemaException);
            expect((): Builder<Visit> => visits()[method]('at', '=', value)).toThrow(SchemaException);
        });

        test('refuses a value that looks like an operator when given alone', (): void => {
            expect((): Builder<Visit> => visits()[method]('at', '>=')).toThrow(SchemaException);
        });

        test('keeps the operator of a call whose value is undefined, matching nothing', async (): Promise<void> => {
            expect(await visited(visits()[method]('at', '>=', undefined as unknown as number))).toEqual([]);
        });
    });

    test('compares a fractional or negative number as given', async (): Promise<void> => {
        expect(await visited(visits().whereYear('at', 2024.5))).toEqual([]);
        expect(await visited(visits().whereYear('at', -1))).toEqual([]);
        expect(await visited(visits().whereYear('at', '<', 2024.5))).toEqual(['spring', 'summer', 'winter']);
        expect(await visited(visits().whereYear('at', '>', -1))).toEqual(['early', 'spring', 'summer', 'winter']);
    });

    describe.each(['whereDate', 'whereYear', 'whereMonth', 'whereDay'] as const)('%s', (method: 'whereDate' | 'whereYear' | 'whereMonth' | 'whereDay'): void => {
        test.each(['==', '===', '!==', 'like', 'not like', 'between'])('refuses the operator %s', (operator: string): void => {
            const value: string = method === 'whereDate' ? '2024-07-07' : '7';

            expect((): Builder<Visit> => visits()[method]('at', operator as DateOperator, value)).toThrow(SchemaException);
        });
    });

    test('leaves null and missing values out under != on every part, as whereDate does', async (): Promise<void> => {
        expect(await visited(visits().whereDate('at', '!=', '2024-07-07'))).toEqual(['early', 'spring', 'winter']);
        expect(await visited(visits().whereYear('at', '!=', 2024))).toEqual(['early', 'winter']);
        expect(await visited(visits().whereMonth('at', '!=', 7))).toEqual(['early', 'spring', 'winter']);
        expect(await visited(visits().whereDay('at', '!=', 7))).toEqual(['spring', 'winter']);

        expect(await visits().whereDate('nowhere', '!=', '2024-07-07').count()).toEqual(0);
        expect(await visits().whereYear('nowhere', '!=', 2024).count()).toEqual(0);
        expect(await visits().whereMonth('nowhere', '!=', 7).count()).toEqual(0);
        expect(await visits().whereDay('nowhere', '!=', 7).count()).toEqual(0);
    });

    test('reads a date given alone that looks like an operator as an unreadable date', async (): Promise<void> => {
        expect(await visited(visits().whereDate('at', '>='))).toEqual([]);
        expect(await visited(visits().whereDate('at', '>=', undefined as unknown as string))).toEqual([]);
    });

    test.each(['=', '!=', '<>', '<', '>', '<=', '>='] as DateOperator[])('matches nothing for a date it cannot read under %s, as without an operator', async (operator: DateOperator): Promise<void> => {
        expect(await visited(visits().whereDate('at', ''))).toEqual([]);
        expect(await visited(visits().whereDate('at', 'garbage'))).toEqual([]);
        expect(await visited(visits().whereDate('at', operator, ''))).toEqual([]);
        expect(await visited(visits().whereDate('at', operator, 'garbage'))).toEqual([]);
    });

    test('keeps the operator through cloning, nesting, whereNot and orWhere groups', async (): Promise<void> => {
        const later: Builder<Visit> = visits().whereYear('at', '>', 2023);

        expect(await visited(later.clone())).toEqual(['early', 'spring', 'summer']);
        expect(await visited(visits().where((query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '>', 2023)))).toEqual(['early', 'spring', 'summer']);
        expect(await visited(visits().whereNot((query: Builder<Visit>): Builder<Visit> => query.whereYear('at', '>', 2023)))).toEqual(['winter']);
        expect(await visited(visits().where('name', 'winter').orWhere((query: Builder<Visit>): Builder<Visit> => query.whereMonth('at', '<', 4)))).toEqual(['early', 'spring', 'winter']);
        expect(await visited(visits().whereNot((query: Builder<Visit>): Builder<Visit> => query.whereDate('at', '!=', '2024-07-07')))).toEqual(['summer']);
        expect(await visited(visits().where('name', 'never').orWhere((query: Builder<Visit>): Builder<Visit> => query.whereDate('at', '<', '2024-03-10')))).toEqual(['never', 'winter']);
    });

    test('keeps the operator on a joined query whose constraints are qualified', async (): Promise<void> => {
        const joined: () => Builder<Record<string, unknown>> = (): Builder<Record<string, unknown>> => visits().join('people', 'people.id', '=', 'visits.person_id');

        expect((await joined().whereYear('at', '>', 2023).pluck<string>('visits.name')).sort()).toEqual(['early', 'spring', 'summer']);
        expect((await joined().whereMonth('visits.at', '<', '07').pluck<string>('visits.name')).sort()).toEqual(['early', 'spring']);
        expect((await joined().whereDate('at', '!=', '2024-07-07').where('people.name', 'Alice').pluck<string>('visits.name')).sort()).toEqual(['spring']);
        expect(await joined().whereDay('at', '<=', 7).count()).toEqual(2);
    });
});


describe('Builder or forms and case-sensitive like', (): void => {
    let databases: number = 0;
    let marked: Connection;

    /**
     * Begin a query against the contacts of the marked database.
     */
    function contacts(): Builder<Contact> {
        return marked.table<Contact>('contacts');
    }

    /**
     * Begin a query against the marks of the marked database.
     */
    function marks(): Builder<Mark> {
        return marked.table<Mark>('marks');
    }

    /**
     * Get the names of the contacts a query returns, in key order.
     */
    async function called(query: Builder<Contact>): Promise<string[]> {
        return (await query.orderBy('id').get()).map((contact: Contact): string => contact.name);
    }

    /**
     * Get the texts of the marks a query returns, in key order.
     */
    async function texts(query: Builder<Mark>): Promise<string[]> {
        return (await query.orderBy('id').get()).map((mark: Mark): string => mark.text);
    }

    beforeEach(async (): Promise<void> => {
        marked = new Connection('app', { database: `builder-extras-or-${++databases}`, migrations: [CreateContactsTables] });

        await marked.migrate();

        await contacts().insert([
            { name: 'Alice', email: 'alice@example.com', role: 'admin', seen_at: new Date('2026-02-01T09:30:00.000Z') },
            { name: 'Bob', email: 'bob@example.com', role: 'member', seen_at: new Date('2026-02-01T18:45:00.000Z') },
            { name: 'Carol', email: 'carol@example.com', role: 'member', seen_at: new Date('2026-03-15T00:00:00.000Z') },
            { name: 'Dave', email: 'dave@example.com', role: 'member', seen_at: null },
            { name: 'Erin', email: 'erin@example.com', role: 'owner', seen_at: new Date('2025-12-25T00:00:00.000Z') },
            { name: 'Mixed', email: 'Mixed@X', role: 'guest', seen_at: null },
        ]);

        await marks().insert(['A*B', 'AxB', 'A?B', 'A[B]', 'AB', 'a*b', 'a?b', 'a[b]', 'A%B', 'a%b', 'A\\xB'].map((text: string): Omit<Mark, 'id'> => ({ text })));
    });

    afterEach((): void => {
        marked.disconnect();
    });

    const OR_FORMS: [string, (query: Builder<Contact>) => Builder<Contact>, string[]][] = [
        ['orWhereNot with a column', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Bob').orWhereNot('role', 'member'), ['Alice', 'Bob', 'Erin', 'Mixed']],
        ['orWhereNot with an operator', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Bob').orWhereNot('id', '>', 2), ['Alice', 'Bob']],
        ['orWhereNot with an object', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereNot({ role: 'member', name: 'Bob' }), ['Alice', 'Dave', 'Erin', 'Mixed']],
        ['orWhereNot with a closure', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Bob').orWhereNot((nested: Builder<Contact>): Builder<Contact> => nested.where('role', 'member').orWhere('role', 'guest')), ['Alice', 'Bob', 'Erin']],
        ['orWhereDate with =', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Erin').orWhereDate('seen_at', '2026-02-01'), ['Alice', 'Bob', 'Erin']],
        ['orWhereDate with !=', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereDate('seen_at', '!=', '2026-02-01'), ['Carol', 'Dave', 'Erin']],
        ['orWhereDate with <>', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereDate('seen_at', '<>', '2026-02-01'), ['Carol', 'Dave', 'Erin']],
        ['orWhereDate with <', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Mixed').orWhereDate('seen_at', '<', '2026-02-01'), ['Erin', 'Mixed']],
        ['orWhereTime with >', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereTime('seen_at', '>', '12:00:00'), ['Bob', 'Dave']],
        ['orWhereTime with a time alone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereTime('seen_at', '09:30:00'), ['Alice', 'Dave']],
        ['orWhereYear with a year alone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereYear('seen_at', 2025), ['Dave', 'Erin']],
        ['orWhereYear with >=', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereYear('seen_at', '>=', 2026), ['Alice', 'Bob', 'Carol', 'Dave']],
        ['orWhereMonth with a month alone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereMonth('seen_at', 3), ['Carol', 'Dave']],
        ['orWhereMonth with <', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereMonth('seen_at', '<', 3), ['Alice', 'Bob', 'Dave']],
        ['orWhereDay with a day alone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereDay('seen_at', 25), ['Dave', 'Erin']],
        ['orWhereDay with >', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereDay('seen_at', '>', 1), ['Carol', 'Dave', 'Erin']],
        ['orWhereAny with an operator', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereAny(['name', 'role'], 'like', '%o%'), ['Bob', 'Carol', 'Dave', 'Erin']],
        ['orWhereAny with a value alone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Dave').orWhereAny(['name', 'role'], 'admin'), ['Alice', 'Dave']],
        ['orWhereAll', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Alice').orWhereAll(['name', 'role'], 'like', '%e%'), ['Alice', 'Dave', 'Erin', 'Mixed']],
        ['orWhereNone', (query: Builder<Contact>): Builder<Contact> => query.where('name', 'Bob').orWhereNone(['name', 'role'], 'like', '%o%'), ['Alice', 'Bob', 'Dave', 'Mixed']],
    ];

    test.each(OR_FORMS)('%s after a where returns the rows of either', async (_: string, constrain: (query: Builder<Contact>) => Builder<Contact>, expected: string[]): Promise<void> => {
        expect(await called(constrain(contacts()))).toEqual(expected);
        expect(await constrain(contacts()).count()).toEqual(expected.length);
    });

    test('whereLike without the flag still ignores case', async (): Promise<void> => {
        expect(await called(contacts().whereLike('email', 'mixed%'))).toEqual(['Mixed']);
        expect(await texts(marks().whereLike('text', 'a*b'))).toEqual(['A*B', 'a*b']);
    });

    test('whereLike with the flag matches the letters exactly', async (): Promise<void> => {
        expect(await called(contacts().whereLike('email', 'mixed%', true))).toEqual([]);
        expect(await called(contacts().whereLike('email', 'Mixed%', true))).toEqual(['Mixed']);
        expect(await called(contacts().whereLike('email', 'Mixe_@%', true))).toEqual(['Mixed']);
        expect(await texts(marks().whereLike('text', 'a%', true))).toEqual(['a*b', 'a?b', 'a[b]', 'a%b']);
        expect(await texts(marks().whereLike('text', 'A_B', true))).toEqual(['A*B', 'AxB', 'A?B', 'A%B']);
    });

    test('whereNotLike with the flag returns the rest', async (): Promise<void> => {
        expect(await called(contacts().whereNotLike('email', 'Mixed%', true))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
        expect(await called(contacts().whereNotLike('email', 'mixed%', true))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Mixed']);
        expect(await texts(marks().whereNotLike('text', 'A*B', true))).toEqual(['AxB', 'A?B', 'A[B]', 'AB', 'a*b', 'a?b', 'a[b]', 'A%B', 'a%b', 'A\\xB']);
    });

    test('orWhereLike with the flag after a where returns the rows of either', async (): Promise<void> => {
        expect(await called(contacts().where('name', 'Alice').orWhereLike('email', 'Mixed%', true))).toEqual(['Alice', 'Mixed']);
        expect(await called(contacts().where('name', 'Alice').orWhereLike('email', 'mixed%', true))).toEqual(['Alice']);
    });

    test('orWhereNotLike with the flag after a where returns the rows of either', async (): Promise<void> => {
        expect(await called(contacts().where('name', 'Alice').orWhereNotLike('email', '%@example.com', true))).toEqual(['Alice', 'Mixed']);
        expect(await called(contacts().where('name', 'Alice').orWhereNotLike('email', '%@EXAMPLE.COM', true))).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Mixed']);
    });

    test.each([
        ['A*B', ['A*B']],
        ['A?B', ['A?B']],
        ['A[B]', ['A[B]']],
        ['A[%', ['A[B]']],
        ['A\\%B', ['A%B']],
    ])('a case-sensitive %s matches only the literal characters', async (pattern: string, expected: string[]): Promise<void> => {
        expect(await texts(marks().whereLike('text', pattern, true))).toEqual(expected);
    });

    test('a case-sensitive like is checked on every record rather than through an index', async (): Promise<void> => {
        expect(await users().whereLike('email', 'alice%', true).explain()).toEqual('scan');
        expect(await users().whereLike('email', 'alice%', true).where('email', 'alice@example.com').explain()).toEqual('index:users_email_unique');
        expect(await names(users().whereLike('email', 'alice%', true))).toEqual(['Alice']);
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
