import { beforeAll, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { SchemaException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { Join } from '../../src/query/Join';
import type { QueryExecuted } from '../../src/events';

interface User {
    id: number;
    name: string;
    team_id: number | null;
}

interface Post {
    id: number;
    user_id: number;
    title: string;
    label?: string;
}

interface Team {
    id: number;
    label: string;
}

interface Row {
    id: number;
    name: string;
    team_id: number | null;
    user_id: number;
    title: string;
    label?: string;
}

class CreateTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.integer('team_id').nullable();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id').index();
            table.string('title');
        });

        await Schema.create('teams', (table: Blueprint): void => {
            table.id();
            table.string('label');
        });
    }
}

let connection: Connection;

/**
 * Begin a query against the users table.
 */
function users(): Builder<User> {
    return connection.table<User>('users');
}

/**
 * Get the titles a joined query returns.
 */
async function titles(query: Builder<Row>): Promise<(string | undefined)[]> {
    return (await query.get()).map((row: Row): string | undefined => row.title);
}

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'joins', migrations: [CreateTables] });

    await connection.migrate();

    await users().insert([
        { name: 'Alice', team_id: 1 },
        { name: 'Bob', team_id: 1 },
        { name: 'Carol', team_id: null },
    ]);

    await connection.table<Post>('posts').insert([
        { user_id: 1, title: 'First' },
        { user_id: 1, title: 'Second' },
        { user_id: 2, title: 'Third' },
    ]);

    await connection.table<Team>('teams').insert([{ label: 'core' }]);
});

describe('Builder.join', (): void => {
    test('keeps only the rows that match', async (): Promise<void> => {
        const rows: Row[] = await users().join<Row>('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.title').get();

        expect(rows.map((row: Row): string => row.title)).toEqual(['First', 'Second', 'Third']);
    });

    test('flattens the row, letting the joined table win a collision', async (): Promise<void> => {
        const row: Row = await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .where('posts.title', 'Third')
            .firstOrFail();

        // users.id is 2 and posts.id is 3, and SQL hands back the later one.
        expect(row).toEqual({ id: 3, name: 'Bob', team_id: 1, user_id: 2, title: 'Third' });
    });

    test('accepts an implicit equals', async (): Promise<void> => {
        const rows: Row[] = await users().join<Row>('posts', 'users.id', 'posts.user_id').get();

        expect(rows).toHaveLength(3);
    });

    test('drops the rows of this table that match nothing', async (): Promise<void> => {
        const rows: Row[] = await users().join<Row>('posts', 'users.id', '=', 'posts.user_id').get();

        expect(rows.map((row: Row): string => row.name)).not.toContain('Carol');
    });

    test('joins several tables in turn', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .join('teams', 'users.team_id', '=', 'teams.id')
            .orderBy('posts.title')
            .get();

        expect(rows).toHaveLength(3);
        expect(rows[0]?.label).toEqual('core');
    });

    test('announces the query as a join', async (): Promise<void> => {
        const seen: string[] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push(event.plan);
        }) as (event: Event) => void, true);

        await users().join('posts', 'users.id', '=', 'posts.user_id').get();

        expect(seen).toEqual(['join']);
    });
});

describe('Builder.leftJoin', (): void => {
    test('keeps every row of this table', async (): Promise<void> => {
        const rows: Row[] = await users().leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id').get();

        expect(rows).toHaveLength(4);
        expect(rows.map((row: Row): string => row.name)).toContain('Carol');
    });

    test('nulls every column of the missing side, as SQL does', async (): Promise<void> => {
        const row: Row = await users()
            .leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id')
            .where('users.name', 'Carol')
            .firstOrFail();

        expect(row).toEqual({ id: null, name: 'Carol', team_id: null, user_id: null, title: null });
    });

    test('is filterable on the null side', async (): Promise<void> => {
        const rows: Row[] = await users()
            .leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id')
            .whereNull('posts.id')
            .get();

        expect(rows.map((row: Row): string => row.name)).toEqual(['Carol']);
    });
});

describe('Builder.rightJoin', (): void => {
    test('keeps every row of the joined table', async (): Promise<void> => {
        const rows: Row[] = await connection.table<Post>('posts')
            .rightJoin<Row>('users', 'posts.user_id', '=', 'users.id')
            .get();

        expect(rows).toHaveLength(4);
        expect(rows.map((row: Row): string => row.name)).toContain('Carol');
    });
});

describe('Builder.crossJoin', (): void => {
    test('pairs every row with every row', async (): Promise<void> => {
        const rows: Row[] = await users().crossJoin<Row>('teams').get();

        expect(rows).toHaveLength(3);
        expect(rows.every((row: Row): boolean => row.label === 'core')).toEqual(true);
    });
});

describe('Join conditions through a closure', (): void => {
    test('joins on a single condition', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', (join: Join): void => {
                join.on('users.id', '=', 'posts.user_id');
            })
            .get();

        expect(rows).toHaveLength(3);
    });

    test('joins on several conditions', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', (join: Join): void => {
                join.on('users.id', '=', 'posts.user_id').on('posts.title', '!=', 'users.name');
            })
            .get();

        expect(rows).toHaveLength(3);
    });

    test('narrows through a second condition', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', (join: Join): void => {
                join.on('users.id', '=', 'posts.user_id').on('posts.id', '<', 'users.id');
            })
            .get();

        expect(rows).toEqual([]);
    });

    test('widens through a disjunctive condition', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', (join: Join): void => {
                join.on('users.id', '=', 'posts.user_id').orOn('posts.id', '=', 'users.id');
            })
            .get();

        expect(rows.length).toBeGreaterThan(3);
    });

    test('accepts an implicit equals in a closure', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', (join: Join): void => {
                join.on('users.id', 'posts.user_id');
            })
            .get();

        expect(rows).toHaveLength(3);
    });
});

describe('Constraints on a joined query', (): void => {
    test('filters by a qualified column of this table', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('users.name', 'Bob'))).toEqual(['Third']);
    });

    test('filters by a qualified column of the joined table', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('posts.title', 'First'))).toEqual(['First']);
    });

    test('resolves an unqualified column that only one table has', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('title', 'Second'))).toEqual(['Second']);
    });

    test('rejects an unqualified column two tables share', async (): Promise<void> => {
        await expect(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('id', 1).get()).rejects.toThrow(
            new SchemaException('Column [id] is ambiguous across tables [users, posts]. Qualify it, as in [users.id].'),
        );
    });

    test('rejects a column qualified with a table the query does not join', async (): Promise<void> => {
        await expect(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('teams.label', 'core').get()).rejects.toThrow(
            new SchemaException('Column [teams.label] names table [teams], which this query does not join.'),
        );
    });

    test('rejects a column no table has', async (): Promise<void> => {
        await expect(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').where('missing', 1).get()).rejects.toThrow(
            new SchemaException('Column [missing] does not exist on any table this query reads.'),
        );
    });

    test('filters through a nested group', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .where((query: Builder<Row>): void => {
                query.where('posts.title', 'First').orWhere('posts.title', 'Third');
            })
            .orderBy('posts.title')
            .get();

        expect(rows.map((row: Row): string => row.title)).toEqual(['First', 'Third']);
    });

    test('compares two columns of the joined row', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .whereColumn('posts.user_id', '=', 'users.id')
            .get();

        expect(rows).toHaveLength(3);
    });

    test('compares two columns with an implicit equals', async (): Promise<void> => {
        const rows: Row[] = await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .whereColumn('posts.user_id', 'users.id')
            .get();

        expect(rows).toHaveLength(3);
    });

    test('yields nothing when a compared column is null', async (): Promise<void> => {
        const rows: Row[] = await users()
            .leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id')
            .whereColumn('posts.user_id', '=', 'users.team_id')
            .get();

        expect(rows.map((row: Row): string => row.name)).not.toContain('Carol');
    });
});

describe('Shaping a joined query', (): void => {
    test('sorts by a qualified column, descending', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.title', 'desc'))).toEqual(['Third', 'Second', 'First']);
    });

    test('limits the joined rows', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.title').limit(2))).toEqual(['First', 'Second']);
    });

    test('offsets the joined rows', async (): Promise<void> => {
        expect(await titles(users().join<Row>('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.title').offset(2))).toEqual(['Third']);
    });

    test('projects the selected columns', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .select('users.name', 'posts.title')
            .orderBy('posts.title')
            .get();

        expect(rows[0]).toEqual({ name: 'Alice', title: 'First' });
    });

    test('aliases a selected column, which is how both sides of a collision survive', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .select('users.id as user_id', 'posts.id as post_id')
            .orderBy('posts.id')
            .get();

        expect(rows[0]).toEqual({ user_id: 1, post_id: 1 });
    });

    test('rejects a selected column that is ambiguous', async (): Promise<void> => {
        await expect(users().join('posts', 'users.id', '=', 'posts.user_id').select('id').get()).rejects.toThrow(SchemaException);
    });
});

describe('Terminals on a joined query', (): void => {
    test('counts the joined rows', async (): Promise<void> => {
        expect(await users().join('posts', 'users.id', '=', 'posts.user_id').count()).toEqual(3);
    });

    test('gets the first joined row', async (): Promise<void> => {
        const row: Row | null = await users().join<Row>('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.title').first();

        expect(row?.title).toEqual('First');
    });

    test('reports that a joined row exists', async (): Promise<void> => {
        expect(await users().join('posts', 'users.id', '=', 'posts.user_id').exists()).toEqual(true);
    });

    test('plucks a column from the joined rows', async (): Promise<void> => {
        const plucked: string[] = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .orderBy('posts.title')
            .pluck<string>('title');

        expect(plucked).toEqual(['First', 'Second', 'Third']);
    });

    test('gets a single value from the joined rows', async (): Promise<void> => {
        const value: string | null = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .orderBy('posts.title')
            .value<string>('title');

        expect(value).toEqual('First');
    });

    test('sums a column across the joined rows', async (): Promise<void> => {
        expect(await users().join('posts', 'users.id', '=', 'posts.user_id').sum('user_id')).toEqual(4);
    });

    test('groups the joined rows', async (): Promise<void> => {
        const rows: { name: unknown; posts: number }[] = await users()
            .join('posts', 'users.id', '=', 'posts.user_id')
            .groupBy('name')
            .aggregate({ posts: { count: '*' } })
            .orderBy('name')
            .get();

        expect(rows).toEqual([
            { name: 'Alice', posts: 2 },
            { name: 'Bob', posts: 1 },
        ]);
    });

    test('walks the joined rows in chunks', async (): Promise<void> => {
        const pages: string[][] = [];

        await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .orderBy('posts.title')
            .chunk(2, (rows: Row[]): void => {
                pages.push(rows.map((row: Row): string => row.title));
            });

        expect(pages).toEqual([['First', 'Second'], ['Third']]);
    });
});

describe('Joins and clone', (): void => {
    test('carries the joins onto the clone', async (): Promise<void> => {
        const query: Builder<Row> = users().join<Row>('posts', 'users.id', '=', 'posts.user_id');

        expect(await query.clone().count()).toEqual(3);
    });
});

describe('Joined chunking and column comparison edges', (): void => {
    test('stops walking the joined rows when the callback returns false', async (): Promise<void> => {
        const pages: string[][] = [];

        const completed: boolean = await users()
            .join<Row>('posts', 'users.id', '=', 'posts.user_id')
            .orderBy('posts.title')
            .chunk(2, (rows: Row[]): boolean => {
                pages.push(rows.map((row: Row): string => row.title));

                return false;
            });

        expect(completed).toEqual(false);
        expect(pages).toEqual([['First', 'Second']]);
    });

    test('yields nothing when the column compared against is null', async (): Promise<void> => {
        // Carol has a name but, through the left join, no title to compare it with.
        const rows: Row[] = await users()
            .leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id')
            .whereColumn('users.name', '=', 'posts.title')
            .get();

        expect(rows).toEqual([]);
    });
});
