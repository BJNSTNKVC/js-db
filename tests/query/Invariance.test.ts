import { beforeEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Request } from '../../src/database/Request';
import { UniqueConstraintViolationException } from '../../src/exceptions';
import type { Builder } from '../../src/query/Builder';
import type { DateOperator, DatePart, Operator, Paginated } from '../../src/query/types';

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

interface Weighed extends Item {
    weight: number;
}

interface Tagged extends Item {
    tags?: unknown;
}

interface Totals {
    count: number;
    sum: number;
    avg: number | null;
    min: number | null;
    max: number | null;
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

type Weight = 'visits' | 'weight';

type Shaping = <T extends Item>(query: Builder<T>) => Builder<T>;

type Shape = [string, Shaping];

type Scope = [string, (query: Builder<Weighed>) => Builder<Weighed>, (row: Weighed) => boolean];

type Listing = [string, (query: Builder<Tagged>) => Builder<Tagged>, (row: Tagged) => Truth];

type Retag = [string, (query: Builder<Tagged>) => Promise<number>, (row: Tagged) => Tagged | null];

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

const DATE_OPERATORS: DateOperator[] = ['=', '!=', '<>', '<', '>', '<=', '>='];

const PARTED: [DatePart, (number | string)[]][] = [
    ['year', [2024, '2024', 2023, '0002023', 2024.5, -1]],
    ['month', [1, '01', 3, '3', 12]],
    ['day', [15, '15', 1, '0001', 31]],
];

const PARTS: Condition[] = [
    ...PARTED.flatMap(([which, values]: [DatePart, (number | string)[]]): Condition[] => values.flatMap((value: number | string): Condition[] => DATE_OPERATORS.map((operator: DateOperator): Condition => {
        const method: 'whereYear' | 'whereMonth' | 'whereDay' = which === 'year' ? 'whereYear' : (which === 'month' ? 'whereMonth' : 'whereDay');

        return [
            `${method}('seen', '${operator}', ${shown(value)})`,
            (query: Builder<Item>): Builder<Item> => query[method]('seen', operator, value),
            (row: Item): Truth => parted(row.seen, which, operator, Number(value)),
        ];
    }))),
    ...([day('2024-01-15'), '2024-01-15', '2024-03-01', '2023-12-31', '', 'garbage'] as (Date | string)[]).flatMap((value: Date | string): Condition[] => DATE_OPERATORS.map((operator: DateOperator): Condition => [
        `whereDate('seen', '${operator}', ${shown(value)})`,
        (query: Builder<Item>): Builder<Item> => query.whereDate('seen', operator, value),
        (row: Item): Truth => dated(row.seen, operator, value),
    ])),
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

const WEIGHTS: number[] = [5, 7, 1, 9];

const WEIGHED: Weighed[] = sorted(ROWS).slice(0, WEIGHTS.length).map((row: Item, index: number): Weighed => ({
    ...row,
    visits: WEIGHTS[index] as number,
    weight: WEIGHTS[index] as number,
}));

const SHAPES: Shape[] = [
    ['limit(2)', <T extends Item>(query: Builder<T>): Builder<T> => query.limit(2)],
    ['limit(1)', <T extends Item>(query: Builder<T>): Builder<T> => query.limit(1)],
    ['offset(1)', <T extends Item>(query: Builder<T>): Builder<T> => query.offset(1)],
    ['offset(9)', <T extends Item>(query: Builder<T>): Builder<T> => query.offset(9)],
    ['offset(1).limit(2)', <T extends Item>(query: Builder<T>): Builder<T> => query.offset(1).limit(2)],
    ['orderBy(\'visits\', \'desc\').limit(2)', <T extends Item>(query: Builder<T>): Builder<T> => query.orderBy('visits', 'desc').limit(2)],
    ['inRandomOrder().limit(2)', <T extends Item>(query: Builder<T>): Builder<T> => query.inRandomOrder().limit(2)],
];

const SCOPES: Scope[] = [
    ['every row', (query: Builder<Weighed>): Builder<Weighed> => query, (): boolean => true],
    ['the rows an index serves on the indexed copy', (query: Builder<Weighed>): Builder<Weighed> => query.where('visits', '>', 1), (row: Weighed): boolean => row.visits > 1],
    ['the rows a residual keeps on both copies', (query: Builder<Weighed>): Builder<Weighed> => query.where('weight', '>', 1), (row: Weighed): boolean => row.weight > 1],
    ['no row', (query: Builder<Weighed>): Builder<Weighed> => query.where('visits', '>', 100), (): boolean => false],
];

const AGGREGATIONS: [Weight, string, Shaping][] = (['visits', 'weight'] as Weight[]).flatMap((column: Weight): [Weight, string, Shaping][] => {
    return SHAPES.map(([name, shape]: Shape): [Weight, string, Shaping] => [column, name, shape]);
});

const COLLISIONS: Collision[] = [
    ['update', (query: Builder<Coded>): Promise<number> => query.orderBy('visits', 'desc').limit(1).update({ code: 10 })],
    ['increment', (query: Builder<Coded>): Promise<number> => query.orderBy('visits', 'desc').limit(1).increment('code', -10)],
];

const TAGS: Record<number, unknown> = { 1: [], 2: ['z', 'x', 'z'], 3: [day('2024-01-15'), NaN, { a: 1 }, 'y'], 5: 'x' };

const TAGGED: Tagged[] = ROWS.map((row: Item): Tagged => row.id in TAGS ? { ...row, tags: TAGS[row.id] } : row);

const LISTINGS: Listing[] = [
    ['where(\'tags\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('tags', 'x'), (row: Tagged): Truth => compare(row.tags, '=', 'x')],
    ['where(\'tags\', \'==\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('tags', '==', 'x'), (row: Tagged): Truth => compare(row.tags, '==', 'x')],
    ['where(\'tags\', \'===\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('tags', '===', 'x'), (row: Tagged): Truth => compare(row.tags, '===', 'x')],
    ['where(\'tags\', \'z,x,z\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('tags', 'z,x,z'), (row: Tagged): Truth => compare(row.tags, '=', 'z,x,z')],
    ['where(\'tags\', \'>=\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('tags', '>=', 'x'), (row: Tagged): Truth => compare(row.tags, '>=', 'x')],
    ['whereBetween(\'tags\', [\'x\', \'y\'])', (query: Builder<Tagged>): Builder<Tagged> => query.whereBetween('tags', ['x', 'y']), (row: Tagged): Truth => between(row.tags, 'x', 'y')],
    ['whereIn(\'tags\', [\'x\', \'z\'])', (query: Builder<Tagged>): Builder<Tagged> => query.whereIn('tags', ['x', 'z']), (row: Tagged): Truth => within(row.tags, ['x', 'z'])],
    ['whereIn(\'tags\', [\'x\', \'x\'])', (query: Builder<Tagged>): Builder<Tagged> => query.whereIn('tags', ['x', 'x']), (row: Tagged): Truth => within(row.tags, ['x', 'x'])],
    ['whereJsonContains(\'tags\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', 'x'), (row: Tagged): Truth => contains(row.tags, 'x')],
    ['whereJsonContains(\'tags\', \'z\')', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', 'z'), (row: Tagged): Truth => contains(row.tags, 'z')],
    ['whereJsonContains(\'tags\', \'w\')', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', 'w'), (row: Tagged): Truth => contains(row.tags, 'w')],
    ['whereJsonContains(\'tags\', [\'x\', \'z\'])', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', ['x', 'z']), (row: Tagged): Truth => contains(row.tags, ['x', 'z'])],
    ['whereJsonContains(\'tags\', [\'y\', \'x\'])', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', ['y', 'x']), (row: Tagged): Truth => contains(row.tags, ['y', 'x'])],
    ['whereJsonContains(\'tags\', new Date(\'2024-01-15\'))', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', day('2024-01-15')), (row: Tagged): Truth => contains(row.tags, day('2024-01-15'))],
    ['whereJsonContains(\'tags\', NaN)', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', NaN), (row: Tagged): Truth => contains(row.tags, NaN)],
    ['whereJsonContains(\'tags\', { a: 1 })', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonContains('tags', { a: 1 }), (row: Tagged): Truth => contains(row.tags, { a: 1 })],
    ['whereJsonDoesntContain(\'tags\', \'x\')', (query: Builder<Tagged>): Builder<Tagged> => query.whereJsonDoesntContain('tags', 'x'), (row: Tagged): Truth => not(contains(row.tags, 'x'))],
    ['where(\'id\', 4).orWhereJsonContains(\'tags\', \'y\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('id', 4).orWhereJsonContains('tags', 'y'), (row: Tagged): Truth => row.id === 4 || contains(row.tags, 'y')],
    ['where(\'role\', \'a\').whereJsonContains(\'tags\', \'y\')', (query: Builder<Tagged>): Builder<Tagged> => query.where('role', 'a').whereJsonContains('tags', 'y'), (row: Tagged): Truth => row.role === 'a' && contains(row.tags, 'y')],
];

const RETAGS: Retag[] = [
    ['an increment through whereJsonContains(\'tags\', \'x\')', (query: Builder<Tagged>): Promise<number> => query.whereJsonContains('tags', 'x').increment('visits'), (row: Tagged): Tagged | null => contains(row.tags, 'x') === true ? { ...row, visits: row.visits + 1 } : row],
    ['an increment through whereJsonContains(\'tags\', \'z\')', (query: Builder<Tagged>): Promise<number> => query.whereJsonContains('tags', 'z').increment('visits'), (row: Tagged): Tagged | null => contains(row.tags, 'z') === true ? { ...row, visits: row.visits + 1 } : row],
    ['an update of the tags through whereJsonContains(\'tags\', \'x\')', (query: Builder<Tagged>): Promise<number> => query.whereJsonContains('tags', 'x').update({ tags: ['x', 'w'] }), (row: Tagged): Tagged | null => contains(row.tags, 'x') === true ? { ...row, tags: ['x', 'w'] } : row],
    ['a delete through whereJsonContains(\'tags\', \'x\')', (query: Builder<Tagged>): Promise<number> => query.whereJsonContains('tags', 'x').delete(), (row: Tagged): Tagged | null => contains(row.tags, 'x') === true ? null : row],
    ['an increment through where(\'tags\', \'>=\', \'x\')', (query: Builder<Tagged>): Promise<number> => query.where('tags', '>=', 'x').increment('visits'), (row: Tagged): Tagged | null => compare(row.tags, '>=', 'x') === true ? { ...row, visits: row.visits + 1 } : row],
    ['an update of the tags through whereIn(\'tags\', [\'x\', \'z\'])', (query: Builder<Tagged>): Promise<number> => query.whereIn('tags', ['x', 'z']).update({ tags: ['z'] }), (row: Tagged): Tagged | null => within(row.tags, ['x', 'z']) === true ? { ...row, tags: ['z'] } : row],
    ['a delete through orderBy(\'tags\').limit(2)', (query: Builder<Tagged>): Promise<number> => query.orderBy('tags').limit(2).delete(), (row: Tagged): Tagged | null => listed(TAGGED, 'asc').slice(0, 2).includes(row) ? null : row],
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

class AddWeightToItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('indexed', (table: Blueprint): void => {
            table.integer('weight');
        });

        await Schema.table('plain', (table: Blueprint): void => {
            table.integer('weight');
        });
    }
}

class AddTagsToItemsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('indexed', (table: Blueprint): void => {
            table.json('tags').multiEntry();
        });

        await Schema.table('plain', (table: Blueprint): void => {
            table.json('tags');
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
 * Apply the documented semantics of whereJsonContains to one value, three-valued, finding elements strictly.
 */
function contains(held: unknown, value: unknown): Truth {
    if (!Array.isArray(held)) {
        return null;
    }

    return (Array.isArray(value) ? value : [value]).every((element: unknown): boolean => held.includes(element));
}

/**
 * Apply the documented semantics of whereYear, whereMonth and whereDay to one value, three-valued, reading its part in local time.
 */
function parted(held: unknown, which: DatePart, operator: DateOperator, given: number): Truth {
    if (!(held instanceof Date)) {
        return null;
    }

    const part: number = which === 'year' ? held.getFullYear() : (which === 'month' ? held.getMonth() + 1 : held.getDate());

    return compare(part, operator, given);
}

/**
 * Apply the documented semantics of whereDate to one value, three-valued, comparing it with the local day the given value names.
 */
function dated(held: unknown, operator: DateOperator, given: Date | string): Truth {
    const named: Date = typeof given === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(given) ? new Date(`${given}T00:00:00`) : new Date(given);

    if (Number.isNaN(named.getTime())) {
        return false;
    }

    if (!(held instanceof Date)) {
        return null;
    }

    const first: number = new Date(named.getFullYear(), named.getMonth(), named.getDate()).getTime();
    const next: number = new Date(named.getFullYear(), named.getMonth(), named.getDate() + 1).getTime();
    const at: number = held.getTime();

    switch (operator) {
        case '=':
            return at >= first && at < next;

        case '>':
            return at >= next;

        case '>=':
            return at >= first;

        case '<':
            return at < first;

        case '<=':
            return at < next;

        default:
            return at < first || at >= next;
    }
}

/**
 * Apply the documented order to rows by their tags, which compares arrays as the strings they join into.
 */
function listed(rows: Tagged[], direction: Direction): Tagged[] {
    const sign: number = direction === 'desc' ? -1 : 1;

    return [...rows].sort((a: Tagged, b: Tagged): number => {
        if (absent(a.tags) || absent(b.tags)) {
            return sign * (Number(!absent(a.tags)) - Number(!absent(b.tags)));
        }

        return sign * (String(a.tags) < String(b.tags) ? -1 : 1);
    });
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
 * Run every aggregate over a column of a query.
 */
async function totals<T extends Item>(query: Builder<T>, column: string): Promise<Totals> {
    return {
        count: await query.clone().count(),
        sum  : await query.clone().sum(column),
        avg  : await query.clone().avg(column),
        min  : await query.clone().min(column),
        max  : await query.clone().max(column),
    };
}

/**
 * Apply the documented aggregates to the rows a query matches, which pass over a null or missing value.
 */
function modeled<R>(rows: R[], read: (row: R) => unknown): Totals {
    const values: number[] = rows.map(read).filter((value: unknown): boolean => !absent(value)) as number[];
    const sum: number = values.reduce((carry: number, value: number): number => carry + value, 0);
    const empty: boolean = values.length === 0;

    return {
        count: rows.length,
        sum,
        avg  : empty ? null : sum / values.length,
        min  : empty ? null : Math.min(...values),
        max  : empty ? null : Math.max(...values),
    };
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

describe.each([...CASES, ...EXTRAS, ...PARTS])('%s', (_: string, constrain: (query: Builder<Item>) => Builder<Item>, holds: (row: Item) => Truth): void => {
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

    test.each(ORDERINGS)('orderBy(%s, %s) paged by %j aggregates every record through an index, through a scan and in the model', async (column: Ranking, direction: Direction, page: Page): Promise<void> => {
        const expected: Totals = modeled(TIERED, (row: Ranked): unknown => row[column]);

        const answers: Record<Copy, Totals> = await both((query: Builder<Ranked>): Promise<Totals> => totals(arranged(query, column, direction, page), column));

        expect(answers).toEqual({ indexed: expected, plain: expected });
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

describe('aggregating over every match', (): void => {
    beforeEach(async (): Promise<void> => {
        connection = new Connection('app', { database: `invariance-weighed-${++sequence}`, migrations: [CreateItemsTables, AddWeightToItemsTables] });

        await connection.migrate();
        await connection.table<Weighed>('indexed').insert(WEIGHED);
        await connection.table<Weighed>('plain').insert(WEIGHED);
    });

    describe.each(SCOPES)('over %s', (_: string, constrain: (query: Builder<Weighed>) => Builder<Weighed>, holds: (row: Weighed) => boolean): void => {
        test.each(AGGREGATIONS)('every aggregate of %s under %s gives the whole answer through an index, through a scan and in the model', async (column: Weight, _: string, shape: Shaping): Promise<void> => {
            const expected: Totals = modeled(WEIGHED.filter(holds), (row: Weighed): unknown => row[column]);

            const answers: Record<Copy, Totals> = await both((query: Builder<Weighed>): Promise<Totals> => totals(shape(constrain(query)), column));

            expect(answers).toEqual({ indexed: expected, plain: expected });
        });
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

describe('a column holding arrays under a multi-entry index', (): void => {
    beforeEach(async (): Promise<void> => {
        const database: string = `invariance-tagged-${++sequence}`;
        const first: Connection = new Connection('app', { database, migrations: [CreateItemsTables] });

        await first.migrate();
        await first.table<Item>('indexed').insert(ROWS);
        await first.table<Item>('plain').insert(ROWS);

        first.disconnect();

        connection = new Connection('app', { database, migrations: [CreateItemsTables, AddTagsToItemsTables] });

        await connection.migrate();

        for (const [id, tags] of Object.entries(TAGS)) {
            await both((query: Builder<Tagged>): Promise<number> => query.where('id', Number(id)).update({ tags: typeof tags === 'string' ? JSON.stringify(tags) : tags }));
        }
    });

    describe.each(LISTINGS)('%s', (_: string, constrain: (query: Builder<Tagged>) => Builder<Tagged>, holds: (row: Tagged) => Truth): void => {
        const expected: number[] = ids(TAGGED.filter((row: Tagged): boolean => holds(row) === true));

        test('gives the same answer to every terminal through an index, through a scan and from the model', async (): Promise<void> => {
            const answers: Record<Copy, unknown> = await both(async (query: Builder<Tagged>): Promise<unknown> => ({
                rows     : ids(await constrain(query.clone()).get()),
                count    : await constrain(query.clone()).count(),
                first    : (await constrain(query.clone()).orderBy('id').first())?.id ?? null,
                plucked  : (await constrain(query.clone()).pluck('id') as number[]).sort((a: number, b: number): number => a - b),
                paginated: await constrain(query.clone()).orderBy('id').paginate(1, 2).then((page: Paginated<Tagged>): unknown => ({ rows: ids(page.data), total: page.total })),
            }));

            const modeled: unknown = { rows: expected, count: expected.length, first: expected[0] ?? null, plucked: expected, paginated: { rows: expected.slice(0, 2), total: expected.length } };

            expect(answers).toEqual({ indexed: modeled, plain: modeled });
        });
    });

    test.each(['asc', 'desc'] as Direction[])('orderBy(\'tags\', %s) gives the same answer to every terminal through an index, through a scan and from the model', async (direction: Direction): Promise<void> => {
        const expected: number[] = listed(TAGGED, direction).map((row: Tagged): number => row.id);

        const answers: Record<Copy, unknown> = await both(async (query: Builder<Tagged>): Promise<unknown> => {
            const ordered: () => Builder<Tagged> = (): Builder<Tagged> => query.clone().orderBy('tags', direction);

            return {
                rows     : (await ordered().get()).map((row: Tagged): number => row.id),
                count    : await ordered().count(),
                first    : (await ordered().first())?.id,
                plucked  : await ordered().pluck('id'),
                paginated: await ordered().paginate(2, 2).then((page: Paginated<Tagged>): unknown => ({ rows: page.data.map((row: Tagged): number => row.id), total: page.total })),
            };
        });

        const modeled: unknown = { rows: expected, count: expected.length, first: expected[0], plucked: expected, paginated: { rows: expected.slice(2, 4), total: expected.length } };

        expect(answers).toEqual({ indexed: modeled, plain: modeled });
    });

    test('orders by the tags in memory although the index holds as many entries as the table holds records', async (): Promise<void> => {
        const database: IDBDatabase = await connection.open();
        const store: IDBObjectStore = database.transaction('indexed', 'readonly').objectStore('indexed');

        expect(await Request.settle(store.index('indexed_tags_index').count())).toEqual(await Request.settle(store.count()));
        expect(await connection.table<Tagged>('indexed').orderBy('tags').explain()).toEqual('scan');
    });

    test('min and max over the tags give the same answer through an index, through a scan and from the model', async (): Promise<void> => {
        const values: number[] = TAGGED.filter((row: Tagged): boolean => !absent(row.tags)).map((row: Tagged): number => Number(row.tags));
        const expected: { min: number; max: number } = { min: values.reduce((a: number, b: number): number => Math.min(a, b)), max: values.reduce((a: number, b: number): number => Math.max(a, b)) };

        const answers: Record<Copy, unknown> = await both(async (query: Builder<Tagged>): Promise<unknown> => ({ min: await query.clone().min('tags'), max: await query.clone().max('tags') }));

        expect(answers).toEqual({ indexed: expected, plain: expected });
    });

    test.each(RETAGS)('%s writes the same rows through an index, through a scan and in the model', async (_: string, write: (query: Builder<Tagged>) => Promise<number>, change: (row: Tagged) => Tagged | null): Promise<void> => {
        const changed: number = TAGGED.filter((row: Tagged): boolean => change(row) !== row).length;
        const left: Tagged[] = TAGGED
            .map(change)
            .filter((row: Tagged | null): row is Tagged => row !== null);

        const affected: Record<Copy, number> = await both(write);

        expect(affected).toEqual({ indexed: changed, plain: changed });
        expect({ indexed: await raw('indexed'), plain: await raw('plain') }).toEqual({ indexed: sorted(left), plain: sorted(left) });
    }, 2000);
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

    describe.each(JOINS)('a join %s', (_: string, constrain: (query: Builder<Item>) => Builder<Item>, holds: (row: Item) => Truth): void => {
        const joined: Item[] = NOTES.flatMap((note: Note): Item[] => ROWS.filter((row: Item): boolean => row.id === note.item_id && holds(row) === true));

        test.each(SHAPES)('under %s aggregates every joined row through an index, through a scan and in the model', async (_: string, shape: Shaping): Promise<void> => {
            const expected: Totals = modeled(joined, (row: Item): unknown => row.visits);

            const answers: Record<Copy, Totals> = await both((query: Builder<Item>, copy: Copy): Promise<Totals> => {
                return totals(shape(constrain(query.join<Item>('notes', `${copy}.id`, '=', 'notes.item_id'))), 'visits');
            });

            expect(answers).toEqual({ indexed: expected, plain: expected });
        });
    });
});
