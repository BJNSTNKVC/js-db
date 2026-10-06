import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import type { Builder } from '../../src/query/Builder';
import { Grouping } from '../../src/query/Grouping';
import { Predicate } from '../../src/query/Predicate';

interface User {
    id: number;
    name: string;
    role: string;
    team: string;
    age: number | null;
    visits: number;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('role').index();
            table.string('team');
            table.integer('age').nullable();
            table.integer('visits');
        });
    }
}

const seed: Omit<User, 'id'>[] = [
    { name: 'Alice', role: 'admin', team: 'core', age: 30, visits: 10 },
    { name: 'Bob', role: 'member', team: 'core', age: 25, visits: 4 },
    { name: 'Carol', role: 'member', team: 'core', age: 35, visits: 6 },
    { name: 'Dave', role: 'member', team: 'ops', age: null, visits: 1 },
    { name: 'Erin', role: 'owner', team: 'ops', age: 41, visits: 8 },
];

type AgeAggregation = { age: { avg: 'age' } } | { age: { min: 'age' } } | { age: { max: 'age' } };

let connection: Connection;

/**
 * Begin a query against the seeded users table.
 */
function users(): Builder<User> {
    return connection.table<User>('users');
}

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'grouping', migrations: [CreateUsersTable] });

    await connection.migrate();
    await users().insert(seed);
});

afterEach((): void => {
    vi.restoreAllMocks();
});

describe('Builder.groupBy', (): void => {
    test('groups by one column and counts each group', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .get();

        expect(rows).toEqual([
            { role: 'admin', total: 1 },
            { role: 'member', total: 3 },
            { role: 'owner', total: 1 },
        ]);
    });

    test('groups by several columns', async (): Promise<void> => {
        const rows: { role: string; team: string; total: number }[] = await users()
            .groupBy('team', 'role')
            .aggregate({ total: { count: '*' } })
            .orderBy('team')
            .orderBy('role')
            .get();

        expect(rows).toEqual([
            { team: 'core', role: 'admin', total: 1 },
            { team: 'core', role: 'member', total: 2 },
            { team: 'ops', role: 'member', total: 1 },
            { team: 'ops', role: 'owner', total: 1 },
        ]);
    });

    test('carries the grouped column value onto the row', async (): Promise<void> => {
        const rows: { team: string; total: number }[] = await users().groupBy('team').aggregate({ total: { count: '*' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; total: number }): string => row.team)).toEqual(['core', 'ops']);
    });

    test('groups without any aggregation, behaving like distinct', async (): Promise<void> => {
        const rows: { team: string }[] = await users().groupBy('team').orderBy('team').get();

        expect(rows).toEqual([{ team: 'core' }, { team: 'ops' }]);
    });

    test('honours the constraints of the query it was opened from', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .where('team', 'core')
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .get();

        expect(rows).toEqual([
            { role: 'admin', total: 1 },
            { role: 'member', total: 2 },
        ]);
    });

    test('ignores the ordering and paging of the query it was opened from', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .orderBy('name')
            .limit(2)
            .offset(1)
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .get();

        expect(rows).toHaveLength(3);
    });
});

describe('Grouping aggregations', (): void => {
    test('counts every member of the group', async (): Promise<void> => {
        const rows: { team: string; total: number }[] = await users().groupBy('team').aggregate({ total: { count: '*' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; total: number }): number => row.total)).toEqual([3, 2]);
    });

    test('counts only the non null values of a column', async (): Promise<void> => {
        const rows: { team: string; ages: number }[] = await users().groupBy('team').aggregate({ ages: { count: 'age' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; ages: number }): number => row.ages)).toEqual([3, 1]);
    });

    test('sums a column', async (): Promise<void> => {
        const rows: { team: string; visits: number | null }[] = await users().groupBy('team').aggregate({ visits: { sum: 'visits' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; visits: number | null }): number | null => row.visits)).toEqual([20, 9]);
    });

    test('sums a group with no values as zero', async (): Promise<void> => {
        const rows: { team: string; ages: number | null }[] = await users().where('name', 'Dave').groupBy('team').aggregate({ ages: { sum: 'age' } }).get();

        expect(rows[0]?.ages).toEqual(0);
    });

    test('averages a column', async (): Promise<void> => {
        const rows: { team: string; age: number | null }[] = await users().groupBy('team').aggregate({ age: { avg: 'age' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; age: number | null }): number | null => row.age)).toEqual([30, 41]);
    });

    test('finds the smallest value of a column', async (): Promise<void> => {
        const rows: { team: string; youngest: number | null }[] = await users().groupBy('team').aggregate({ youngest: { min: 'age' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; youngest: number | null }): number | null => row.youngest)).toEqual([25, 41]);
    });

    test('finds the largest value of a column', async (): Promise<void> => {
        const rows: { team: string; oldest: number | null }[] = await users().groupBy('team').aggregate({ oldest: { max: 'age' } }).orderBy('team').get();

        expect(rows.map((row: { team: string; oldest: number | null }): number | null => row.oldest)).toEqual([35, 41]);
    });

    test.each<[string, AgeAggregation]>([
        ['avg', { age: { avg: 'age' } }],
        ['min', { age: { min: 'age' } }],
        ['max', { age: { max: 'age' } }],
    ])('yields null from %s when the group holds no values', async (_name: string, aggregations: AgeAggregation): Promise<void> => {
        const rows: { team: string; age: number | null }[] = await users().where('name', 'Dave').groupBy('team').aggregate(aggregations).get();

        expect(rows[0]?.age).toBeNull();
    });

    test('computes several aggregates at once', async (): Promise<void> => {
        const rows: { team: string; total: number; oldest: number | null; visited: number | null }[] = await users()
            .groupBy('team')
            .aggregate({
                total  : { count: '*' },
                oldest : { max: 'age' },
                visited: { sum: 'visits' },
            })
            .orderBy('team')
            .get();

        expect(rows[0]).toEqual({ team: 'core', total: 3, oldest: 35, visited: 20 });
    });

    test('replaces the aggregations when called twice', async (): Promise<void> => {
        const rows: { team: string; oldest: number | null }[] = await users()
            .groupBy('team')
            .aggregate({ total: { count: '*' } })
            .aggregate({ oldest: { max: 'age' } })
            .orderBy('team')
            .get();

        expect(rows[0]).toEqual({ team: 'core', oldest: 35 });
    });

    test('carries the constraints and paging across an aggregate call', async (): Promise<void> => {
        const rows: { team: string; total: number }[] = await users()
            .groupBy('team')
            .orderBy('team', 'desc')
            .limit(1)
            .aggregate({ total: { count: '*' } })
            .get();

        expect(rows).toEqual([{ team: 'ops', total: 2 }]);
    });
});

describe('Grouping having', (): void => {
    test('filters the groups by an aggregate', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('total', '>', 1)
            .get();

        expect(rows).toEqual([{ role: 'member', total: 3 }]);
    });

    test('filters with an implicit equals', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('total', 3)
            .get();

        expect(rows).toEqual([{ role: 'member', total: 3 }]);
    });

    test('keeps an explicit operator when the value is undefined', async (): Promise<void> => {
        const compile: MockInstance = vi.spyOn(Predicate, 'compile');

        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('role', '!=', undefined)
            .get();

        expect(compile).toHaveBeenCalledWith([{ type: 'basic', column: 'role', operator: '!=', value: undefined, conjunction: 'and', not: false }]);
        expect(rows).toEqual([]);
    });

    test('filters by a grouped column', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('role', 'owner')
            .get();

        expect(rows).toEqual([{ role: 'owner', total: 1 }]);
    });

    test('accepts a disjunctive constraint', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('role', 'admin')
            .orHaving('role', 'owner')
            .orderBy('role')
            .get();

        expect(rows).toEqual([
            { role: 'admin', total: 1 },
            { role: 'owner', total: 1 },
        ]);
    });

    test('yields nothing when no group matches', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('total', '>', 99)
            .get();

        expect(rows).toEqual([]);
    });
});

describe('Grouping shaping', (): void => {
    test('sorts the groups by an aggregate, descending', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('total', 'desc')
            .get();

        expect(rows.map((row: { role: string; total: number }): number => row.total)).toEqual([3, 1, 1]);
    });

    test('breaks ties with a second order', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('total', 'desc')
            .orderBy('role', 'desc')
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['member', 'owner', 'admin']);
    });

    test('sorts nulls lowest', async (): Promise<void> => {
        const rows: { team: string; youngest: number | null }[] = await users()
            .groupBy('team')
            .aggregate({ youngest: { min: 'age' } })
            .orderBy('youngest')
            .get();

        expect(rows.map((row: { team: string; youngest: number | null }): string => row.team)).toEqual(['core', 'ops']);
    });

    test('leaves groups tied on every order alone', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('total')
            .get();

        expect(rows).toHaveLength(3);
    });

    test('returns groups unsorted when no order is given', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users().groupBy('role').aggregate({ total: { count: '*' } }).get();

        expect(rows).toHaveLength(3);
    });

    test('limits the groups', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .limit(2)
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['admin', 'member']);
    });

    test('offsets the groups', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .offset(2)
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['owner']);
    });

    test('pages the groups', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .offset(1)
            .limit(1)
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['member']);
    });

    test('ignores a negative limit and treats a negative offset as none', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .offset(-2)
            .limit(-1)
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['admin', 'member', 'owner']);
    });

    test('truncates a fractional limit and offset', async (): Promise<void> => {
        const rows: { role: string; total: number }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('role')
            .offset(0.5)
            .limit(1.5)
            .get();

        expect(rows.map((row: { role: string; total: number }): string => row.role)).toEqual(['admin']);
    });
});

describe('Grouping terminals', (): void => {
    test('gets the first group', async (): Promise<void> => {
        const row: { role: string; total: number } | null = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .orderBy('total', 'desc')
            .first();

        expect(row).toEqual({ role: 'member', total: 3 });
    });

    test('gets null when no group matches', async (): Promise<void> => {
        const row: { role: string; total: number } | null = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('total', '>', 99)
            .first();

        expect(row).toBeNull();
    });

    test('counts the groups', async (): Promise<void> => {
        expect(await users().groupBy('role').aggregate({ total: { count: '*' } }).count()).toEqual(3);
    });

    test('counts the groups that survive having', async (): Promise<void> => {
        const grouping: Grouping<User, ['role'], { total: { count: '*' } }> = users()
            .groupBy('role')
            .aggregate({ total: { count: '*' } })
            .having('total', '>', 1);

        expect(await grouping.count()).toEqual(1);
    });

    test('counts nothing for a table with no records', async (): Promise<void> => {
        await users().where('role', 'ghost').groupBy('role').aggregate({ total: { count: '*' } }).get();

        expect(await users().where('role', 'ghost').groupBy('role').count()).toEqual(0);
    });
});

describe('Grouping inference', (): void => {
    test('types a count as a number and a max as nullable', async (): Promise<void> => {
        const rows: { role: string; total: number; oldest: number | null }[] = await users()
            .groupBy('role')
            .aggregate({ total: { count: '*' }, oldest: { max: 'age' } })
            .get();

        const row: { role: string; total: number; oldest: number | null } = rows[0] as { role: string; total: number; oldest: number | null };

        // @ts-expect-error a count is a number, never a string
        const wrong: string = rows[0]!.total;

        // @ts-expect-error a max may be null, so it is not assignable to number
        const nullable: number = rows[0]!.oldest;

        // @ts-expect-error a column that was not grouped or aggregated is not on the row
        const absent: unknown = rows[0]!.name;

        expect(typeof row.role).toEqual('string');
        expect(wrong).toEqual(expect.anything());
        expect(nullable).toEqual(expect.anything());
        expect(absent).toBeUndefined();
    });

    test('rejects grouping by a column the record type does not have', (): void => {
        // @ts-expect-error 'missing' is not a key of User
        const grouping: Grouping<User, ("name" | "role" | "id" | "team" | "age" | "visits")[], Record<string, never>> = users().groupBy('missing');

        expect(grouping).toBeDefined();
    });
});

describe('Grouping over values holding the signature separator', (): void => {
    test('keeps two groups apart rather than merging them', async (): Promise<void> => {
        const separator: string = String.fromCharCode(1);
        const isolated: Connection = new Connection('app', { database: 'grouping-separator', migrations: [CreateUsersTable] });

        await isolated.migrate();

        // Before the segments were length prefixed these two rows encoded to the same group key, so
        // groupBy reported one group of two rather than two groups of one.
        await isolated.table<User>('users').insert([
            { name: 'A', role: `a${separator}s:b`, team: 'c', age: 1, visits: 1 },
            { name: 'B', role: 'a', team: `b${separator}s:c`, age: 1, visits: 1 },
        ]);

        const rows: { role: string; team: string; total: number }[] = await isolated.table<User>('users')
            .groupBy('role', 'team')
            .aggregate({ total: { count: '*' } })
            .get();

        expect(rows).toHaveLength(2);
        expect(rows.map((row: { role: string; team: string; total: number }): number => row.total)).toEqual([1, 1]);

        isolated.disconnect();
    });
});

describe('Grouping by JSON values', (): void => {
    interface Layout {
        id: number;
        owner_id: number;
        meta: unknown;
        size: number;
    }

    interface Owner {
        id: number;
        name: string;
    }

    class CreateLayoutsTables extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await Schema.create('owners', (table: Blueprint): void => {
                table.id();
                table.string('name');
            });

            await Schema.create('layouts', (table: Blueprint): void => {
                table.id();
                table.integer('owner_id');
                table.json('meta').nullable();
                table.integer('size');
            });
        }
    }

    const REPRODUCTION: unknown[] = [
        { x: 1, y: 2 },
        { y: 2, x: 1 },
        { x: 1 },
        { y: 2 },
        { x: 1, y: '2' },
        { x: 1, y: 2, z: null },
    ];

    let layouts: () => Builder<Layout>;
    let isolated: Connection;

    /**
     * Replace the layouts with one owned by Ann for each value, sized by its position.
     */
    async function seeded(metas: unknown[]): Promise<void> {
        await layouts().truncate();
        await layouts().insert(metas.map((meta: unknown, index: number): Omit<Layout, 'id'> => ({ owner_id: 1, meta, size: index + 1 })));
    }

    beforeAll(async (): Promise<void> => {
        isolated = new Connection('app', { database: 'grouping-json', migrations: [CreateLayoutsTables] });
        layouts = (): Builder<Layout> => isolated.table<Layout>('layouts');

        await isolated.migrate();
        await isolated.table<Owner>('owners').insert({ name: 'Ann' });
    });

    test('groups objects holding the same keys in any order together', async (): Promise<void> => {
        await seeded(REPRODUCTION);

        expect(await layouts().groupBy('meta').aggregate({ total: { count: '*' }, largest: { max: 'size' } }).get()).toEqual([
            { meta: { x: 1, y: 2 }, total: 2, largest: 2 },
            { meta: { x: 1 }, total: 1, largest: 3 },
            { meta: { y: 2 }, total: 1, largest: 4 },
            { meta: { x: 1, y: '2' }, total: 1, largest: 5 },
            { meta: { x: 1, y: 2, z: null }, total: 1, largest: 6 },
        ]);
        expect(await layouts().groupBy('owner_id', 'meta').aggregate({ total: { count: '*' } }).get()).toHaveLength(5);
    });

    test('counts, filters, sorts and pages the merged groups', async (): Promise<void> => {
        await seeded(REPRODUCTION);

        expect(await layouts().groupBy('meta').count()).toEqual(5);
        expect(await layouts().groupBy('meta').aggregate({ total: { count: '*' } }).having('total', '>', 1).get()).toEqual([
            { meta: { x: 1, y: 2 }, total: 2 },
        ]);
        expect(await layouts().groupBy('meta').aggregate({ total: { count: '*' } }).orderBy('total', 'desc').first()).toEqual({ meta: { x: 1, y: 2 }, total: 2 });
        expect(await layouts().groupBy('meta').offset(3).limit(5).count()).toEqual(2);
    });

    test('groups them together on a joined query', async (): Promise<void> => {
        await seeded(REPRODUCTION);

        const joined: () => Builder<Owner & Layout> = (): Builder<Owner & Layout> => isolated.table<Owner>('owners')
            .join<Owner & Layout>('layouts', 'owners.id', '=', 'layouts.owner_id');

        expect(await joined().groupBy('meta').count()).toEqual(5);
        expect(await joined().groupBy('name', 'meta').aggregate({ total: { count: '*' } }).first()).toEqual({ name: 'Ann', meta: { x: 1, y: 2 }, total: 2 });
    });

    test('keeps arrays in a different order and nested values the top level keeps apart in groups of their own', async (): Promise<void> => {
        const metas: unknown[] = [
            [1, 2],
            [2, 1],
            [{ x: 1 }, { y: 2 }],
            [{ y: 2 }, { x: 1 }],
            { a: 1 },
            { a: '1' },
            { a: new Date(0) },
            { a: new Date(0).toISOString() },
            { a: undefined },
            {},
            { a: null },
            [null],
            [undefined],
        ];

        await seeded(metas);

        expect(await layouts().groupBy('meta').count()).toEqual(metas.length);
    });

    test('groups nested objects by content inside arrays and objects', async (): Promise<void> => {
        await seeded([
            { a: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] },
            { list: [{ q: 2, p: 1 }], a: { y: 2, x: 1 } },
            [{ x: 1, y: [{ m: 1, n: 2 }] }],
            [{ y: [{ n: 2, m: 1 }], x: 1 }],
        ]);

        expect(await layouts().groupBy('meta').aggregate({ total: { count: '*' } }).get()).toEqual([
            { meta: { a: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] }, total: 2 },
            { meta: [{ x: 1, y: [{ m: 1, n: 2 }] }], total: 2 },
        ]);
    });
});

describe('Grouping over a JSON path', (): void => {
    class CreateScoresTable extends Migration {
        /**
         * Run the migration.
         */
        override async up(): Promise<void> {
            await Schema.create('scores', (table: Blueprint): void => {
                table.id();
                table.string('team');
                table.json('stats').nullable();
            });
        }
    }

    let scores: () => Builder;

    beforeAll(async (): Promise<void> => {
        const isolated: Connection = new Connection('app', { database: 'grouping-paths', migrations: [CreateScoresTable] });

        scores = (): Builder => isolated.table('scores');

        await isolated.migrate();
        await scores().insert([
            { team: 'core', stats: { points: 10, tier: 'gold' } },
            { team: 'core', stats: { points: 4, tier: 'silver' } },
            { team: 'ops', stats: { points: 6, tier: 'gold' } },
            { team: 'ops', stats: null },
            { team: 'ops', stats: { tier: 'silver' } },
        ]);
    });

    test('aggregates a path in each group', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await scores()
            .groupBy('team')
            .aggregate({
                total  : { sum: 'stats->points' },
                average: { avg: 'stats->points' },
                least  : { min: 'stats->points' },
                most   : { max: 'stats->points' },
                counted: { count: 'stats->points' },
            })
            .orderBy('team')
            .get();

        expect(rows).toEqual([
            { team: 'core', total: 14, average: 7, least: 4, most: 10, counted: 2 },
            { team: 'ops', total: 6, average: 6, least: 6, most: 6, counted: 1 },
        ]);
    });

    test('groups by a path, named after its last step', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await scores()
            .whereNotNull('stats')
            .groupBy('stats->tier')
            .aggregate({ total: { sum: 'stats->points' } })
            .orderBy('stats->tier')
            .get();

        expect(rows).toEqual([
            { tier: 'gold', total: 16 },
            { tier: 'silver', total: 4 },
        ]);
    });

    test('constrains and sorts the groups by a grouped path', async (): Promise<void> => {
        const grouped: () => Grouping<Record<string, unknown>, ['stats->tier']> = (): Grouping<Record<string, unknown>, ['stats->tier']> => scores().whereNotNull('stats').groupBy('stats->tier');

        expect(await grouped().having('stats->tier', 'gold').get()).toEqual([{ tier: 'gold' }]);
        expect(await grouped().orderBy('stats->tier', 'desc').get()).toEqual([{ tier: 'silver' }, { tier: 'gold' }]);
    });
});

describe('Grouping constructed without a way to place columns', (): void => {
    test('reads having and orderBy columns by the names the groups take, leaving any other as given', async (): Promise<void> => {
        const grouping: () => Grouping<Record<string, unknown>, ['team']> = (): Grouping<Record<string, unknown>, ['team']> => new Grouping<Record<string, unknown>, ['team']>(
            async (): Promise<Record<string, unknown>[]> => [{ team: 'core' }, { team: 'ops' }],
            ['team'],
            new Map<string, string>([['team', 'team']]),
        );

        expect(await grouping().having('team', 'ops').get()).toEqual([{ team: 'ops' }]);
        expect(await grouping().orderBy('team', 'desc').get()).toEqual([{ team: 'ops' }, { team: 'core' }]);
        expect(await grouping().orderBy('users.team', 'desc').get()).toEqual([{ team: 'core' }, { team: 'ops' }]);
    });
});
