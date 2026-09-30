import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Dispatcher } from '../../src/events/Dispatcher';
import { SchemaException } from '../../src/exceptions';
import { Predicate } from '../../src/query/Predicate';
import type { Builder } from '../../src/query/Builder';
import type { Transaction } from '../../src/database/Transaction';
import type { Join } from '../../src/query/Join';
import type { QueryExecuted } from '../../src/events';
import type { Constraint } from '../../src/query/types';

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
            table.integer('owner').default('2');
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

    test('matches a value a migration stored unconverted, though both columns are declared integers', async (): Promise<void> => {
        authored.disconnect();

        authored = new Connection('app', { database: `joins-authored-${databases}`, migrations: [CreateAuthoredTables, AddOwnerToUsersTable] });

        await authored.migrate();

        expect(await rows(paired('inner', ['users.owner', 'posts.user_id']))).toEqual(['Alice:Third', 'Bob:Third', 'Carol:Third', 'Dave:Third']);
    });
});
