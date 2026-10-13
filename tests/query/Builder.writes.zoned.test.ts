import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Connection } from '../../src/database/Connection';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { Env } from '../environment';
import type { Builder } from '../../src/query/Builder';

interface Birthday {
    id: number;
    name: string;
    born: Date | null;
    seen: Date | null;
    noted: Date;
    visits: number;
}

class CreateBirthdaysTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('birthdays', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.date('born').nullable().unique();
            table.datetime('seen').nullable();
            table.date('noted').default('2024-01-15');
            table.integer('visits').default(0);
        });
    }
}

let sequence: number = 0;

describe('Builder writes of a date-only string', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let dated: Connection;

    /**
     * Begin a query against the birthdays table.
     */
    function birthdays(): Builder<Birthday> {
        return dated.table<Birthday>('birthdays');
    }

    /**
     * Get the local calendar day and hour a stored value falls on.
     */
    function local(value: Date | null): number[] {
        return value === null ? [] : [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours()];
    }

    /**
     * Migrate a database of its own on a connection set to the given timezone.
     */
    async function connect(timezone: string): Promise<void> {
        dated?.disconnect();

        dated = new Connection('app', { database: `builder-writes-dated-${++sequence}`, migrations: [CreateBirthdaysTable], timezone });

        await dated.migrate();
    }

    afterEach((): void => {
        dated?.disconnect();
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    describe('on a local connection', (): void => {
        beforeEach(async (): Promise<void> => {
            await connect('local');
        });

        describe.each(Env.zones())('in %s', (timezone: string): void => {
            beforeEach((): void => {
                Env.moveTo(timezone);
            });

            test('stores it as the local day in a date and a datetime column, and a date-only default too', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([local(alice.born), local(alice.seen), local(alice.noted)]).toEqual([[2024, 1, 15, 0], [2024, 1, 15, 0], [2024, 1, 15, 0]]);
            });

            test('stores it as the local day on update and alongside an increment', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice' });

                await birthdays().update({ born: '2024-02-29' as unknown as Date });
                await birthdays().increment('visits', 1, { seen: '2024-03-01' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([local(alice.born), local(alice.seen)]).toEqual([[2024, 2, 29, 0], [2024, 3, 1, 0]]);
            });

            test('finds the row it wrote by the same string', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date });

                expect(await birthdays().where('born', '2024-01-15').explain()).toEqual('index:birthdays_born_unique');
                expect(await birthdays().where('born', '2024-01-15').pluck('name')).toEqual(['Alice']);
            });

            test('merges an upsert keyed on it into the row the same string wrote', async (): Promise<void> => {
                await birthdays().upsert([{ name: 'Alice', born: '2024-01-15' as unknown as Date }], 'born');
                await birthdays().upsert([{ name: 'Alicia', born: '2024-01-15' as unknown as Date }], 'born');

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('updates through updateOrInsert the row the same string wrote', async (): Promise<void> => {
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alice' })).toEqual(true);
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alicia' })).toEqual(false);

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('refuses a day the calendar does not have, and a date-only string padded with spaces', async (): Promise<void> => {
                await expect(birthdays().insert({ name: 'Alice', born: '2024-02-30' as unknown as Date })).rejects.toThrow(TypeError);
                await expect(birthdays().insert({ name: 'Alice', born: ' 2024-01-15 ' as unknown as Date })).rejects.toThrow(TypeError);

                expect(await birthdays().count()).toEqual(0);
            });
        });

        describe.each(Env.zones(['America/Santiago']))('with the process in %s', (process: string): void => {
            test('stores a day whose midnight is skipped as its first moment', async (): Promise<void> => {
                Env.moveTo(process);

                await birthdays().insert({ name: 'Alice', born: '2024-09-08' as unknown as Date });

                expect(local((await birthdays().firstOrFail()).born)).toEqual([2024, 9, 8, 1]);
                expect(await birthdays().where('born', '2024-09-08').pluck('name')).toEqual(['Alice']);
            });
        });
    });

    describe.each([
        ['UTC', '2024-01-15T00:00:00.000Z', '2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z', '2024-01-15T10:00:00.000Z'],
        ['America/New_York', '2024-01-15T05:00:00.000Z', '2024-02-29T05:00:00.000Z', '2024-03-01T05:00:00.000Z', '2024-01-15T15:00:00.000Z'],
    ])('on a connection set to %s', (timezone: string, january: string, leap: string, march: string, morning: string): void => {
        beforeEach(async (): Promise<void> => {
            await connect(timezone);
        });

        describe.each(Env.zones())('with the process in %s', (process: string): void => {
            beforeEach((): void => {
                Env.moveTo(process);
            });

            test('stores it as midnight in that timezone in a date and a datetime column, and a date-only default too', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([alice.born?.toISOString(), alice.seen?.toISOString(), alice.noted.toISOString()]).toEqual([january, january, january]);
            });

            test('stores it as midnight in that timezone on update and alongside an increment', async (): Promise<void> => {
                await birthdays().insert({ name: 'Alice' });

                await birthdays().update({ born: '2024-02-29' as unknown as Date });
                await birthdays().increment('visits', 1, { seen: '2024-03-01' as unknown as Date });

                const alice: Birthday = await birthdays().firstOrFail();

                expect([alice.born?.toISOString(), alice.seen?.toISOString()]).toEqual([leap, march]);
            });

            test.each([
                ['born', 'index:birthdays_born_unique'],
                ['seen', 'scan'],
            ] as ['born' | 'seen', string][])('finds the row it wrote in %s by the same string under every constraint', async (column: 'born' | 'seen', plan: string): Promise<void> => {
                await birthdays().insert([
                    { name: 'Alice', born: '2024-01-15' as unknown as Date, seen: '2024-01-15' as unknown as Date },
                    { name: 'Bob', born: '2024-01-16' as unknown as Date, seen: '2024-01-16' as unknown as Date },
                ]);

                expect(await birthdays().where(column, '2024-01-15').explain()).toEqual(plan);
                expect(await birthdays().where(column, '2024-01-15').pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereIn(column, ['2024-01-15']).pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereBetween(column, ['2024-01-15', '2024-01-15']).pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereDate(column, '2024-01-15').pluck('name')).toEqual(['Alice']);
                expect(await birthdays().whereDay(column, 15).pluck('name')).toEqual(['Alice']);
            });

            test('merges an upsert keyed on it into the row the same string wrote', async (): Promise<void> => {
                await birthdays().upsert([{ name: 'Alice', born: '2024-01-15' as unknown as Date }], 'born');
                await birthdays().upsert([{ name: 'Alicia', born: '2024-01-15' as unknown as Date }], 'born');

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('updates through updateOrInsert the row the same string wrote', async (): Promise<void> => {
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alice' })).toEqual(true);
                expect(await birthdays().updateOrInsert({ born: '2024-01-15' as unknown as Date }, { name: 'Alicia' })).toEqual(false);

                expect(await birthdays().pluck('name')).toEqual(['Alicia']);
            });

            test('stores a time without an offset as that wall clock, and one with an offset as the moment it names', async (): Promise<void> => {
                await birthdays().insert([
                    { name: 'Alice', seen: '2024-01-15 10:00' as unknown as Date },
                    { name: 'Bob', seen: '2024-01-15T10:00:00+02:00' as unknown as Date },
                    { name: 'Carol', seen: '2024-01-15T12:00:00Z' as unknown as Date },
                ]);

                expect((await birthdays().orderBy('id').get()).map((birthday: Birthday): string | undefined => birthday.seen?.toISOString())).toEqual([
                    morning,
                    '2024-01-15T08:00:00.000Z',
                    '2024-01-15T12:00:00.000Z',
                ]);
                expect(await birthdays().where('seen', '2024-01-15 10:00').pluck('name')).toEqual(['Alice']);
            });

            test('refuses a day the calendar does not have, and a date-only string padded with spaces', async (): Promise<void> => {
                await expect(birthdays().insert({ name: 'Alice', born: '2024-02-30' as unknown as Date })).rejects.toThrow(TypeError);
                await expect(birthdays().insert({ name: 'Alice', born: ' 2024-01-15 ' as unknown as Date })).rejects.toThrow(TypeError);

                expect(await birthdays().count()).toEqual(0);
            });
        });
    });

    describe.each(Env.zones(['Asia/Tokyo']))('with the process in %s', (process: string): void => {
        test('stores a day whose midnight Santiago skips as its first moment there, whatever the process', async (): Promise<void> => {
            await connect('America/Santiago');

            Env.moveTo(process);

            await birthdays().insert({ name: 'Alice', born: '2024-09-08' as unknown as Date });

            expect((await birthdays().firstOrFail()).born?.toISOString()).toEqual('2024-09-08T04:00:00.000Z');
            expect(await birthdays().where('born', '2024-09-08').pluck('name')).toEqual(['Alice']);
        });
    });
});
