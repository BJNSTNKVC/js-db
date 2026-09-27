import { beforeAll, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { SchemaException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { Operator } from '../../src/query/types';

interface Profile {
    id: number;
    name: string;
    settings: Record<string, unknown> | string | null;
    tags: unknown[] | string | null;
    team_id: number | null;
}

interface Team {
    id: number;
    label: string;
    meta: Record<string, unknown>;
}

interface Score {
    id: number;
    player: string;
    stats: Record<string, unknown>;
}

class CreateTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('profiles', (table: Blueprint): void => {
            table.id();
            table.string('name').index();
            table.json('settings').nullable();
            table.json('tags').nullable();
            table.integer('team_id').nullable();
        });

        await Schema.create('teams', (table: Blueprint): void => {
            table.id();
            table.string('label');
            table.json('meta');
        });

        await Schema.create('scores', (table: Blueprint): void => {
            table.id();
            table.string('player');
            table.json('stats');
        });
    }
}

let connection: Connection;

/**
 * Begin a query against the seeded profiles table.
 */
function profiles(): Builder<Profile> {
    return connection.table<Profile>('profiles');
}

/**
 * Get the names of the records a query returns.
 */
async function names<R extends { name: string }>(query: Builder<R>): Promise<string[]> {
    return (await query.get()).map((record: R): string => record.name);
}

beforeAll(async (): Promise<void> => {
    connection = new Connection('app', { database: 'builder-json', migrations: [CreateTables] });

    await connection.migrate();

    await profiles().insert([
        { name: 'Alice', settings: { theme: 'dark', rank: 2, notifications: { email: true }, roles: ['admin'] }, tags: ['php', 'js'], team_id: 1 },
        { name: 'Bob', settings: { theme: 'light', rank: 1, notifications: { email: false } }, tags: ['js'], team_id: 2 },
        { name: 'Carol', settings: { theme: 'dark' }, tags: [], team_id: 1 },
        { name: 'Dave', settings: null, tags: null, team_id: null },
        { name: 'Erin', settings: '{ "theme": "light", "rank": 3 }', tags: '["go"]', team_id: 2 },
    ]);

    await connection.table<Team>('teams').insert([
        { label: 'core', meta: { tier: 'gold', owner: 1 } },
        { label: 'guest', meta: { tier: 'free' } },
    ]);
});

describe('Builder JSON paths', (): void => {
    test('reads one level into a column', async (): Promise<void> => {
        expect(await names(profiles().where('settings->theme', 'dark'))).toEqual(['Alice', 'Carol']);
    });

    test('reads several levels into a column', async (): Promise<void> => {
        expect(await names(profiles().where('settings->notifications->email', true))).toEqual(['Alice']);
        expect(await names(profiles().where('settings->notifications->email', false))).toEqual(['Bob']);
    });

    test('reads a column that arrived as a JSON string, since it was parsed on the way in', async (): Promise<void> => {
        expect(await names(profiles().where('settings->rank', '>=', 3))).toEqual(['Erin']);
    });

    test('treats a missing path as null', async (): Promise<void> => {
        expect(await names(profiles().whereNull('settings->rank'))).toEqual(['Carol', 'Dave']);
        expect(await names(profiles().whereNotNull('settings->rank'))).toEqual(['Alice', 'Bob', 'Erin']);
        expect(await names(profiles().where('settings->rank', null))).toEqual(['Carol', 'Dave']);
    });

    test('leaves a missing path out of a comparison and its negation alike', async (): Promise<void> => {
        expect(await names(profiles().where('settings->rank', '!=', 2))).toEqual(['Bob', 'Erin']);
        expect(await names(profiles().whereNot('settings->rank', 2))).toEqual(['Bob', 'Erin']);
    });

    test('combines with other constraints', async (): Promise<void> => {
        expect(await names(profiles().where('settings->theme', 'light').orWhere('settings->rank', 2))).toEqual(['Alice', 'Bob', 'Erin']);
        expect(await names(profiles().whereIn('settings->rank', [1, 3]).whereLike('name', 'b%'))).toEqual(['Bob']);
        expect(await names(profiles().whereBetween('settings->rank', [1, 2]))).toEqual(['Alice', 'Bob']);
        expect(await names(profiles().whereAny(['settings->theme', 'name'], 'Carol'))).toEqual(['Carol']);
    });

    test('compares a path against another column', async (): Promise<void> => {
        expect(await names(profiles().whereColumn('settings->rank', '<', 'team_id'))).toEqual(['Bob']);
    });

    test.each(['__proto__', 'constructor'])('never resolves %s to anything', async (segment: string): Promise<void> => {
        expect(await names(profiles().whereNotNull(`settings->${segment}`))).toEqual([]);
        expect(await names(profiles().where(`settings->${segment}->name`, 'Object'))).toEqual([]);
    });

    test('never drives the scan, even over an indexed column', async (): Promise<void> => {
        expect(await profiles().where('name->first', 'Alice').explain()).toEqual('scan');
        expect(await profiles().where('settings->theme', 'dark').where('name', 'Alice').explain()).toEqual('index:profiles_name_index');
    });

    test('counts and updates the records a path matches', async (): Promise<void> => {
        expect(await profiles().where('settings->theme', 'dark').count()).toEqual(2);
        expect(await profiles().where('settings->theme', 'none').update({ name: 'Nobody' })).toEqual(0);
    });
});

describe('Builder ordering by a JSON path', (): void => {
    test('sorts by the value the path reads, placing a missing value first', async (): Promise<void> => {
        expect(await names(profiles().orderBy('settings->rank'))).toEqual(['Carol', 'Dave', 'Bob', 'Alice', 'Erin']);
    });

    test('sorts descending, placing a missing value last', async (): Promise<void> => {
        expect(await names(profiles().orderBy('settings->rank', 'desc'))).toEqual(['Erin', 'Alice', 'Bob', 'Carol', 'Dave']);
    });

    test('sorts by a path before paging', async (): Promise<void> => {
        expect(await names(profiles().orderBy('settings->rank', 'desc').limit(2))).toEqual(['Erin', 'Alice']);
        expect(await names(profiles().orderBy('settings->theme').orderBy('name', 'desc').offset(1).limit(2))).toEqual(['Carol', 'Alice']);
    });

    test('never orders by an index, even over an indexed column', async (): Promise<void> => {
        expect(await profiles().orderBy('name->first').explain()).toEqual('scan');
    });

    test('writes to the records the ordered path selects', async (): Promise<void> => {
        const scores: () => Builder<Score> = (): Builder<Score> => connection.table<Score>('scores');

        await scores().insert([
            { player: 'Bob', stats: { points: 20 } },
            { player: 'Carol', stats: { points: 30 } },
            { player: 'Alice', stats: { points: 10 } },
        ]);

        expect(await scores().orderBy('stats->points').limit(1).delete()).toEqual(1);
        expect((await scores().get()).map((score: Score): string => score.player)).toEqual(['Bob', 'Carol']);

        expect(await scores().orderBy('stats->points', 'desc').limit(1).update({ player: 'Winner' })).toEqual(1);
        expect((await scores().get()).map((score: Score): string => score.player)).toEqual(['Bob', 'Winner']);
    });
});

describe('Builder selecting a JSON path', (): void => {
    test('names an unaliased path after its last step', async (): Promise<void> => {
        expect(await profiles().select('name', 'settings->theme').whereNotNull('settings').get()).toEqual([
            { name: 'Alice', theme: 'dark' },
            { name: 'Bob', theme: 'light' },
            { name: 'Carol', theme: 'dark' },
            { name: 'Erin', theme: 'light' },
        ]);
    });

    test('reads several levels under an alias', async (): Promise<void> => {
        expect(await profiles().select('name', 'settings->notifications->email as email').whereNotNull('settings->notifications').get()).toEqual([
            { name: 'Alice', email: true },
            { name: 'Bob', email: false },
        ]);
    });

    test('keeps the key of a missing path, holding undefined', async (): Promise<void> => {
        const selected: Profile[] = await profiles().select('name', 'settings->rank').where('name', 'Carol').get();

        expect(selected).toEqual([{ name: 'Carol', rank: undefined }]);
        expect(Object.keys(selected[0] as Profile)).toEqual(['name', 'rank']);
    });

    test('removes duplicates by the value the path reads', async (): Promise<void> => {
        expect(await profiles().select('settings->theme').whereNotNull('settings').distinct().get()).toEqual([{ theme: 'dark' }, { theme: 'light' }]);
    });

    test.each(['__proto__', 'constructor'])('never selects %s from the prototype', async (segment: string): Promise<void> => {
        expect(await profiles().select(`settings->${segment} as found`).where('name', 'Alice').get()).toEqual([{ found: undefined }]);
    });

    test('plucks a path', async (): Promise<void> => {
        expect(await profiles().pluck('settings->theme')).toEqual(['dark', 'light', 'dark', undefined, 'light']);
    });

    test('plucks keyed by a path, or plucks a path keyed by a column', async (): Promise<void> => {
        expect(await profiles().whereNotNull('settings->rank').pluck('name', 'settings->rank')).toEqual({ 1: 'Bob', 2: 'Alice', 3: 'Erin' });
        expect(await profiles().whereNotNull('settings->rank').pluck('settings->rank', 'name')).toEqual({ Alice: 2, Bob: 1, Erin: 3 });
    });

    test('gets the value of a path from the first record', async (): Promise<void> => {
        expect(await profiles().where('name', 'Bob').value('settings->notifications->email')).toEqual(false);
        expect(await profiles().where('name', 'Carol').value('settings->rank')).toBeNull();
    });

    test('selects a path in a joined query, qualified or not', async (): Promise<void> => {
        const joined: Builder<Profile & Team> = profiles().join<Profile & Team>('teams', 'profiles.team_id', '=', 'teams.id');

        expect(await joined.clone().select('name', 'teams.meta->tier').get()).toEqual([
            { name: 'Alice', tier: 'gold' },
            { name: 'Bob', tier: 'free' },
            { name: 'Carol', tier: 'gold' },
            { name: 'Erin', tier: 'free' },
        ]);
        expect(await joined.clone().select('meta->owner as owner').where('name', 'Alice').get()).toEqual([{ owner: 1 }]);
        expect(await joined.clone().pluck('meta->tier')).toEqual(['gold', 'free', 'gold', 'free']);
    });
});

describe('Builder.whereJsonContains and whereJsonDoesntContain', (): void => {
    test('matches an array holding a scalar', async (): Promise<void> => {
        expect(await names(profiles().whereJsonContains('tags', 'php'))).toEqual(['Alice']);
        expect(await names(profiles().whereJsonContains('tags', 'js'))).toEqual(['Alice', 'Bob']);
        expect(await names(profiles().whereJsonContains('tags', 'go'))).toEqual(['Erin']);
    });

    test('matches an array holding every one of an array of values', async (): Promise<void> => {
        expect(await names(profiles().whereJsonContains('tags', ['php', 'js']))).toEqual(['Alice']);
        expect(await names(profiles().whereJsonContains('tags', ['js', 'go']))).toEqual([]);
    });

    test('reads the array through a path', async (): Promise<void> => {
        expect(await names(profiles().whereJsonContains('settings->roles', 'admin'))).toEqual(['Alice']);
    });

    test('negates, leaving out a null column', async (): Promise<void> => {
        expect(await names(profiles().whereJsonDoesntContain('tags', 'php'))).toEqual(['Bob', 'Carol', 'Erin']);
        expect(await names(profiles().whereJsonDoesntContain('tags', ['php', 'go']))).toEqual(['Alice', 'Bob', 'Carol', 'Erin']);
    });

    test('matches nothing against a target that is not an array, whether negated or not', async (): Promise<void> => {
        expect(await names(profiles().whereJsonContains('settings->theme', 'dark'))).toEqual([]);
        expect(await names(profiles().whereJsonDoesntContain('settings->theme', 'dark'))).toEqual([]);
        expect(await names(profiles().whereJsonContains('settings', 'dark'))).toEqual([]);
    });

    test('has or forms', async (): Promise<void> => {
        expect(await names(profiles().where('name', 'Dave').orWhereJsonContains('tags', 'go'))).toEqual(['Dave', 'Erin']);
        expect(await names(profiles().where('name', 'Dave').orWhereJsonDoesntContain('tags', 'js'))).toEqual(['Carol', 'Dave', 'Erin']);
    });
});

describe('Builder.whereJsonLength', (): void => {
    test('compares with an implicit equals', async (): Promise<void> => {
        expect(await names(profiles().whereJsonLength('tags', 0))).toEqual(['Carol']);
        expect(await names(profiles().whereJsonLength('tags', 1))).toEqual(['Bob', 'Erin']);
    });

    test.each([
        ['=', 2, ['Alice']],
        ['!=', 1, ['Alice', 'Carol']],
        ['<>', 0, ['Alice', 'Bob', 'Erin']],
        ['<', 1, ['Carol']],
        ['<=', 1, ['Bob', 'Carol', 'Erin']],
        ['>', 1, ['Alice']],
        ['>=', 1, ['Alice', 'Bob', 'Erin']],
    ] as [Operator, number, string[]][])('compares with %s %s', async (operator: Operator, value: number, expected: string[]): Promise<void> => {
        expect(await names(profiles().whereJsonLength('tags', operator, value))).toEqual(expected);
    });

    test('reads the array through a path', async (): Promise<void> => {
        expect(await names(profiles().whereJsonLength('settings->roles', 1))).toEqual(['Alice']);
    });

    test('matches nothing against a target that is not an array', async (): Promise<void> => {
        expect(await names(profiles().whereJsonLength('settings', '>=', 0))).toEqual([]);
    });

    test('has an or form', async (): Promise<void> => {
        expect(await names(profiles().where('name', 'Dave').orWhereJsonLength('tags', '>', 1))).toEqual(['Alice', 'Dave']);
        expect(await names(profiles().where('name', 'Dave').orWhereJsonLength('tags', 0))).toEqual(['Carol', 'Dave']);
    });
});

describe('Builder JSON paths in a joined query', (): void => {
    /**
     * Begin a query joining every profile to its team.
     */
    function joined(): Builder<Profile & Team> {
        return profiles().join<Profile & Team>('teams', 'profiles.team_id', '=', 'teams.id');
    }

    test('reads a path qualified by its table', async (): Promise<void> => {
        expect(await names(joined().where('teams.meta->tier', 'gold'))).toEqual(['Alice', 'Carol']);
        expect(await names(joined().where('profiles.settings->theme', 'light'))).toEqual(['Bob', 'Erin']);
    });

    test('qualifies a path whose column only one table has', async (): Promise<void> => {
        expect(await names(joined().where('meta->tier', 'free'))).toEqual(['Bob', 'Erin']);
        expect(await names(joined().whereJsonContains('tags', 'js'))).toEqual(['Alice', 'Bob']);
    });

    test('sorts by a qualified path', async (): Promise<void> => {
        expect(await names(joined().orderBy('teams.meta->tier').orderBy('settings->rank', 'desc'))).toEqual(['Erin', 'Bob', 'Alice', 'Carol']);
    });

    test('joins on a path', async (): Promise<void> => {
        expect(await names(profiles().join<Profile & Team>('teams', 'profiles.id', '=', 'teams.meta->owner'))).toEqual(['Alice']);
        expect(await names(profiles().join<Profile & Team>('teams', 'profiles.id', '<', 'teams.meta->owner'))).toEqual([]);
        expect(await names(profiles().join<Profile & Team>('teams', 'teams.meta->owner', '<', 'profiles.id'))).toEqual(['Bob', 'Carol', 'Dave', 'Erin']);
    });

    test('rejects a path into a column no joined table has', async (): Promise<void> => {
        await expect(joined().where('missing->tier', 'gold').get()).rejects.toThrow(SchemaException);
        await expect(joined().where('others.meta->tier', 'gold').get()).rejects.toThrow('names table [others]');
    });
});
