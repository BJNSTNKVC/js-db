import { beforeAll, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import type { Builder } from '../../src/query/Builder';
import type { Grouping } from '../../src/query/Grouping';

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
const users: () => Builder<User> = (): Builder<User> => connection.table<User>('users');

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'grouping', migrations: [CreateUsersTable] });

    await connection.migrate();
    await users().insert(seed);
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
