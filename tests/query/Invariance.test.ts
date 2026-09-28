import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import type { Builder } from '../../src/query/Builder';

interface Item {
    id: number;
    name: string;
    role: string | null;
    visits: number;
}

type Copy = 'indexed' | 'plain';

type Truth = boolean | null;

type Lookup = [string, 'id' | 'role', unknown[]];

type Write = [string, (query: Builder<Item>) => Promise<number>, (row: Item) => Item | null];

type Condition = [string, (query: Builder<Item>) => Builder<Item>, (row: Item) => Truth];

const ROWS: Item[] = [
    { id: 3, name: 'Carol', role: 'a', visits: 0 },
    { id: 1, name: 'Alice', role: 'a', visits: 2 },
    { id: 4, name: 'Dave', role: 'b', visits: 1 },
    { id: 2, name: 'Bob', role: null, visits: 5 },
    { id: 5, name: 'Erin', role: 'c', visits: 0 },
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
        });

        await Schema.create('plain', (table: Blueprint): void => {
            table.integer('id');
            table.string('name');
            table.string('role').nullable();
            table.integer('visits');
        });
    }
}

let connection: Connection;
let sequence: number = 0;

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
 * Apply the documented semantics of a range operator to one value, three-valued.
 */
function compare(held: unknown, operator: '<' | '>=', given: unknown): Truth {
    if (absent(held) || absent(given)) {
        return null;
    }

    return operator === '<'
        ? (comparable(held) as number) < (comparable(given) as number)
        : (comparable(held) as number) >= (comparable(given) as number);
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
