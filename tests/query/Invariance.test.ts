import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
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

type Copy = 'indexed' | 'plain';

type Truth = boolean | null;

type Lookup = [string, 'id' | 'role', unknown[]];

type Write = [string, (query: Builder<Item>) => Promise<number>, (row: Item) => Item | null];

type Condition = [string, (query: Builder<Item>) => Builder<Item>, (row: Item) => Truth];

type Typed = 'id' | 'role' | 'visits' | 'score' | 'active' | 'seen';

type Kind = 'integer' | 'float' | 'boolean' | 'datetime' | 'string';

type Sample = [Typed, unknown[], [unknown, unknown][]];

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
async function both<R>(run: (query: Builder<Item>) => Promise<R>): Promise<Record<Copy, R>> {
    return {
        indexed: await run(connection.table<Item>('indexed')),
        plain  : await run(connection.table<Item>('plain')),
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
