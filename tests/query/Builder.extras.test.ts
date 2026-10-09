import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { MultipleRecordsFoundException, RecordsNotFoundException, SchemaException, UniqueConstraintViolationException } from '../../src/exceptions';
import { Executor } from '../../src/query/Executor';
import { DB } from '../../src/main';
import { Dispatcher } from '../../src/events/Dispatcher';
import type { Builder } from '../../src/query/Builder';
import type { QueryExecuted } from '../../src/events';
import type { DateOperator, Paginated } from '../../src/query/types';
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

        await Schema.create('days', (table: Blueprint): void => {
            table.date('day').primary();
            table.string('name');
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

describe('Builder.whereDate in the connection\'s timezone', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const connections: Map<string, Connection> = new Map<string, Connection>();

    const PROCESSES: string[] = ['America/New_York', 'Asia/Tokyo', 'America/Santiago'];

    /**
     * Begin a query against the moments table on the connection set to the given timezone.
     */
    function moments(timezone: string = 'local'): Builder<Moment> {
        return (connections.get(timezone) as Connection).table<Moment>('moments');
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
     * Run the rest of the test with the process in the given timezone, and store the named moments in both columns through the connection set to another.
     */
    async function store(process: string, rows: Record<string, () => Date>, timezone: string = 'local'): Promise<void> {
        vi.stubEnv('TZ', process);

        await moments(timezone).truncate();
        await moments(timezone).insert(Object.entries(rows).map(([name, at]: [string, () => Date]): Omit<Moment, 'id'> => ({ name, indexed: at(), plain: at() })));
    }

    /**
     * Get the names of the moments a query returns, sorted.
     */
    async function named(query: Builder<Moment>): Promise<string[]> {
        return (await query.get()).map((moment: Moment): string => moment.name).sort();
    }

    beforeAll(async (): Promise<void> => {
        for (const timezone of ['local', 'UTC', 'America/New_York', 'America/Santiago']) {
            const connection: Connection = new Connection('app', { database: `builder-extras-days-${timezone.replace('/', '-')}`, migrations: [CreateMomentsTable], timezone });

            await connection.migrate();

            connections.set(timezone, connection);
        }
    });

    afterEach((): void => {
        // Node keeps the last timezone it was given once TZ is deleted, so the starting one is
        // given back before the variable is removed.
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    const SPANS: [DateOperator, string[]][] = [
        ['=', ['first', 'last', 'noon']],
        ['>', ['after']],
        ['>=', ['after', 'first', 'last', 'noon']],
        ['<', ['before']],
        ['<=', ['before', 'first', 'last', 'noon']],
        ['!=', ['after', 'before']],
        ['<>', ['after', 'before']],
    ];

    /**
     * Collect the plans the queries a callback runs report.
     */
    async function plans(run: () => Promise<unknown>): Promise<string[]> {
        const seen: string[] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        try {
            await run();
        } finally {
            Dispatcher.forget('db:query', listener);
        }

        return seen;
    }

    describe('on a local connection', (): void => {
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

        const EDGES: Record<string, () => Date> = {
            before: (): Date => new Date(new Date(2024, 8, 8).getTime() - 1),
            first : (): Date => new Date(2024, 8, 8),
            noon  : (): Date => new Date(2024, 8, 8, 12),
            last  : (): Date => new Date(new Date(2024, 8, 9).getTime() - 1),
            after : (): Date => new Date(2024, 8, 9),
        };

        describe.each([
            ['America/New_York', 'indexed'],
            ['America/New_York', 'plain'],
            ['Asia/Tokyo', 'indexed'],
            ['Asia/Tokyo', 'plain'],
            ['America/Santiago', 'indexed'],
            ['America/Santiago', 'plain'],
        ] as [string, 'indexed' | 'plain'][])('with an operator in %s through the %s column', (timezone: string, column: 'indexed' | 'plain'): void => {
            test.each(SPANS)('%s selects the moments on its side of the local day', async (operator: DateOperator, expected: string[]): Promise<void> => {
                await store(timezone, EDGES);

                expect(await named(moments().whereDate(column, operator, '2024-09-08'))).toEqual(expected);
                expect(await named(moments().whereDate(column, operator, new Date(2024, 8, 8, 18)))).toEqual(expected);
            });
        });

        test.each(SPANS)('%s plans through the index unless it excludes the day', async (operator: DateOperator): Promise<void> => {
            await store('America/New_York', EDGES);

            const plan: string = operator === '!=' || operator === '<>' ? 'scan' : 'index:moments_indexed_index';

            expect(await moments().whereDate('indexed', operator, '2024-09-08').explain()).toEqual(plan);
            expect(await plans((): Promise<Moment[]> => moments().whereDate('indexed', operator, '2024-09-08').get())).toEqual([plan]);
            expect(await moments().whereDate('plain', operator, '2024-09-08').explain()).toEqual('scan');
        });

        test.each(['!=', '<>'] as DateOperator[])('%s leaves another constraint free to drive the query', async (operator: DateOperator): Promise<void> => {
            await store('America/New_York', EDGES);

            const id: number = (await moments().where('name', 'after').first() as Moment).id;

            expect(await moments().whereDate('indexed', operator, '2024-09-08').where('id', id).explain()).toEqual('key');
            expect(await named(moments().whereDate('indexed', operator, '2024-09-08').where('id', id))).toEqual(['after']);
            expect(await moments().whereDate('indexed', operator, '2024-09-08').where('indexed', '>', new Date(2024, 8, 8, 18)).explain()).toEqual('index:moments_indexed_index');
            expect(await named(moments().whereDate('indexed', operator, '2024-09-08').where('indexed', '>', new Date(2024, 8, 8, 18)))).toEqual(['after']);
        });

        describe('beside a date-only string stored before 7.0.0', (): void => {
            const STORED: Record<string, () => Date> = {
                before: (): Date => new Date('2024-01-15T00:00:00.000Z'),
                since : (): Date => '2024-01-15' as unknown as Date,
                next  : (): Date => '2024-01-16' as unknown as Date,
            };

            describe.each([
                ['America/New_York', 'indexed', false],
                ['America/New_York', 'plain', false],
                ['Asia/Tokyo', 'indexed', true],
                ['Asia/Tokyo', 'plain', true],
                ['America/Santiago', 'indexed', false],
                ['America/Santiago', 'plain', false],
            ] as [string, 'indexed' | 'plain', boolean][])('in %s through the %s column', (timezone: string, column: 'indexed' | 'plain', east: boolean): void => {
                test('matches only the row written since by the same string under where, whereIn and whereBetween', async (): Promise<void> => {
                    await store(timezone, STORED);

                    expect(await named(moments().where(column, '2024-01-15'))).toEqual(['since']);
                    expect(await named(moments().whereIn(column, ['2024-01-15']))).toEqual(['since']);
                    expect(await named(moments().whereBetween(column, ['2024-01-15', '2024-01-15']))).toEqual(['since']);
                    expect(await named(moments().whereBetween(column, ['2024-01-15', '2024-01-16']))).toEqual(east ? ['before', 'next', 'since'] : ['next', 'since']);
                });

                test('reads the row stored before as the day before west of UTC', async (): Promise<void> => {
                    await store(timezone, STORED);

                    const before: Moment = await moments().where('name', 'before').firstOrFail();

                    expect(before[column].getDate()).toEqual(east ? 15 : 14);
                    expect(await named(moments().whereDate(column, '2024-01-15'))).toEqual(east ? ['before', 'since'] : ['since']);
                    expect(await named(moments().whereDay(column, 15))).toEqual(east ? ['before', 'since'] : ['since']);
                });
            });
        });
    });

    describe.each([
        ['UTC', {
            before: '2024-01-14T23:59:59.999Z',
            first : '2024-01-15T00:00:00.000Z',
            noon  : '2024-01-15T12:00:00.000Z',
            last  : '2024-01-15T23:59:59.999Z',
            after : '2024-01-16T00:00:00.000Z',
        }, '2024-01-15', '2024-01-15T18:00:00.000Z'],
        ['America/New_York', {
            before: '2024-01-15T04:59:59.999Z',
            first : '2024-01-15T05:00:00.000Z',
            noon  : '2024-01-15T17:00:00.000Z',
            last  : '2024-01-16T04:59:59.999Z',
            after : '2024-01-16T05:00:00.000Z',
        }, '2024-01-15', '2024-01-15T23:00:00.000Z'],
        ['America/Santiago', {
            before: '2024-09-08T03:59:59.999Z',
            first : '2024-09-08T04:00:00.000Z',
            noon  : '2024-09-08T15:00:00.000Z',
            last  : '2024-09-09T02:59:59.999Z',
            after : '2024-09-09T03:00:00.000Z',
        }, '2024-09-08', '2024-09-08T21:00:00.000Z'],
    ] as [string, Record<string, string>, string, string][])('on a connection set to %s', (timezone: string, instants: Record<string, string>, day: string, evening: string): void => {
        const ROWS: Record<string, () => Date> = Object.fromEntries(Object.entries(instants).map(([name, at]: [string, string]): [string, () => Date] => [name, (): Date => new Date(at)]));

        describe.each(PROCESSES.flatMap((process: string): [string, 'indexed' | 'plain'][] => [[process, 'indexed'], [process, 'plain']]))('with the process in %s through the %s column', (process: string, column: 'indexed' | 'plain'): void => {
            test.each(SPANS)('%s selects the moments on its side of the day in that timezone', async (operator: DateOperator, expected: string[]): Promise<void> => {
                await store(process, ROWS, timezone);

                expect(await named(moments(timezone).whereDate(column, operator, day))).toEqual(expected);
                expect(await named(moments(timezone).whereDate(column, operator, new Date(evening)))).toEqual(expected);
            });

            test('reads the day of the month in that timezone', async (): Promise<void> => {
                await store(process, ROWS, timezone);

                expect(await named(moments(timezone).whereDay(column, Number(day.slice(8))))).toEqual(['first', 'last', 'noon']);
            });
        });

        test('plans through the index', async (): Promise<void> => {
            await store('Asia/Tokyo', ROWS, timezone);

            expect(await moments(timezone).whereDate('indexed', day).explain()).toEqual('index:moments_indexed_index');
        });
    });

    describe.each(PROCESSES)('across the autumn change in Santiago with the process in %s', (process: string): void => {
        const AUTUMN: Record<string, () => Date> = {
            before: (): Date => new Date('2024-04-06T02:59:59.999Z'),
            first : (): Date => new Date('2024-04-06T03:00:00.000Z'),
            early : (): Date => new Date('2024-04-07T02:30:00.000Z'),
            late  : (): Date => new Date('2024-04-07T03:30:00.000Z'),
            last  : (): Date => new Date('2024-04-07T03:59:59.999Z'),
            after : (): Date => new Date('2024-04-07T04:00:00.000Z'),
        };

        test.each(['indexed', 'plain'] as const)('covers the day of 25 hours, and both moments of the repeated hour, through the %s column', async (column: 'indexed' | 'plain'): Promise<void> => {
            await store(process, AUTUMN, 'America/Santiago');

            expect(await named(moments('America/Santiago').whereDate(column, '2024-04-06'))).toEqual(['early', 'first', 'last', 'late']);
            expect(await named(moments('America/Santiago').whereDay(column, 6))).toEqual(['early', 'first', 'last', 'late']);
            expect(await named(moments('America/Santiago').whereTime(column, '23:30'))).toEqual(['early', 'late']);
        });
    });

    describe('on a datetime holding 21:00 on 14 January in New York', (): void => {
        const EVENING: Record<string, () => Date> = {
            evening: (): Date => new Date('2024-01-15T02:00:00.000Z'),
        };

        describe.each([
            ['America/New_York', 'local', '2024-01-14', 14, '21:00'],
            ['Asia/Tokyo', 'local', '2024-01-15', 15, '11:00'],
            ['America/Santiago', 'local', '2024-01-14', 14, '23:00'],
            ['America/New_York', 'UTC', '2024-01-15', 15, '02:00'],
            ['Asia/Tokyo', 'UTC', '2024-01-15', 15, '02:00'],
            ['America/Santiago', 'UTC', '2024-01-15', 15, '02:00'],
            ['America/New_York', 'America/New_York', '2024-01-14', 14, '21:00'],
            ['Asia/Tokyo', 'America/New_York', '2024-01-14', 14, '21:00'],
            ['America/Santiago', 'America/New_York', '2024-01-14', 14, '21:00'],
        ] as [string, string, string, number, string][])('with the process in %s on a connection set to %s', (process: string, timezone: string, day: string, date: number, time: string): void => {
            test.each(['indexed', 'plain'] as const)('reads it as %s, through the %s column', async (column: 'indexed' | 'plain'): Promise<void> => {
                await store(process, EVENING, timezone);

                expect(await named(moments(timezone).whereDate(column, day))).toEqual(['evening']);
                expect(await named(moments(timezone).whereDay(column, date))).toEqual(['evening']);
                expect(await named(moments(timezone).whereTime(column, time))).toEqual(['evening']);
                expect(await named(moments(timezone).whereDate(column, '!=', day))).toEqual([]);
            });
        });
    });

    describe('beside dates stored before 7.0.0 and by 7.0.0', (): void => {
        const GENERATIONS: Record<string, () => Date> = {
            before: (): Date => new Date('2024-01-15T00:00:00.000Z'),
            seven : (): Date => new Date(2024, 0, 15),
            since : (): Date => '2024-01-15' as unknown as Date,
        };

        describe.each([
            ['local', 'America/New_York', ['seven', 'since'], ['seven', 'since']],
            ['local', 'Asia/Tokyo', ['before', 'seven', 'since'], ['seven', 'since']],
            ['local', 'America/Santiago', ['seven', 'since'], ['seven', 'since']],
            ['UTC', 'America/New_York', ['before', 'seven', 'since'], ['before', 'since']],
            ['UTC', 'Asia/Tokyo', ['before', 'since'], ['before', 'since']],
            ['UTC', 'America/Santiago', ['before', 'seven', 'since'], ['before', 'since']],
            ['America/New_York', 'America/New_York', ['seven', 'since'], ['seven', 'since']],
            ['America/New_York', 'Asia/Tokyo', ['since'], ['since']],
            ['America/New_York', 'America/Santiago', ['since'], ['since']],
        ] as [string, string, string[], string[]][])('on a connection set to %s with the process in %s', (timezone: string, process: string, day: string[], equal: string[]): void => {
            test.each(['indexed', 'plain'] as const)('answers whereDate, whereDay and where on the string through the %s column', async (column: 'indexed' | 'plain'): Promise<void> => {
                await store(process, GENERATIONS, timezone);

                expect(await named(moments(timezone).whereDate(column, '2024-01-15'))).toEqual(day);
                expect(await named(moments(timezone).whereDay(column, 15))).toEqual(day);
                expect(await named(moments(timezone).where(column, '2024-01-15'))).toEqual(equal);
            });
        });
    });

    describe('given a date only in the forms a write accepts', (): void => {
        const WEEK: Record<string, () => Date> = {
            monday : (): Date => '2024-01-15' as unknown as Date,
            tuesday: (): Date => '2024-01-16' as unknown as Date,
        };

        const REFUSED: string[] = [
            'Jan 15 2024',
            '2024/01/15',
            ' 2024-01-15 ',
            '2024-01-15t00:00:00z',
            '2024-01-15T00:00:00+0000',
            'Mon, 15 Jan 2024 00:00:00 GMT',
            '2024-02-30',
        ];

        const ACCEPTED: string[] = [
            '2024-01-15',
            '2024-01-15T10:30',
            '2024-01-15 10:30',
            '2024-01-15T10:30:15',
            '2024-01-15 10:30:15.5',
            '2024-01-15T10:30:15.123456',
            '2024-01-15T10:30:15Z',
            '2024-01-15 10:30:15.250Z',
            '2024-01-15T10:30:15+02:00',
            '2024-01-15T10:30-05:00',
            '0050-01-15',
        ];

        /**
         * Begin a query against the days table, keyed by a date, on the connection set to the given timezone.
         */
        function days(timezone: string): Builder<{ day: Date; name: string }> {
            return (connections.get(timezone) as Connection).table<{ day: Date; name: string }>('days');
        }

        /**
         * Begin a query joining each moment to the day of the same name, on the connection set to the given timezone.
         */
        function joined(timezone: string): Builder<Record<string, unknown>> {
            return (connections.get(timezone) as Connection).table('moments').join('days', 'days.name', '=', 'moments.name');
        }

        /**
         * Write records to the moments table past the package, as an old row holds them.
         */
        async function planted(timezone: string, records: Record<string, unknown>[]): Promise<void> {
            const database: IDBDatabase = await (connections.get(timezone) as Connection).open();
            const transaction: IDBTransaction = database.transaction('moments', 'readwrite');

            for (const record of records) {
                transaction.objectStore('moments').add(record);
            }

            await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
                transaction.oncomplete = (): void => resolve();
                transaction.onerror = (): void => reject(transaction.error);
            });
        }

        describe.each([
            ['UTC', 'UTC', 'indexed'],
            ['UTC', 'UTC', 'plain'],
            ['America/New_York', 'UTC', 'indexed'],
            ['America/New_York', 'UTC', 'plain'],
            ['UTC', 'local', 'indexed'],
            ['UTC', 'local', 'plain'],
            ['America/New_York', 'local', 'indexed'],
            ['America/New_York', 'local', 'plain'],
        ] as [string, string, 'indexed' | 'plain'][])('with the process in %s on a connection set to %s through the %s column', (process: string, timezone: string, column: 'indexed' | 'plain'): void => {
            test.each(REFUSED)('matches nothing for %o under where, whereIn, whereBetween and whereDate', async (value: string): Promise<void> => {
                await store(process, WEEK, timezone);

                expect(await named(moments(timezone).where(column, value))).toEqual([]);
                expect(await named(moments(timezone).where(column, '>=', value))).toEqual([]);
                expect(await named(moments(timezone).whereIn(column, [value]))).toEqual([]);
                expect(await named(moments(timezone).whereBetween(column, [value, '2024-01-16']))).toEqual([]);
                expect(await named(moments(timezone).whereDate(column, value))).toEqual([]);
                expect(await named(moments(timezone).whereDate(column, '<=', value))).toEqual([]);
            });

            test.each(REFUSED)('refuses %o in a write, as since 5.0.0', async (value: string): Promise<void> => {
                await store(process, WEEK, timezone);

                await expect(moments(timezone).insert({ name: 'written', indexed: value as unknown as Date, plain: value as unknown as Date })).rejects.toThrow(TypeError);
            });

            test.each(ACCEPTED)('finds the row a write of %o stored, by the same string', async (value: string): Promise<void> => {
                await store(process, { tuesday: WEEK['tuesday'] as () => Date, written: (): Date => value as unknown as Date }, timezone);

                expect(await named(moments(timezone).where(column, value))).toEqual(['written']);
                expect(await named(moments(timezone).whereIn(column, [value]))).toEqual(['written']);
                expect(await named(moments(timezone).whereBetween(column, [value, value]))).toEqual(['written']);
                expect(await named(moments(timezone).whereDate(column, value))).toContain('written');
            });

            test('reads a number as a timestamp and a date as it is, matching nothing for an invalid date', async (): Promise<void> => {
                await store(process, WEEK, timezone);

                const monday: Date = await moments(timezone).where('name', 'monday').value(column) as Date;

                expect(await named(moments(timezone).where(column, monday.getTime()))).toEqual(['monday']);
                expect(await named(moments(timezone).where(column, new Date(monday.getTime())))).toEqual(['monday']);
                expect(await named(moments(timezone).where(column, new Date(NaN)))).toEqual([]);
                expect(await named(moments(timezone).whereDate(column, new Date(NaN)))).toEqual([]);
            });

            test('reads a string an old row holds only in the forms a write accepts', async (): Promise<void> => {
                await store(process, {}, timezone);
                await planted(timezone, [
                    { id: 1, name: 'iso', indexed: '2024-01-15', plain: '2024-01-15' },
                    ...REFUSED.map((value: string, index: number): Record<string, unknown> => ({ id: index + 2, name: value, indexed: value, plain: value })),
                ]);

                expect(await named(moments(timezone).whereYear(column, 2024))).toEqual(['iso']);
                expect(await named(moments(timezone).whereMonth(column, 1))).toEqual(['iso']);
                expect(await named(moments(timezone).whereDay(column, 15))).toEqual(['iso']);
                expect(await named(moments(timezone).whereTime(column, '00:00'))).toEqual(['iso']);
            });

            test('finds by a date key and joins on a date column only in the forms a write accepts', async (): Promise<void> => {
                await store(process, WEEK, timezone);
                await days(timezone).truncate();
                await days(timezone).insert({ day: '2024-01-15' as unknown as Date, name: 'monday' });

                expect(await days(timezone).find('2024-01-15')).toMatchObject({ name: 'monday' });
                expect(await joined(timezone).where(`moments.${column}`, '2024-01-15').pluck('moments.name')).toEqual(['monday']);
                expect(await joined(timezone).where('days.day', '2024-01-15').pluck('moments.name')).toEqual(['monday']);

                for (const value of REFUSED) {
                    expect(await days(timezone).find(value)).toBeNull();
                    await expect(days(timezone).findOrFail(value)).rejects.toThrow(RecordsNotFoundException);
                    expect(await joined(timezone).where(`moments.${column}`, value).pluck('moments.name')).toEqual([]);
                    expect(await joined(timezone).where('days.day', value).pluck('moments.name')).toEqual([]);
                }
            });
        });
    });
});

describe('Rewriting dates stored before 7.0.0 as local days on a local connection', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let sequence: number = 0;

    /**
     * Determine whether a value is a date at exactly midnight UTC, as a date-only string was stored before 7.0.0.
     */
    function utcMidnight(value: unknown): value is Date {
        return value instanceof Date && value.getTime() % 86_400_000 === 0;
    }

    /**
     * Get the first moment of the local calendar day a UTC midnight names.
     */
    function localDay(held: Date): Date {
        const day: Date = new Date(2000, 0, 1);

        day.setFullYear(held.getUTCFullYear(), held.getUTCMonth(), held.getUTCDate());
        day.setHours(0, 0, 0, 0);

        return day;
    }

    class CreateBirthdaysTable extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await Schema.create('birthdays', (table: Blueprint): void => {
                table.id();
                table.string('name');
                table.date('born').nullable().index();
            });
        }
    }

    class StoreBirthdaysAsLocalDays extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            const held: unknown[] = await DB.table('birthdays').pluck('born');
            const stale: Map<number, Date> = new Map(held.filter(utcMidnight).map((date: Date): [number, Date] => [date.getTime(), date]));

            for (const date of stale.values()) {
                await DB.table('birthdays').where('born', date).update({ born: localDay(date) });
            }
        }
    }

    class StoreBirthdaysAsLocalDaysAgain extends StoreBirthdaysAsLocalDays {}

    /**
     * Get each birthday's name with the local day and hour it holds.
     */
    async function held(): Promise<[string, number[] | null][]> {
        return (await DB.table<{ name: string; born: Date | null }>('birthdays').orderBy('id').get()).map(({ name, born }: { name: string; born: Date | null }): [string, number[] | null] => [
            name,
            born === null ? null : [born.getFullYear(), born.getMonth() + 1, born.getDate(), born.getHours()],
        ]);
    }

    afterEach((): void => {
        DB.purge('app');
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    test.each(['America/New_York', 'Asia/Tokyo', 'America/Santiago'])('moves each UTC midnight to the local day it names in %s, once however often it runs', async (timezone: string): Promise<void> => {
        vi.stubEnv('TZ', timezone);

        const database: string = `builder-extras-rewritten-${++sequence}`;

        DB.configure({ default: 'app', connections: { app: { database, migrations: [CreateBirthdaysTable], timezone: 'local' } } });

        await DB.table('birthdays').insert([
            { name: 'before', born: new Date('2024-01-15T00:00:00.000Z') },
            { name: 'twin', born: new Date('2024-01-15T00:00:00.000Z') },
            { name: 'skipped', born: new Date('2024-09-08T00:00:00.000Z') },
            { name: 'antiquity', born: new Date('0050-01-15T00:00:00.000Z') },
            { name: 'since', born: '2024-03-01' },
            { name: 'noon', born: new Date(2024, 0, 15, 12) },
            { name: 'unknown', born: null },
        ]);

        DB.configure({ default: 'app', connections: { app: { database, migrations: [CreateBirthdaysTable, StoreBirthdaysAsLocalDays, StoreBirthdaysAsLocalDaysAgain], timezone: 'local' } } });

        expect(await DB.migrate('app')).toEqual(['store_birthdays_as_local_days', 'store_birthdays_as_local_days_again']);
        expect(await held()).toEqual([
            ['before', [2024, 1, 15, 0]],
            ['twin', [2024, 1, 15, 0]],
            ['skipped', [2024, 9, 8, timezone === 'America/Santiago' ? 1 : 0]],
            ['antiquity', [50, 1, 15, 0]],
            ['since', [2024, 3, 1, 0]],
            ['noon', [2024, 1, 15, 12]],
            ['unknown', null],
        ]);
        expect((await DB.table('birthdays').where('born', '2024-01-15').pluck('name')).sort()).toEqual(['before', 'twin']);
        expect((await DB.table('birthdays').whereDate('born', '2024-01-15').pluck('name')).sort()).toEqual(['before', 'noon', 'twin']);
    }, 2000);
});

describe('Moving dates written by 7.0.0 to UTC days', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let sequence: number = 0;

    /**
     * Determine whether a value is a date at the first moment of its local calendar day, as 7.0.0 stored a date-only string.
     */
    function localMidnight(value: unknown): value is Date {
        if (!(value instanceof Date)) {
            return false;
        }

        const day: Date = new Date(2000, 0, 1);

        day.setFullYear(value.getFullYear(), value.getMonth(), value.getDate());
        day.setHours(0, 0, 0, 0);

        return day.getTime() === value.getTime();
    }

    /**
     * Get midnight UTC of the local calendar day a date falls on.
     */
    function utcDay(held: Date): Date {
        const day: Date = new Date(0);

        day.setUTCFullYear(held.getFullYear(), held.getMonth(), held.getDate());

        return day;
    }

    class CreateBirthdaysTable extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await Schema.create('birthdays', (table: Blueprint): void => {
                table.id();
                table.string('name');
                table.date('born').nullable().index();
            });
        }
    }

    class StoreBirthdaysAsUtcDays extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            const held: unknown[] = await DB.table('birthdays').pluck('born');
            const stale: Map<number, Date> = new Map(held.filter(localMidnight).map((date: Date): [number, Date] => [date.getTime(), date]));

            for (const date of stale.values()) {
                await DB.table('birthdays').where('born', date).update({ born: utcDay(date) });
            }
        }
    }

    class StoreBirthdaysAsUtcDaysAgain extends StoreBirthdaysAsUtcDays {}

    /**
     * Get each birthday's name with the moment it holds.
     */
    async function held(): Promise<[string, string | null][]> {
        return (await DB.table<{ name: string; born: Date | null }>('birthdays').orderBy('id').get()).map(({ name, born }: { name: string; born: Date | null }): [string, string | null] => [
            name,
            born === null ? null : born.toISOString(),
        ]);
    }

    afterEach((): void => {
        DB.purge('app');
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    test.each(['America/New_York', 'Asia/Tokyo', 'America/Santiago'])('moves each local midnight to midnight UTC of that day in %s, once however often it runs', async (timezone: string): Promise<void> => {
        vi.stubEnv('TZ', timezone);

        const database: string = `builder-extras-upgraded-${++sequence}`;
        const noon: Date = new Date(2024, 0, 15, 12);

        DB.configure({ default: 'app', connections: { app: { database, migrations: [CreateBirthdaysTable], timezone: 'local' } } });

        await DB.table('birthdays').insert([
            { name: 'seven', born: '2024-01-15' },
            { name: 'twin', born: '2024-01-15' },
            { name: 'skipped', born: '2024-09-08' },
            { name: 'antiquity', born: '0050-01-15' },
            { name: 'before', born: new Date('2024-01-15T00:00:00.000Z') },
            { name: 'noon', born: noon },
            { name: 'unknown', born: null },
        ]);

        DB.configure({ default: 'app', connections: { app: { database, migrations: [CreateBirthdaysTable, StoreBirthdaysAsUtcDays, StoreBirthdaysAsUtcDaysAgain] } } });

        expect(await DB.migrate('app')).toEqual(['store_birthdays_as_utc_days', 'store_birthdays_as_utc_days_again']);
        expect(await held()).toEqual([
            ['seven', '2024-01-15T00:00:00.000Z'],
            ['twin', '2024-01-15T00:00:00.000Z'],
            ['skipped', '2024-09-08T00:00:00.000Z'],
            ['antiquity', '0050-01-15T00:00:00.000Z'],
            ['before', '2024-01-15T00:00:00.000Z'],
            ['noon', noon.toISOString()],
            ['unknown', null],
        ]);
        expect((await DB.table('birthdays').where('born', '2024-01-15').pluck('name')).sort()).toEqual(['before', 'seven', 'twin']);
        expect((await DB.table('birthdays').whereDate('born', '2024-01-15').pluck('name')).sort()).toEqual(['before', 'noon', 'seven', 'twin']);
        expect((await DB.table('birthdays').whereDay('born', 8).pluck('name')).sort()).toEqual(['skipped']);
    }, 2000);
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

