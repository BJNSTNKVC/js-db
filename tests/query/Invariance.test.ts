import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { UniqueConstraintViolationException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { Operator } from '../../src/query/types';

interface Item {
    id: number;
    name: string;
    role: string | null;
    visits: number;
    score: number | null;
    active: boolean | null;
    seen: Date | null;
}

interface Ranked extends Item {
    rank: number | null;
    tier?: number;
}

interface Coded extends Item {
    code: number;
}

interface Note {
    item_id: number;
    body: string;
}

type Copy = 'indexed' | 'plain';

type Truth = boolean | null;

type Lookup = [string, 'id' | 'role', unknown[]];

type Write = [string, (query: Builder<Item>) => Promise<number>, (row: Item) => Item | null];

type Condition = [string, (query: Builder<Item>) => Builder<Item>, (row: Item) => Truth];

type Typed = 'id' | 'role' | 'visits' | 'score' | 'active' | 'seen';

type Kind = 'integer' | 'float' | 'boolean' | 'datetime' | 'string';

type Sample = [Typed, unknown[], [unknown, unknown][]];

type Ranking = 'rank' | 'tier';

type Direction = 'asc' | 'desc';

type Page = [number, number | null];

type Ordering = [Ranking, Direction, Page];

type Reorder = [string, Ranking, Direction, Page, (query: Builder<Ranked>) => Promise<number>, (row: Ranked) => Ranked | null];

type Collision = [string, (query: Builder<Coded>) => Promise<number>];

const OPERATORS: Operator[] = ['=', '==', '===', '!=', '<>', '!==', '<', '>', '<=', '>='];

const KINDS: Record<Typed, Kind> = { id: 'integer', role: 'string', visits: 'integer', score: 'float', active: 'boolean', seen: 'datetime' };

const ROWS: Item[] = [
    { id: 3, name: 'Carol', role: 'a', visits: 0, score: 1.5, active: true, seen: day('2024-03-01') },
    { id: 1, name: 'Alice', role: 'a', visits: 2, score: null, active: false, seen: day('2024-01-15') },
    { id: 4, name: 'Dave', role: 'b', visits: 1, score: 0, active: true, seen: day('2023-12-31') },
    { id: 2, name: 'Bob', role: null, visits: 5, score: -3.25, active: null, seen: null },
    { id: 5, name: 'Erin', role: 'c', visits: 0, score: 2.5, active: false, seen: day('2024-01-15') },
];

const SAMPLES: Sample[] = [
    ['id', [1, '1', 3, '3', '9', 'x'], [[1, '3'], ['3', 1]]],
    ['visits', [2, '2', 0, '0', 3, '3', -1, 1.5, '1.5', ''], [['1', 2], ['5', '1']]],
    ['score', [1.5, '1.5', 0, '0', -1, '-3.25', 'x'], [['0', 2.5], [2.5, '0']]],
    ['active', [true, false, 1, 0, 'true', 'false', 'no'], [[false, 'true'], ['true', false]]],
    ['seen', [day('2024-01-15'), day('2024-01-15').getTime(), '2024-01-15', '2024-01-15T00:00:00.000Z', day('2024-01-01'), 'garbage'], [['2024-01-01', day('2024-03-01')], [day('2024-03-01'), '2024-01-01']]],
    ['role', ['a', 'A', 'b', 'c'], [['a', 'b'], ['c', 'a']]],
];

const CASES: Condition[] = SAMPLES.flatMap(([column, values, bounds]: Sample): Condition[] => [
    ...values.flatMap((value: unknown): Condition[] => OPERATORS.map((operator: Operator): Condition => [
        `where('${column}', '${operator}', ${shown(value)})`,
        (query: Builder<Item>): Builder<Item> => query.where(column, operator, value),
        (row: Item): Truth => compare(row[column], operator, strict(operator) ? value : prepared(value, KINDS[column])),
    ])),
    [
        `whereIn('${column}', [${values.map(shown).join(', ')}])`,
        (query: Builder<Item>): Builder<Item> => query.whereIn(column, values),
        (row: Item): Truth => within(row[column], values.map((value: unknown): unknown => prepared(value, KINDS[column]))),
    ],
    [
        `whereNotIn('${column}', [${values.map(shown).join(', ')}])`,
        (query: Builder<Item>): Builder<Item> => query.whereNotIn(column, values),
        (row: Item): Truth => not(within(row[column], values.map((value: unknown): unknown => prepared(value, KINDS[column])))),
    ],
    ...bounds.flatMap(([from, to]: [unknown, unknown]): Condition[] => [
        [
            `whereBetween('${column}', [${shown(from)}, ${shown(to)}])`,
            (query: Builder<Item>): Builder<Item> => query.whereBetween(column, [from, to]),
            (row: Item): Truth => between(row[column], prepared(from, KINDS[column]), prepared(to, KINDS[column])),
        ],
        [
            `whereNotBetween('${column}', [${shown(from)}, ${shown(to)}])`,
            (query: Builder<Item>): Builder<Item> => query.whereNotBetween(column, [from, to]),
            (row: Item): Truth => not(between(row[column], prepared(from, KINDS[column]), prepared(to, KINDS[column]))),
        ],
    ]),
]);

const EXTRAS: Condition[] = [
    ['whereIn(\'id\', [\'1\'])', (query: Builder<Item>): Builder<Item> => query.whereIn('id', ['1']), (row: Item): Truth => row.id === 1],
    ['whereIn(\'visits\', [\'0\', \'2\'])', (query: Builder<Item>): Builder<Item> => query.whereIn('visits', ['0', '2']), (row: Item): Truth => [0, 2].includes(row.visits)],
    ['whereDate(\'seen\', \'\')', (query: Builder<Item>): Builder<Item> => query.whereDate('seen', ''), (): Truth => false],
    ['whereDate(\'seen\', \'garbage\')', (query: Builder<Item>): Builder<Item> => query.whereDate('seen', 'garbage'), (): Truth => false],
];

const LOOKUPS: Lookup[] = [
    ['a repeated indexed value', 'role', ['a', 'a']],
    ['a repeated key', 'id', [1, 3, 1]],
];

const WRITES: Write[] = [
    ['increment', (query: Builder<Item>): Promise<number> => query.increment('visits'), (row: Item): Item => ({ ...row, visits: row.visits + 1 })],
    ['update', (query: Builder<Item>): Promise<number> => query.update({ visits: 7 }), (row: Item): Item => ({ ...row, visits: 7 })],
    ['delete', (query: Builder<Item>): Promise<number> => query.delete(), (): null => null],
];

const CONDITIONS: Condition[] = [
    ['below a bound', (query: Builder<Item>): Builder<Item> => query.where('visits', '<', 4), (row: Item): Truth => compare(row.visits, '<', 4)],
    ['from the lowest value up', (query: Builder<Item>): Builder<Item> => query.where('visits', '>=', 0), (row: Item): Truth => compare(row.visits, '>=', 0)],
    ['through point lookups', (query: Builder<Item>): Builder<Item> => query.whereIn('visits', [0, 2]), (row: Item): Truth => within(row.visits, [0, 2])],
];

const SHIFTS: Write[] = [
    ['an increment of that column', (query: Builder<Item>): Promise<number> => query.increment('visits', 2), (row: Item): Item => ({ ...row, visits: row.visits + 2 })],
    ['an update of that column', (query: Builder<Item>): Promise<number> => query.update({ visits: 1 }), (row: Item): Item => ({ ...row, visits: 1 })],
];

const RANKS: Record<number, number | null> = { 1: null, 2: 4, 3: 2, 4: 1, 5: 3 };

const TIERS: Record<number, number> = { 1: 10, 3: 20, 4: 40, 5: 30 };

const RANKED: Ranked[] = ROWS.map((row: Item): Ranked => ({ ...row, rank: RANKS[row.id] as number | null }));

const TIERED: Ranked[] = RANKED.map((row: Ranked): Ranked => row.id in TIERS ? { ...row, tier: TIERS[row.id] as number } : row);

const ORDERINGS: Ordering[] = [
    ['rank', 'asc', [0, null]],
    ['rank', 'desc', [0, null]],
    ['tier', 'asc', [0, null]],
    ['tier', 'desc', [0, null]],
    ['rank', 'asc', [0, 1]],
    ['rank', 'desc', [3, 2]],
    ['tier', 'asc', [0, 2]],
    ['tier', 'desc', [4, null]],
];

const REORDERS: Reorder[] = [
    ['delete', 'rank', 'asc', [0, 1], (query: Builder<Ranked>): Promise<number> => query.delete(), (): null => null],
    ['delete', 'tier', 'desc', [4, null], (query: Builder<Ranked>): Promise<number> => query.delete(), (): null => null],
    ['update of the ordering column', 'rank', 'asc', [0, 2], (query: Builder<Ranked>): Promise<number> => query.update({ rank: 9 }), (row: Ranked): Ranked => ({ ...row, rank: 9 })],
    ['increment', 'tier', 'asc', [0, 1], (query: Builder<Ranked>): Promise<number> => query.increment('visits'), (row: Ranked): Ranked => ({ ...row, visits: row.visits + 1 })],
];

const CODED: Coded[] = ROWS.map((row: Item): Coded => ({ ...row, code: row.id * 10 }));

const NOTES: Note[] = [
    { item_id: 3, body: 'first' },
    { item_id: 3, body: 'second' },
    { item_id: 1, body: 'third' },
    { item_id: 4, body: 'fourth' },
    { item_id: 9, body: 'stray' },
];

const JOINS: Condition[] = [
    ['with no constraint', (query: Builder<Item>): Builder<Item> => query, (): Truth => true],
    ['on an indexed column', (query: Builder<Item>): Builder<Item> => query.where('role', 'a'), (row: Item): Truth => compare(row.role, '=', 'a')],
    ['through a range on an indexed column', (query: Builder<Item>): Builder<Item> => query.where('visits', '>=', 1), (row: Item): Truth => compare(row.visits, '>=', 1)],
    ['through point lookups on the key path', (query: Builder<Item>): Builder<Item> => query.whereIn('id', [1, 3]), (row: Item): Truth => within(row.id, [1, 3])],
];

const COLLISIONS: Collision[] = [
    ['update', (query: Builder<Coded>): Promise<number> => query.orderBy('visits', 'desc').limit(1).update({ code: 10 })],
    ['increment', (query: Builder<Coded>): Promise<number> => query.orderBy('visits', 'desc').limit(1).increment('code', -10)],
];

class CreateItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('indexed', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('role').nullable().index();
            table.integer('visits').index();
            table.float('score').nullable().index();
            table.boolean('active').nullable().index();
            table.datetime('seen').nullable().index();
        });

        await Schema.create('plain', (table: Blueprint): void => {
            table.integer('id');
            table.string('name');
            table.string('role').nullable();
            table.integer('visits');
            table.float('score').nullable();
            table.boolean('active').nullable();
            table.datetime('seen').nullable();
        });
    }
}

class AddRankToItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('indexed', (table: Blueprint): void => {
            table.integer('rank').index();
        });

        await Schema.table('plain', (table: Blueprint): void => {
            table.integer('rank');
        });
    }
}

class AddTierToItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('indexed', (table: Blueprint): void => {
            table.integer('tier').index();
        });

        await Schema.table('plain', (table: Blueprint): void => {
            table.integer('tier');
        });
    }
}

class AddCodeToItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('indexed', (table: Blueprint): void => {
            table.integer('code').unique();
        });

        await Schema.table('plain', (table: Blueprint): void => {
            table.integer('code').unique();
        });
    }
}

class CreateNotesTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('notes', (table: Blueprint): void => {
            table.integer('item_id');
            table.string('body');
        });
    }
}

let connection: Connection;
let sequence: number = 0;

/**
 * Get the moment a UTC day begins.
 */
function day(text: string): Date {
    return new Date(`${text}T00:00:00Z`);
}

/**
 * Describe a value so that a test name tells it apart.
 */
function shown(value: unknown): string {
    return value instanceof Date ? `new Date('${value.toISOString()}')` : JSON.stringify(value);
}

/**
 * Determine whether an operator compares without converting.
 */
function strict(operator: Operator): boolean {
    return operator === '===' || operator === '!==';
}

/**
 * Determine whether a value is null or missing.
 */
function absent(value: unknown): boolean {
    return value === null || value === undefined;
}

/**
 * Get the form of a value that compares by content.
 */
function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
}

/**
 * Convert a value given for a column of the given kind, or leave it as given when it does not convert.
 */
function prepared(value: unknown, kind: Kind): unknown {
    if (kind === 'boolean') {
        return typeof value === 'string' && ['false', '0'].includes(value) ? false : Boolean(value);
    }

    if (kind === 'string') {
        return value;
    }

    if (kind === 'datetime') {
        const date: Date = new Date(value as string | number | Date);
        const readable: boolean = typeof value === 'string' || typeof value === 'number' || value instanceof Date;

        return readable && !Number.isNaN(date.getTime()) ? date : value;
    }

    const number: number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

    return Number.isFinite(number) && (kind === 'float' || Number.isInteger(number)) ? number : value;
}

/**
 * Apply the documented semantics of an operator to one value, three-valued.
 */
function compare(held: unknown, operator: Operator, given: unknown): Truth {
    if (absent(held) || absent(given)) {
        return null;
    }

    const a: unknown = comparable(held);
    const b: unknown = comparable(given);

    switch (operator) {
        case '=':
        case '==':
            return a == b;

        case '===':
            return a === b;

        case '!=':
        case '<>':
            return a != b;

        case '!==':
            return a !== b;

        case '<':
            return (a as number) < (b as number);

        case '>':
            return (a as number) > (b as number);

        case '<=':
            return (a as number) <= (b as number);

        default:
            return (a as number) >= (b as number);
    }
}

/**
 * Apply the documented semantics of whereBetween to one value, three-valued.
 */
function between(held: unknown, from: unknown, to: unknown): Truth {
    const lower: Truth = compare(held, '>=', from);
    const upper: Truth = compare(held, '<=', to);

    return lower === false || upper === false ? false : (lower === null || upper === null ? null : true);
}

/**
 * Negate a truth, leaving unknown unknown.
 */
function not(truth: Truth): Truth {
    return truth === null ? null : !truth;
}

/**
 * Apply the documented semantics of whereIn to one value, three-valued.
 */
function within(held: unknown, values: unknown[]): Truth {
    if (absent(held)) {
        return null;
    }

    const found: boolean = values.some((value: unknown): boolean => !absent(value) && comparable(held) == comparable(value));

    return found ? true : (values.some(absent) ? null : false);
}

/**
 * Apply the documented order to rows, which puts a null or missing value first ascending and last descending.
 */
function ordered(rows: Ranked[], column: Ranking, direction: Direction): Ranked[] {
    const sign: number = direction === 'desc' ? -1 : 1;

    return [...rows].sort((a: Ranked, b: Ranked): number => {
        const left: number | null | undefined = a[column];
        const right: number | null | undefined = b[column];

        if (absent(left) || absent(right)) {
            return sign * (Number(!absent(left)) - Number(!absent(right)));
        }

        return sign * ((left as number) - (right as number));
    });
}

/**
 * Apply an offset and a limit to rows.
 */
function paged<R>(rows: R[], [offset, limit]: Page): R[] {
    return rows.slice(offset, limit === null ? undefined : offset + limit);
}

/**
 * Order a query and apply an offset and a limit to it.
 */
function arranged<T extends Item>(query: Builder<T>, column: Ranking, direction: Direction, [offset, limit]: Page): Builder<T> {
    const sorted: Builder<T> = query.orderBy(column, direction).offset(offset);

    return limit === null ? sorted : sorted.limit(limit);
}

/**
 * Get the rows the reference model keeps for a whereIn.
 */
function kept(column: 'id' | 'role', values: unknown[]): Item[] {
    return ROWS.filter((row: Item): boolean => within(row[column], values) === true);
}

/**
 * Get the ids of the given rows in order.
 */
function ids(rows: Item[]): number[] {
    return rows.map((row: Item): number => row.id).sort((a: number, b: number): number => a - b);
}

/**
 * Put rows in id order, so answers compare as multisets.
 */
function sorted(rows: Item[]): Item[] {
    return [...rows].sort((a: Item, b: Item): number => a.id - b.id);
}

/**
 * Run one query against both copies of the table.
 */
async function both<R, T extends Item = Item>(run: (query: Builder<T>, copy: Copy) => Promise<R>): Promise<Record<Copy, R>> {
    return {
        indexed: await run(connection.table<T>('indexed'), 'indexed'),
        plain  : await run(connection.table<T>('plain'), 'plain'),
    };
}

/**
 * Read the rows a copy holds, past the package entirely.
 */
async function raw(copy: Copy): Promise<Item[]> {
    const database: IDBDatabase = await connection.open();

    return new Promise<Item[]>((resolve: (rows: Item[]) => void, reject: (reason: unknown) => void): void => {
        const request: IDBRequest<Item[]> = database.transaction(copy, 'readonly').objectStore(copy).getAll() as IDBRequest<Item[]>;

        request.onsuccess = (): void => resolve(sorted(request.result));
        request.onerror = (): void => reject(request.error);
    });
}

beforeEach(async (): Promise<void> => {
    connection = new Connection('app', { database: `invariance-${++sequence}`, migrations: [CreateItemsTables] });

    await connection.migrate();
    await connection.table<Item>('indexed').insert(ROWS);
    await connection.table<Item>('plain').insert(ROWS);
});

describe.each(LOOKUPS)('whereIn with %s', (_: string, column: 'id' | 'role', values: unknown[]): void => {
    const expected: Item[] = sorted(kept(column, values));

    test('gets each record once', async (): Promise<void> => {
        const answers: Record<Copy, Item[]> = await both(async (query: Builder<Item>): Promise<Item[]> => sorted(await query.whereIn(column, values).get()));

        expect(answers).toEqual({ indexed: expected, plain: expected });
    });

    test('counts each record once', async (): Promise<void> => {
        const answers: Record<Copy, number> = await both((query: Builder<Item>): Promise<number> => query.whereIn(column, values).count());

        expect(answers).toEqual({ indexed: expected.length, plain: expected.length });
    });

    test.each(WRITES)('writes each record once through %s', async (_: string, write: (query: Builder<Item>) => Promise<number>, change: (row: Item) => Item | null): Promise<void> => {
        const left: Item[] = ROWS
            .map((row: Item): Item | null => expected.includes(row) ? change(row) : row)
            .filter((row: Item | null): row is Item => row !== null);

        const affected: Record<Copy, number> = await both((query: Builder<Item>): Promise<number> => write(query.whereIn(column, values)));

        expect(affected).toEqual({ indexed: expected.length, plain: expected.length });
        expect({ indexed: await raw('indexed'), plain: await raw('plain') }).toEqual({ indexed: sorted(left), plain: sorted(left) });
    });
});

describe.each(CONDITIONS)('a write %s on the column whose index drives it', (_: string, constrain: (query: Builder<Item>) => Builder<Item>, holds: (row: Item) => Truth): void => {
    const expected: Item[] = ROWS.filter((row: Item): boolean => holds(row) === true);

    test.each(SHIFTS)('writes each record once through %s', async (_: string, write: (query: Builder<Item>) => Promise<number>, change: (row: Item) => Item | null): Promise<void> => {
        const left: Item[] = ROWS.map((row: Item): Item => expected.includes(row) ? change(row) as Item : row);

        const affected: Record<Copy, number> = await both((query: Builder<Item>): Promise<number> => write(constrain(query)));

        expect(affected).toEqual({ indexed: expected.length, plain: expected.length });
        expect({ indexed: await raw('indexed'), plain: await raw('plain') }).toEqual({ indexed: sorted(left), plain: sorted(left) });
    }, 2000);
});

describe.each([...CASES, ...EXTRAS])('%s', (_: string, constrain: (query: Builder<Item>) => Builder<Item>, holds: (row: Item) => Truth): void => {
    const expected: number[] = ids(ROWS.filter((row: Item): boolean => holds(row) === true));

    test('gives the same rows through an index, through a scan and from the model', async (): Promise<void> => {
        const answers: Record<Copy, { rows: number[]; count: number }> = await both(async (query: Builder<Item>): Promise<{ rows: number[]; count: number }> => ({
            rows : ids(await constrain(query.clone()).get()),
            count: await constrain(query).count(),
        }));

        expect(answers).toEqual({ indexed: { rows: expected, count: expected.length }, plain: { rows: expected, count: expected.length } });
    });
});

describe('ordering through an index that leaves records out', (): void => {
    beforeEach(async (): Promise<void> => {
        const database: string = `invariance-loose-${++sequence}`;
        const first: Connection = new Connection('app', { database, migrations: [CreateItemsTables, AddRankToItemsTables], strict: false });

        await first.migrate();
        await first.table<Ranked>('indexed').insert(RANKED);
        await first.table<Ranked>('plain').insert(RANKED);

        first.disconnect();

        connection = new Connection('app', { database, migrations: [CreateItemsTables, AddRankToItemsTables, AddTierToItemsTables], strict: false });

        await connection.migrate();

        for (const [id, tier] of Object.entries(TIERS)) {
            await both((query: Builder<Ranked>): Promise<number> => query.where('id', Number(id)).update({ tier }));
        }
    });

    test.each(ORDERINGS)('orderBy(%s, %s) paged by %j gives the same rows through an index, through a scan and from the model', async (column: Ranking, direction: Direction, page: Page): Promise<void> => {
        const expected: number[] = paged(ordered(TIERED, column, direction), page).map((row: Ranked): number => row.id);

        const answers: Record<Copy, { rows: number[]; count: number }> = await both(async (query: Builder<Item>): Promise<{ rows: number[]; count: number }> => ({
            rows : (await arranged(query.clone(), column, direction, page).get()).map((row: Item): number => row.id),
            count: await query.orderBy(column, direction).count(),
        }));

        expect(answers).toEqual({ indexed: { rows: expected, count: TIERED.length }, plain: { rows: expected, count: TIERED.length } });
    });

    test.each(REORDERS)('a limited %s ordered by %s %s and paged by %j writes the same rows through an index, through a scan and in the model', async (_: string, column: Ranking, direction: Direction, page: Page, write: (query: Builder<Ranked>) => Promise<number>, change: (row: Ranked) => Ranked | null): Promise<void> => {
        const chosen: Ranked[] = paged(ordered(TIERED, column, direction), page);
        const left: Ranked[] = TIERED
            .map((row: Ranked): Ranked | null => chosen.includes(row) ? change(row) : row)
            .filter((row: Ranked | null): row is Ranked => row !== null);

        const affected: Record<Copy, number> = await both((query: Builder<Ranked>): Promise<number> => write(arranged(query, column, direction, page)));

        expect(affected).toEqual({ indexed: chosen.length, plain: chosen.length });
        expect({ indexed: await raw('indexed'), plain: await raw('plain') }).toEqual({ indexed: sorted(left), plain: sorted(left) });
    });
});

describe('unique violations on a unique column both copies hold', (): void => {
    beforeEach(async (): Promise<void> => {
        connection = new Connection('app', { database: `invariance-coded-${++sequence}`, migrations: [CreateItemsTables, AddCodeToItemsTables] });

        await connection.migrate();
        await connection.table<Coded>('indexed').insert(CODED);
        await connection.table<Coded>('plain').insert(CODED);
    });

    test.each(COLLISIONS)('a limited %s that collides fails the same way through an index, through a scan and in the model', async (_: string, write: (query: Builder<Coded>) => Promise<number>): Promise<void> => {
        const failures: Record<Copy, unknown> = await both((query: Builder<Coded>): Promise<unknown> => write(query).then(
            (affected: number): unknown => affected,
            (error: unknown): unknown => error instanceof UniqueConstraintViolationException ? error.message : error,
        ));

        expect(failures).toEqual({
            indexed: new UniqueConstraintViolationException('indexed', 'indexed_code_unique').message,
            plain  : new UniqueConstraintViolationException('plain', 'plain_code_unique').message,
        });

        expect({ indexed: await raw('indexed'), plain: await raw('plain') }).toEqual({ indexed: sorted(CODED), plain: sorted(CODED) });
    });
});

describe('counting through a join', (): void => {
    beforeEach(async (): Promise<void> => {
        connection = new Connection('app', { database: `invariance-joined-${++sequence}`, migrations: [CreateItemsTables, CreateNotesTable] });

        await connection.migrate();
        await connection.table<Item>('indexed').insert(ROWS);
        await connection.table<Item>('plain').insert(ROWS);
        await connection.table<Note>('notes').insert(NOTES);
    });

    test.each(JOINS)('a join %s gives the same rows and count through an index, through a scan and in the model', async (_: string, constrain: (query: Builder<Item>) => Builder<Item>, holds: (row: Item) => Truth): Promise<void> => {
        const expected: number = NOTES.filter((note: Note): boolean => ROWS.some((row: Item): boolean => row.id === note.item_id && holds(row) === true)).length;

        const answers: Record<Copy, { rows: number; count: number }> = await both(async (query: Builder<Item>, copy: Copy): Promise<{ rows: number; count: number }> => {
            const joined: Builder<Item> = constrain(query.join<Item>('notes', `${copy}.id`, '=', 'notes.item_id'));

            return { rows: (await joined.clone().get()).length, count: await joined.count() };
        });

        expect(answers).toEqual({ indexed: { rows: expected, count: expected }, plain: { rows: expected, count: expected } });
    });
});
