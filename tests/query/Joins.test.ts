import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Migrator } from '../../src/migrations/Migrator';
import { Request } from '../../src/database/Request';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { SchemaException } from '../../src/exceptions';
import { Predicate } from '../../src/query/Predicate';
import type { Builder } from '../../src/query/Builder';
import type { Transaction } from '../../src/database/Transaction';
import type { Join } from '../../src/query/Join';
import type { QueryExecuted } from '../../src/events';
import type { Constraint, Paginated } from '../../src/query/types';

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

describe('Finding through a join', (): void => {
    /**
     * Join the users to their posts.
     */
    function posted(): Builder<Row> {
        return users().join<Row>('posts', 'users.id', '=', 'posts.user_id');
    }

    test('finds nothing for a base row the inner join drops', async (): Promise<void> => {
        expect(await posted().find(3)).toBeNull();
    });

    test('fails for a base row the inner join drops', async (): Promise<void> => {
        await expect(posted().findOrFail(3)).rejects.toThrow('No record with key [3] in table [users].');
    });

    test('finds the joined row by the key of this table, not a joined column of that name', async (): Promise<void> => {
        expect(await posted().find(2)).toEqual({ id: 3, name: 'Bob', team_id: 1, user_id: 2, title: 'Third' });
    });

    test('finds nothing for a key whose joined rows the constraints exclude', async (): Promise<void> => {
        expect(await posted().where('posts.title', 'Third').find(1)).toBeNull();
    });

    test('keeps a base row with no match through a left join, nulling the other side', async (): Promise<void> => {
        const row: Row | null = await users().leftJoin<Row>('posts', 'users.id', '=', 'posts.user_id').find(3);

        expect(row).toEqual({ id: null, name: 'Carol', team_id: null, user_id: null, title: null });
    });

    test('finds nothing for a row a right join keeps for the joined table alone', async (): Promise<void> => {
        const kept: Builder<Row> = connection.table<Post>('posts')
            .rightJoin<Row>('users', 'posts.user_id', '=', 'users.id')
            .where('users.name', 'Carol');

        expect(await kept.clone().count()).toEqual(1);
        expect(await kept.find(3)).toBeNull();
    });

    test('finds the first of a key\'s joined rows in the query\'s order', async (): Promise<void> => {
        expect((await posted().find(1))?.title).toEqual('First');
        expect((await posted().orderBy('posts.title', 'desc').find(1))?.title).toEqual('Second');
        expect(['First', 'Second']).toContain((await posted().inRandomOrder().find(1))?.title);
    });

    test.each([
        ['limit(0)', (query: Builder<Row>): Builder<Row> => query.limit(0)],
        ['an offset past one row', (query: Builder<Row>): Builder<Row> => query.offset(1)],
    ] as [string, (query: Builder<Row>) => Builder<Row>][])('finds regardless of %s', async (_: string, shape: (query: Builder<Row>) => Builder<Row>): Promise<void> => {
        expect((await shape(posted()).find(2))?.title).toEqual('Third');
    });

    test('applies the select to the joined row, under its aliases', async (): Promise<void> => {
        expect(await posted().select('users.name', 'posts.title as post').find(2)).toEqual({ name: 'Bob', post: 'Third' });
    });

    test('finds the selected row on a distinct query', async (): Promise<void> => {
        expect(await posted().select('users.name').distinct().find(1)).toEqual({ name: 'Alice' });
    });

    test('finds through a join inside a transaction', async (): Promise<void> => {
        const found: (Row | null)[] = await connection.transaction(async (transaction: Transaction): Promise<(Row | null)[]> => {
            const joined: () => Builder<Row> = (): Builder<Row> => transaction.table<User>('users').join<Row>('posts', 'users.id', '=', 'posts.user_id');

            return [await joined().find(3), await joined().find(2)];
        });

        expect(found.map((row: Row | null): string | null => row?.title ?? null)).toEqual([null, 'Third']);
    });

    test('announces a joined find as a join, counting the row it returns', async (): Promise<void> => {
        const seen: [string, number][] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            seen.push([event.plan, event.records]);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        try {
            await posted().find(3);
            await posted().find(1);
        } finally {
            Dispatcher.forget('db:query', listener);
        }

        expect(seen).toEqual([['join', 0], ['join', 1]]);
    });
});

describe('Distinct on a joined query', (): void => {
    /**
     * Begin a query for the distinct names of the users who wrote a post.
     */
    function writers(): Builder<Row> {
        return users().join<Row>('posts', 'users.id', '=', 'posts.user_id').select('users.name').distinct();
    }

    test('removes duplicates before the offset and the limit', async (): Promise<void> => {
        expect(await writers().get()).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
        expect(await writers().limit(1).get()).toEqual([{ name: 'Alice' }]);
        expect(await writers().offset(1).get()).toEqual([{ name: 'Bob' }]);
        expect(await writers().offset(1).limit(1).get()).toEqual([{ name: 'Bob' }]);
        expect(await writers().limit(0).get()).toEqual([]);
        expect(await writers().offset(2).get()).toEqual([]);
    });

    test('counts and pages through the distinct rows', async (): Promise<void> => {
        expect(await writers().count()).toEqual(2);
        expect(await writers().paginate(1, 1)).toEqual({ data: [{ name: 'Alice' }], total: 2, perPage: 1, currentPage: 1, lastPage: 2 });
        expect((await writers().paginate(2, 1)).data).toEqual([{ name: 'Bob' }]);
    });

    test('plucks the distinct values of a column', async (): Promise<void> => {
        expect(await writers().pluck('users.name')).toEqual(['Alice', 'Bob']);
        expect(await writers().pluck('name')).toEqual(['Alice', 'Bob']);
        expect(await writers().pluck('posts.user_id', 'users.name')).toEqual({ Alice: 1, Bob: 2 });
    });

    test('reads the first distinct row for value, first and exists', async (): Promise<void> => {
        expect(await writers().value('users.name')).toEqual('Alice');
        expect(await writers().first()).toEqual({ name: 'Alice' });
        expect(await writers().exists()).toEqual(true);
    });

    test('sums and averages the distinct values of a column', async (): Promise<void> => {
        const joined: Builder<Row> = users().join<Row>('posts', 'users.id', '=', 'posts.user_id').distinct();

        expect(await joined.clone().sum('user_id')).toEqual(3);
        expect(await joined.clone().avg('user_id')).toEqual(1.5);
    });

    test('walks the distinct rows in chunks, lazily and one at a time', async (): Promise<void> => {
        const pages: Row[][] = [];
        const lazy: Row[] = [];
        const each: [Row, number][] = [];

        await writers().chunk(1, (rows: Row[]): void => {
            pages.push(rows);
        });

        for await (const row of writers().lazy(1)) {
            lazy.push(row);
        }

        await writers().each((row: Row, index: number): void => {
            each.push([row, index]);
        });

        expect(pages).toEqual([[{ name: 'Alice' }], [{ name: 'Bob' }]]);
        expect(lazy).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
        expect(each).toEqual([[{ name: 'Alice' }, 0], [{ name: 'Bob' }, 1]]);
    });

    test('keeps every joined row without a select, since each holds the post it joined', async (): Promise<void> => {
        const joined: Builder<Row> = users().join<Row>('posts', 'users.id', '=', 'posts.user_id').distinct();

        expect(await joined.clone().get()).toHaveLength(3);
        expect(await joined.clone().count()).toEqual(3);
    });

    test('reports the distinct rows it returns', async (): Promise<void> => {
        const records: number[] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            records.push(event.records);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        try {
            await writers().offset(1).get();
        } finally {
            Dispatcher.forget('db:query', listener);
        }

        expect(records).toEqual([1]);
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

    test('leaves out a column the stored record does not hold', async (): Promise<void> => {
        const sparse: Connection = new Connection('app', { database: 'joins-sparse', migrations: [CreateTables] });

        await sparse.migrate();

        const database: IDBDatabase = await sparse.open();
        const transaction: IDBTransaction = database.transaction(['users', 'posts'], 'readwrite');

        // Written without team_id, as a record stored before that column was added would be.
        transaction.objectStore('users').add({ name: 'Dave' });
        transaction.objectStore('posts').add({ user_id: 1, title: 'Fourth' });

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            transaction.oncomplete = (): void => resolve();
            transaction.onerror = (): void => reject(transaction.error);
        });

        const rows: Row[] = await sparse.table<User>('users').join<Row>('posts', 'users.id', '=', 'posts.user_id').get();

        sparse.disconnect();

        expect(rows).toStrictEqual([{ id: 1, name: 'Dave', user_id: 1, title: 'Fourth' }]);
    });
});

interface Member {
    id: number;
    name: string;
    active: boolean;
    votes: number;
    karma: number | null;
}

interface Note {
    user_id: number;
    body: string;
}

type JoinKind = 'inner' | 'left' | 'right' | 'cross';

class CreateWritableTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.boolean('active');
            table.integer('votes');
            table.integer('karma').nullable();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id');
            table.string('title');
        });

        await Schema.create('notes', (table: Blueprint): void => {
            table.integer('user_id');
            table.string('body');
        });
    }
}

let writable: Connection;
let databases: number = 0;

/**
 * Begin a query against the users table of the writable database.
 */
function members(): Builder<Member> {
    return writable.table<Member>('users');
}

/**
 * Get the names of the users left in the writable database.
 */
async function remaining(): Promise<string[]> {
    return (await members().orderBy('name').get()).map((member: Member): string => member.name);
}

/**
 * Get the names of the users holding the given value.
 */
async function named(column: keyof Member, value: unknown): Promise<string[]> {
    return (await members().where(column, value).orderBy('name').get()).map((member: Member): string => member.name);
}

/**
 * Get every user and post in the writable database.
 */
async function snapshot(): Promise<unknown[]> {
    return [await members().orderBy('id').get(), await writable.table<Post>('posts').orderBy('id').get()];
}

/**
 * Join the users of the writable database to their posts through the given kind of join.
 */
function joined(kind: JoinKind): Builder<Member> {
    if (kind === 'cross') {
        return members().crossJoin<Member>('posts');
    }

    const method: 'join' | 'leftJoin' | 'rightJoin' = kind === 'inner' ? 'join' : `${kind}Join`;

    return members()[method]<Member>('posts', 'users.id', '=', 'posts.user_id');
}

describe('Writing through a join', (): void => {
    beforeEach(async (): Promise<void> => {
        writable = new Connection('app', { database: `joins-writable-${++databases}`, migrations: [CreateWritableTables] });

        await writable.migrate();

        await members().insert([
            { name: 'Alice', active: false, votes: 0 },
            { name: 'Bob', active: false, votes: 0 },
        ]);

        await writable.table<Post>('posts').insert([
            { user_id: 1, title: 'Hello' },
            { user_id: 1, title: 'Other' },
            { user_id: 9, title: 'Orphan' },
        ]);

        await writable.table<Note>('notes').insert([
            { user_id: 1, body: 'From Alice' },
            { user_id: 2, body: 'From Bob' },
        ]);
    });

    test('deletes only the rows the join keeps', async (): Promise<void> => {
        expect(await joined('inner').where('active', false).delete()).toEqual(1);
        expect(await remaining()).toEqual(['Bob']);
    });

    test('updates through a constraint on a joined column', async (): Promise<void> => {
        expect(await joined('inner').where('posts.title', 'Hello').update({ active: true })).toEqual(1);
        expect(await named('active', true)).toEqual(['Alice']);
    });

    describe.each([
        ['inner', ['Alice']],
        ['left', ['Alice', 'Bob']],
        ['right', ['Alice']],
        ['cross', ['Alice', 'Bob']],
    ] as [JoinKind, string[]][])('through a %s join', (kind: JoinKind, touched: string[]): void => {
        const untouched: string[] = ['Alice', 'Bob'].filter((name: string): boolean => !touched.includes(name));

        test('updates exactly the base rows it keeps', async (): Promise<void> => {
            const posts: unknown = (await snapshot())[1];

            expect(await joined(kind).update({ active: true })).toEqual(touched.length);
            expect(await named('active', true)).toEqual(touched);
            expect((await snapshot())[1]).toEqual(posts);
        });

        test('deletes exactly the base rows it keeps', async (): Promise<void> => {
            const posts: unknown = (await snapshot())[1];

            expect(await joined(kind).delete()).toEqual(touched.length);
            expect(await remaining()).toEqual(untouched);
            expect((await snapshot())[1]).toEqual(posts);
        });

        test('increments exactly the base rows it keeps, once each', async (): Promise<void> => {
            const posts: unknown = (await snapshot())[1];

            expect(await joined(kind).increment('votes')).toEqual(touched.length);
            expect(await named('votes', 1)).toEqual(touched);
            expect(await named('votes', 0)).toEqual(untouched);
            expect((await snapshot())[1]).toEqual(posts);
        });

        test('decrements exactly the base rows it keeps, once each', async (): Promise<void> => {
            const posts: unknown = (await snapshot())[1];

            expect(await joined(kind).decrement('votes', 2)).toEqual(touched.length);
            expect(await named('votes', -2)).toEqual(touched);
            expect(await named('votes', 0)).toEqual(untouched);
            expect((await snapshot())[1]).toEqual(posts);
        });
    });

    test('increments a base row joined twice only once', async (): Promise<void> => {
        await joined('inner').where('users.name', 'Alice').increment('votes', 5);

        expect(await named('votes', 5)).toEqual(['Alice']);
    });

    test('leaves a null column null on a base row joined twice, counting the row once', async (): Promise<void> => {
        await members().where('name', 'Bob').update({ karma: 3 });

        expect(await joined('left').increment('karma', 2, { active: true })).toEqual(2);
        expect(await members().orderBy('id').get()).toMatchObject([
            { name: 'Alice', karma: null, active: true },
            { name: 'Bob', karma: 5, active: true },
        ]);
    });

    test('deletes the base rows with no match through a left join', async (): Promise<void> => {
        expect(await joined('left').whereNull('posts.id').delete()).toEqual(1);
        expect(await remaining()).toEqual(['Alice']);
    });

    test('writes to a table without a key path', async (): Promise<void> => {
        const deleted: number = await writable.table<Note>('notes')
            .join('users', 'notes.user_id', '=', 'users.id')
            .where('users.name', 'Alice')
            .delete();

        const notes: Note[] = await writable.table<Note>('notes').get();

        expect(deleted).toEqual(1);
        expect(notes.map((note: Note): string => note.body)).toEqual(['From Bob']);
    });

    test('finds through a join from a table without a key path', async (): Promise<void> => {
        const noted: () => Builder<Record<string, unknown>> = (): Builder<Record<string, unknown>> => writable.table('notes')
            .join('users', 'notes.user_id', '=', 'users.id')
            .where('users.name', 'Bob');

        expect(await noted().find(1)).toBeNull();
        expect(await noted().select('notes.body', 'users.name').find(2)).toEqual({ body: 'From Bob', name: 'Bob' });
    });

    test('updates a base column given qualified', async (): Promise<void> => {
        await joined('inner').update({ 'users.active': true } as Partial<Member>);

        const alice: Record<string, unknown> = await members().where('name', 'Alice').firstOrFail() as unknown as Record<string, unknown>;

        expect(alice.active).toEqual(true);
        expect(Object.hasOwn(alice, 'users.active')).toEqual(false);
    });

    test('writes a column no table declares to the base table, as an update without a join does', async (): Promise<void> => {
        await joined('inner').update({ nickname: 'Al' } as Partial<Member>);

        const alice: Record<string, unknown> = await members().where('name', 'Alice').firstOrFail() as unknown as Record<string, unknown>;

        expect(alice.nickname).toEqual('Al');
    });

    test('increments a base column given qualified', async (): Promise<void> => {
        await joined('inner').increment('users.votes' as keyof Member, 3);

        expect(await named('votes', 3)).toEqual(['Alice']);
    });

    test.each([
        ['qualified', { 'posts.title': 'Changed' }],
        ['unqualified', { title: 'Changed' }],
    ])('refuses to update a joined column given %s', async (_: string, values: Record<string, unknown>): Promise<void> => {
        const before: unknown[] = await snapshot();

        await expect(joined('inner').update(values as Partial<Member>)).rejects.toThrow(SchemaException);

        expect(await snapshot()).toEqual(before);
    });

    test('refuses to increment a joined column', async (): Promise<void> => {
        const before: unknown[] = await snapshot();

        await expect(joined('inner').increment('posts.user_id' as keyof Member)).rejects.toThrow(SchemaException);

        expect(await snapshot()).toEqual(before);
    });

    test.each([
        ['orderBy', (query: Builder<Member>): Builder<Member> => query.orderBy('name')],
        ['inRandomOrder', (query: Builder<Member>): Builder<Member> => query.inRandomOrder()],
        ['limit', (query: Builder<Member>): Builder<Member> => query.limit(1)],
        ['offset', (query: Builder<Member>): Builder<Member> => query.offset(1)],
    ])('refuses %s on a joined write', async (_: string, shape: (query: Builder<Member>) => Builder<Member>): Promise<void> => {
        const before: unknown[] = await snapshot();

        await expect(shape(joined('left')).delete()).rejects.toThrow(SchemaException);
        await expect(shape(joined('left')).update({ active: true })).rejects.toThrow(SchemaException);
        await expect(shape(joined('left')).increment('votes')).rejects.toThrow(SchemaException);

        expect(await snapshot()).toEqual(before);
    });

    test.each([
        ['insert', (query: Builder<Member>): Promise<unknown> => query.insert({ name: 'Carol', active: true, votes: 0 })],
        ['insertOrIgnore', (query: Builder<Member>): Promise<unknown> => query.insertOrIgnore({ name: 'Carol', active: true, votes: 0 })],
        ['insertGetId', (query: Builder<Member>): Promise<unknown> => query.insertGetId({ name: 'Carol', active: true, votes: 0 })],
        ['upsert', (query: Builder<Member>): Promise<unknown> => query.upsert([{ id: 1, name: 'Carol', active: true, votes: 0 }], 'id')],
        ['updateOrInsert', (query: Builder<Member>): Promise<unknown> => query.updateOrInsert({ name: 'Alice' }, { votes: 7 })],
        ['truncate', (query: Builder<Member>): Promise<unknown> => query.truncate()],
    ])('refuses %s through a join', async (operation: string, write: (query: Builder<Member>) => Promise<unknown>): Promise<void> => {
        const before: unknown[] = await snapshot();

        await expect(write(joined('inner'))).rejects.toThrow(`Table [users] does not support ${operation} through a join.`);

        expect(await snapshot()).toEqual(before);
    });

    test('commits with the transaction it runs in', async (): Promise<void> => {
        await writable.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<Member>('users').join('posts', 'users.id', '=', 'posts.user_id').delete();
        });

        expect(await remaining()).toEqual(['Bob']);
    });

    test('rolls back with the transaction it runs in', async (): Promise<void> => {
        await expect(writable.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<Member>('users').join('posts', 'users.id', '=', 'posts.user_id').delete();

            throw new Error('Rolled back.');
        })).rejects.toThrow('Rolled back.');

        expect(await remaining()).toEqual(['Alice', 'Bob']);
    });

    test('refuses a transaction that leaves out a joined table', async (): Promise<void> => {
        await expect(writable.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<Member>('users').join('posts', 'users.id', '=', 'posts.user_id').delete();
        }, { tables: ['users'] })).rejects.toThrow('Table [posts] is outside the scope of this transaction.');

        expect(await remaining()).toEqual(['Alice', 'Bob']);
    });

    test('announces the write as a join, with the rows written', async (): Promise<void> => {
        const seen: [string, number][] = [];

        Dispatcher.listen('db:query', ((event: QueryExecuted): void => {
            seen.push([event.plan, event.records]);
        }) as (event: Event) => void, true);

        await joined('left').update({ active: true });

        expect(seen).toEqual([['join', 2]]);
    });
});

interface Person {
    id: number;
    name: string;
    active: boolean;
    born: Date;
}

interface Ticket {
    person_id: number;
    active: string;
    code: string;
}

interface Pass {
    name: string;
    born: Date;
    code: string;
}

class CreateTypedTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('people', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.boolean('active');
            table.datetime('born');
        });

        await Schema.create('tickets', (table: Blueprint): void => {
            table.id();
            table.integer('person_id');
            table.string('active');
            table.string('code');
        });
    }
}

describe('Values compared on a joined query', (): void => {
    let typed: Connection;

    /**
     * Join the people to their tickets, returning the codes the given constraints keep.
     */
    async function codes(constrain: (query: Builder<Pass>) => Builder<Pass>): Promise<string[]> {
        const query: Builder<Pass> = typed.table<Person>('people').join<Pass>('tickets', 'people.id', '=', 'tickets.person_id');

        return (await constrain(query).orderBy('code').get()).map((row: Pass): string => row.code);
    }

    beforeAll(async (): Promise<void> => {
        typed = new Connection('app', { database: 'joins-typed', migrations: [CreateTypedTables] });

        await typed.migrate();

        await typed.table<Person>('people').insert([
            { name: 'Alice', active: true, born: new Date('1990-05-01T00:00:00.000Z') },
            { name: 'Bob', active: false, born: new Date('1985-02-11T00:00:00.000Z') },
        ]);

        await typed.table<Ticket>('tickets').insert([
            { person_id: 1, active: 'true', code: 'A1' },
            { person_id: 1, active: 'yes', code: 'A2' },
            { person_id: 2, active: 'true', code: 'B1' },
        ]);
    });

    test('converts each value with the schema of the table its column belongs to', async (): Promise<void> => {
        expect(await codes((query: Builder<Pass>): Builder<Pass> => query.where('people.active', 'true').where('tickets.active', 'true'))).toEqual(['A1']);
    });

    test('converts a value given for an unqualified column', async (): Promise<void> => {
        expect(await codes((query: Builder<Pass>): Builder<Pass> => query.where('born', '>', '1988-01-01T00:00:00.000Z'))).toEqual(['A1', 'A2']);
    });
});

interface Author {
    id: number;
    name: string;
    joined: Date | null;
}

interface Entry {
    id: number;
    user_id: number | null;
    author: string | null;
    day: Date | null;
    title: string;
}

interface Authored {
    name: string | null;
    title: string | null;
}

type Matching = Exclude<JoinKind, 'cross'>;

class CreateAuthoredTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.datetime('joined').nullable();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id').nullable();
            table.string('author').nullable();
            table.date('day').nullable();
            table.string('title');
        });
    }
}

class AddOwnerToUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('users', (table: Blueprint): void => {
            table.integer('owner').default(2);
        });

        await Request.walk(Migrator.alive().transaction.objectStore('users').openCursor(), (cursor: IDBCursorWithValue): void => {
            cursor.update({ ...cursor.value, owner: '2' });
        });
    }
}

const PAIRINGS: [string, string, string][] = [
    ['a number against a string id', 'users.id', 'posts.author'],
    ['two dates', 'users.joined', 'posts.day'],
];

const MATCHED: Record<Matching, string[]> = {
    inner: ['Alice:First', 'Alice:Second', 'Bob:Third'],
    left : ['Alice:First', 'Alice:Second', 'Bob:Third', 'Carol:null', 'Dave:null'],
    right: ['Alice:First', 'Alice:Second', 'Bob:Third', 'null:Fourth'],
};

describe('Joins across the types the columns hold', (): void => {
    let authored: Connection;

    /**
     * Begin a query against the users table of the authored database.
     */
    function authors(): Builder<Author> {
        return authored.table<Author>('users');
    }

    /**
     * Join the users to their posts on the given columns, in the order given, once or several times over.
     */
    function paired(kind: Matching, columns: [string, string], times: number = 1): Builder<Authored> {
        const method: 'join' | 'leftJoin' | 'rightJoin' = kind === 'inner' ? 'join' : `${kind}Join`;

        return authors()[method]<Authored>('posts', (join: Join): void => {
            for (let index: number = 0; index < times; index++) {
                join.on(columns[0], '=', columns[1]);
            }
        });
    }

    /**
     * Get the name and title of every row a joined query returns, sorted.
     */
    async function rows(query: Builder<Authored>): Promise<string[]> {
        return (await query.get()).map((row: Authored): string => `${row.name}:${row.title}`).sort();
    }

    /**
     * Count the rows the join conditions are tested against while the given query runs.
     */
    async function tested(query: Builder<Authored>): Promise<number> {
        const compile: typeof Predicate.compile = Predicate.compile.bind(Predicate);
        let count: number = 0;

        const spy = vi.spyOn(Predicate, 'compile').mockImplementation((constraints: readonly Constraint[]): ((record: Record<string, unknown>) => boolean) => {
            const matches: (record: Record<string, unknown>) => boolean = compile(constraints);

            if (constraints.length === 0 || constraints.some((constraint: Constraint): boolean => constraint.type !== 'column')) {
                return matches;
            }

            return (record: Record<string, unknown>): boolean => {
                count++;

                return matches(record);
            };
        });

        try {
            await query.get();
        } finally {
            spy.mockRestore();
        }

        return count;
    }

    beforeEach(async (): Promise<void> => {
        authored = new Connection('app', { database: `joins-authored-${++databases}`, migrations: [CreateAuthoredTables] });

        await authored.migrate();

        await authors().insert([
            { name: 'Alice', joined: new Date('2024-01-01T00:00:00.000Z') },
            { name: 'Bob', joined: new Date('2024-02-01T00:00:00.000Z') },
            { name: 'Carol', joined: new Date('2024-03-01T00:00:00.000Z') },
            { name: 'Dave', joined: null },
        ]);

        await authored.table<Entry>('posts').insert([
            { user_id: 1, author: '1', day: new Date('2024-01-01T00:00:00.000Z'), title: 'First' },
            { user_id: 1, author: '1', day: new Date('2024-01-01T00:00:00.000Z'), title: 'Second' },
            { user_id: 2, author: '2', day: new Date('2024-02-01T00:00:00.000Z'), title: 'Third' },
            { user_id: null, author: null, day: null, title: 'Fourth' },
        ]);
    });

    describe.each(PAIRINGS)('on %s', (_: string, first: string, second: string): void => {
        describe.each([
            ['users', [first, second]],
            ['posts', [second, first]],
        ] as [string, [string, string]][])('written with the %s column first', (_side: string, columns: [string, string]): void => {
            test.each(['inner', 'left', 'right'] as Matching[])('matches every pair through a %s join', async (kind: Matching): Promise<void> => {
                expect(await rows(paired(kind, columns))).toEqual(MATCHED[kind]);
            });

            test.each(['inner', 'left', 'right'] as Matching[])('gives a %s join the rows of the same join with its condition repeated', async (kind: Matching): Promise<void> => {
                expect(await rows(paired(kind, columns))).toEqual(await rows(paired(kind, columns, 2)));
            });
        });

        test.each([
            ['inner', [first, second]],
            ['right', [second, first]],
        ] as [Matching, [string, string]][])('updates the users a %s join keeps', async (kind: Matching, columns: [string, string]): Promise<void> => {
            expect(await paired(kind, columns).update({ name: 'Author' })).toEqual(2);
            expect((await authors().orderBy('id').get()).map((author: Author): string => author.name)).toEqual(['Author', 'Author', 'Carol', 'Dave']);
        });

        test.each([
            ['inner', [first, second]],
            ['right', [second, first]],
        ] as [Matching, [string, string]][])('deletes the users a %s join keeps', async (kind: Matching, columns: [string, string]): Promise<void> => {
            expect(await paired(kind, columns).delete()).toEqual(2);
            expect((await authors().orderBy('id').get()).map((author: Author): string => author.name)).toEqual(['Carol', 'Dave']);
        });
    });

    test('matches a condition between two columns of the joined table', async (): Promise<void> => {
        const columns: [string, string] = ['posts.user_id', 'posts.id'];

        expect(await rows(paired('inner', columns))).toEqual(['Alice:First', 'Bob:First', 'Carol:First', 'Dave:First']);
        expect(await rows(paired('inner', columns))).toEqual(await rows(paired('inner', columns, 2)));
    });

    test.each([
        ['two integers', 'inner', ['users.id', 'posts.user_id']],
        ['two integers', 'inner', ['posts.user_id', 'users.id']],
        ['two integers', 'right', ['users.id', 'posts.user_id']],
        ['two integers', 'right', ['posts.user_id', 'users.id']],
        ['two dates', 'inner', ['users.joined', 'posts.day']],
        ['two dates', 'right', ['posts.day', 'users.joined']],
    ] as [string, Matching, [string, string]][])('tests a join on %s through a %s join on %j only against the rows holding its value', async (_: string, kind: Matching, columns: [string, string]): Promise<void> => {
        expect(await tested(paired(kind, columns))).toEqual(3);
        expect(await tested(paired(kind, columns, 2))).toEqual(16);
    });

    test('tests every pair when the columns hold values of different types', async (): Promise<void> => {
        expect(await tested(paired('inner', ['users.id', 'posts.author']))).toEqual(16);
    });

    test('matches a value a migration before 6.0.0 stored unconverted, though both columns are declared integers', async (): Promise<void> => {
        authored.disconnect();

        authored = new Connection('app', { database: `joins-authored-${databases}`, migrations: [CreateAuthoredTables, AddOwnerToUsersTable] });

        await authored.migrate();

        expect(await rows(paired('inner', ['users.owner', 'posts.user_id']))).toEqual(['Alice:Third', 'Bob:Third', 'Carol:Third', 'Dave:Third']);
    });
});

interface Counted {
    id: number;
    name: string;
    role: string;
}

interface Written {
    name: string | null;
    title: string | null;
}

class CreateCountedTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('role').index();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id');
            table.string('title');
        });

        await Schema.create('tags', (table: Blueprint): void => {
            table.id();
            table.string('word');
        });
    }
}

describe('Counting, paging and explaining a joined query', (): void => {
    let counted: Connection;

    /**
     * Join the users of the counted database to their posts through the given kind of join.
     */
    function through(kind: JoinKind): Builder<Written> {
        const query: Builder<Counted> = counted.table<Counted>('users');

        if (kind === 'cross') {
            return query.crossJoin<Written>('tags');
        }

        const method: 'join' | 'leftJoin' | 'rightJoin' = kind === 'inner' ? 'join' : `${kind}Join`;

        return query[method]<Written>('posts', 'users.id', '=', 'posts.user_id');
    }

    beforeAll(async (): Promise<void> => {
        counted = new Connection('app', { database: 'joins-counted', migrations: [CreateCountedTables] });

        await counted.migrate();

        await counted.table<Counted>('users').insert([
            { name: 'Alice', role: 'admin' },
            { name: 'Bob', role: 'admin' },
            { name: 'Carol', role: 'guest' },
        ]);

        await counted.table<Post>('posts').insert([
            { user_id: 1, title: 'First' },
            { user_id: 1, title: 'Second' },
            { user_id: 2, title: 'Third' },
            { user_id: 2, title: 'Fourth' },
            { user_id: 9, title: 'Stray' },
        ]);

        await counted.table<{ word: string }>('tags').insert([{ word: 'news' }, { word: 'tech' }]);
    });

    test.each([
        ['an inner', 'inner', 4],
        ['a left', 'left', 5],
        ['a right', 'right', 5],
        ['a cross', 'cross', 6],
    ] as [string, JoinKind, number][])('counts the rows %s join returns', async (_: string, kind: JoinKind, rows: number): Promise<void> => {
        expect((await through(kind).get()).length).toEqual(rows);
        expect(await through(kind).count()).toEqual(rows);
    });

    test.each([
        ['an indexed column of this table', (query: Builder<Written>): Builder<Written> => query.where('role', 'admin'), 4],
        ['a qualified column of this table', (query: Builder<Written>): Builder<Written> => query.where('users.role', 'admin'), 4],
        ['a column of the joined table', (query: Builder<Written>): Builder<Written> => query.where('posts.title', '!=', 'First'), 3],
    ] as [string, (query: Builder<Written>) => Builder<Written>, number][])('counts the joined rows a constraint on %s keeps', async (_: string, constrain: (query: Builder<Written>) => Builder<Written>, rows: number): Promise<void> => {
        expect((await constrain(through('inner')).get()).length).toEqual(rows);
        expect(await constrain(through('inner')).count()).toEqual(rows);
    });

    test.each([
        ['a limit', (query: Builder<Written>): Builder<Written> => query.limit(1)],
        ['an offset', (query: Builder<Written>): Builder<Written> => query.offset(3)],
        ['a limit and a constraint', (query: Builder<Written>): Builder<Written> => query.where('posts.title', '!=', 'Stray').limit(1)],
    ] as [string, (query: Builder<Written>) => Builder<Written>][])('counts every joined row whatever %s, as an unconstrained count does', async (_: string, page: (query: Builder<Written>) => Builder<Written>): Promise<void> => {
        expect(await page(through('inner')).count()).toEqual(4);
    });

    test('pages the joined rows and totals them', async (): Promise<void> => {
        const first: Paginated<Written> = await through('inner').orderBy('posts.title').paginate(1, 3);
        const second: Paginated<Written> = await through('inner').orderBy('posts.title').paginate(2, 3);

        expect([first.total, first.lastPage, second.total, second.lastPage]).toEqual([4, 2, 4, 2]);
        expect(first.data.map((row: Written): string => `${row.name}:${row.title}`)).toEqual(['Alice:First', 'Bob:Fourth', 'Alice:Second']);
        expect(second.data.map((row: Written): string => `${row.name}:${row.title}`)).toEqual(['Bob:Third']);
        expect([...first.data, ...second.data]).toEqual(await through('inner').orderBy('posts.title').get());
    });

    test.each([
        ['without a constraint', (query: Builder<Written>): Builder<Written> => query],
        ['with a constraint an index of this table could serve', (query: Builder<Written>): Builder<Written> => query.where('role', 'admin')],
    ] as [string, (query: Builder<Written>) => Builder<Written>][])('explains a joined query %s as the join it runs', async (_: string, constrain: (query: Builder<Written>) => Builder<Written>): Promise<void> => {
        const plans: string[] = [];
        const listener: (event: Event) => void = ((event: QueryExecuted): void => {
            plans.push(event.plan);
        }) as (event: Event) => void;

        Dispatcher.listen('db:query', listener);

        try {
            const explained: string = await constrain(through('inner')).explain();

            await constrain(through('inner')).get();
            await constrain(through('inner')).count();

            expect([explained, ...plans]).toEqual(['join', 'join', 'join']);
        } finally {
            Dispatcher.forget('db:query', listener);
        }
    });

    test('reports that no joined row exists when only the tables do', async (): Promise<void> => {
        expect(await through('inner').where('posts.title', 'Stray').exists()).toEqual(false);
        expect(await through('right').where('posts.title', 'Stray').exists()).toEqual(true);
    });
});

interface Reader {
    id: number;
    name: string;
    settings: { theme: string } | null;
}

interface Story {
    id: number;
    user_id: number;
    title: string;
    likes: number;
}

type Read = (query: Builder<Record<string, unknown>>) => Promise<unknown>;

class CreateReadTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.json('settings').nullable();
        });

        await Schema.create('posts', (table: Blueprint): void => {
            table.id();
            table.integer('user_id');
            table.string('title');
            table.integer('likes');
        });
    }
}

describe('Qualified columns on a joined query', (): void => {
    let read: Connection;

    /**
     * Join the users of the read database to their posts, ordered by user and then by post.
     */
    function posted(kind: 'inner' | 'left' = 'inner'): Builder<Record<string, unknown>> {
        const query: Builder<Reader> = read.table<Reader>('users');
        const joined: Builder<Record<string, unknown>> = kind === 'inner'
            ? query.join('posts', 'users.id', '=', 'posts.user_id')
            : query.leftJoin('posts', 'users.id', '=', 'posts.user_id');

        return joined.orderBy('users.id').orderBy('posts.id');
    }

    beforeAll(async (): Promise<void> => {
        read = new Connection('app', { database: 'joins-read', migrations: [CreateReadTables] });

        await read.migrate();

        await read.table<Reader>('users').insert([
            { name: 'Alice', settings: { theme: 'dark' } },
            { name: 'Bob', settings: { theme: 'light' } },
            { name: 'Carol', settings: null },
        ]);

        await read.table<Story>('posts').insert([
            { user_id: 1, title: 'First', likes: 3 },
            { user_id: 1, title: 'Second', likes: 5 },
            { user_id: 2, title: 'Hello', likes: 1 },
        ]);
    });

    test.each([
        ['pluck(\'users.name\')', (query: Builder<Record<string, unknown>>): Promise<unknown> => query.pluck('users.name'), ['Bob']],
        ['value(\'users.name\')', (query: Builder<Record<string, unknown>>): Promise<unknown> => query.value('users.name'), 'Bob'],
        ['pluck(\'posts.title\', \'users.name\')', (query: Builder<Record<string, unknown>>): Promise<unknown> => query.pluck('posts.title', 'users.name'), { Bob: 'Hello' }],
        ['select(\'users.id as user_id\').pluck(\'user_id\')', (query: Builder<Record<string, unknown>>): Promise<unknown> => query.select('users.id as user_id').pluck('user_id'), [2]],
    ] as [string, Read, unknown][])('%s reads the qualified column with Bob holding the only post', async (_: string, run: Read, expected: unknown): Promise<void> => {
        expect(await run(posted().where('posts.title', 'Hello'))).toEqual(expected);
    });

    test('plucks a qualified column from every joined row', async (): Promise<void> => {
        expect(await posted().pluck('users.name')).toEqual(['Alice', 'Alice', 'Bob']);
        expect(await posted().pluck('posts.title')).toEqual(['First', 'Second', 'Hello']);
    });

    test('keys a pluck by a qualified column, keeping the last value of a repeated key as an unjoined pluck does', async (): Promise<void> => {
        expect(await posted().pluck('posts.title', 'users.name')).toEqual({ Alice: 'Second', Bob: 'Hello' });
        expect(await read.table<Story>('posts').pluck('title', 'user_id')).toEqual({ 1: 'Second', 2: 'Hello' });
    });

    test('gets a qualified value from the first joined row', async (): Promise<void> => {
        expect(await posted().reorder('posts.likes', 'desc').value('posts.title')).toEqual('Second');
        expect(await posted().reorder('posts.likes', 'desc').value('users.name')).toEqual('Alice');
    });

    test('follows a JSON path from a qualified column', async (): Promise<void> => {
        expect(await posted().pluck('users.settings->theme')).toEqual(['dark', 'dark', 'light']);
        expect(await posted().pluck('posts.title', 'users.settings->theme')).toEqual({ dark: 'Second', light: 'Hello' });
        expect(await posted().reorder('posts.id', 'desc').value('users.settings->theme')).toEqual('light');
    });

    test('groups by a JSON path from a qualified column, named after its last step', async (): Promise<void> => {
        const rows: { theme: unknown; total: number }[] = await posted()
            .groupBy('users.settings->theme')
            .aggregate({ total: { count: '*' } })
            .get();

        expect(rows).toEqual([
            { theme: 'dark', total: 2 },
            { theme: 'light', total: 1 },
        ]);
    });

    test('reads an unqualified column off the flat row, where the later table wins a collision', async (): Promise<void> => {
        expect(await posted().pluck('id')).toEqual([1, 2, 3]);
        expect(await posted().pluck('title', 'name')).toEqual({ Alice: 'Second', Bob: 'Hello' });
        expect(await posted().value('settings->theme')).toEqual('dark');
    });

    test('rejects an ambiguous unqualified column read alongside a qualified one, as select does', async (): Promise<void> => {
        await expect(posted().pluck('posts.title', 'id')).rejects.toThrow(SchemaException);
        await expect(posted().select('id').get()).rejects.toThrow(SchemaException);
    });

    test('rejects a qualified column of a table the query does not join', async (): Promise<void> => {
        await expect(posted().pluck('teams.label')).rejects.toThrow(SchemaException);
        await expect(posted().value('teams.label')).rejects.toThrow(SchemaException);
    });

    test('gets null from a joined query that matches nothing', async (): Promise<void> => {
        expect(await posted().where('posts.title', 'Missing').value('users.name')).toBeNull();
        expect(await posted().where('posts.title', 'Missing').pluck('users.name')).toEqual([]);
    });

    test('reads null from the side a left join is missing', async (): Promise<void> => {
        expect(await posted('left').pluck('posts.title')).toEqual(['First', 'Second', 'Hello', null]);
        expect(await posted('left').where('users.name', 'Carol').value('posts.title')).toBeNull();
        expect(await posted('left').pluck('users.name', 'posts.title')).toEqual({ First: 'Alice', Second: 'Alice', Hello: 'Bob', null: 'Carol' });
    });

    test('groups by a qualified column, named after its last part', async (): Promise<void> => {
        const rows: { name: unknown; total: number }[] = await posted()
            .groupBy('users.name')
            .aggregate({ total: { count: '*' } })
            .get();

        expect(rows).toEqual([
            { name: 'Alice', total: 2 },
            { name: 'Bob', total: 1 },
        ]);
    });

    test('groups by two qualified columns that share a last part, letting the later one name the column as select does', async (): Promise<void> => {
        expect(await posted().groupBy('users.id', 'posts.id').get()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expect(await posted().groupBy('posts.id', 'users.id').get()).toEqual([{ id: 1 }, { id: 1 }, { id: 2 }]);
        expect(await posted().select('users.id', 'posts.id').get()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    test('aggregates a qualified column in each group', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await posted()
            .groupBy('users.name')
            .aggregate({
                likes  : { sum: 'posts.likes' },
                average: { avg: 'posts.likes' },
                least  : { min: 'posts.likes' },
                most   : { max: 'posts.likes' },
                liked  : { count: 'posts.likes' },
            })
            .get();

        expect(rows).toEqual([
            { name: 'Alice', likes: 8, average: 4, least: 3, most: 5, liked: 2 },
            { name: 'Bob', likes: 1, average: 1, least: 1, most: 1, liked: 1 },
        ]);
    });

    test('constrains the groups by a qualified grouped column', async (): Promise<void> => {
        const rows: Record<string, unknown>[] = await posted()
            .groupBy('users.name')
            .aggregate({ total: { count: '*' } })
            .having('users.name', 'Alice')
            .get();

        expect(rows).toEqual([{ name: 'Alice', total: 2 }]);
        expect(await posted().groupBy('users.name').having('name', 'Alice').orHaving('users.name', 'Bob').get()).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });

    test('groups by an unqualified column off the flat row', async (): Promise<void> => {
        expect(await posted().groupBy('name').aggregate({ likes: { sum: 'likes' } }).get()).toEqual([
            { name: 'Alice', likes: 8 },
            { name: 'Bob', likes: 1 },
        ]);
    });
});
