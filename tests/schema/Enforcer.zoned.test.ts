import { afterEach, describe, expect, test, vi } from 'vitest';
import { Enforcer } from '../../src/schema/Enforcer';
import { Env } from '../environment';
import type { ColumnSchema, ColumnType, TableSchema } from '../../src/schema/types';

/**
 * Build a column schema with the given overrides.
 */
function column(name: string, type: ColumnType, overrides: Partial<ColumnSchema> = {}): ColumnSchema {
    return {
        name,
        type,
        nullable  : false,
        default   : undefined,
        hasDefault: false,
        primary   : false,
        increments: false,
        places    : null,
        values    : null,
        ...overrides,
    };
}

/**
 * Build a table schema from the given columns.
 */
function table(columns: ColumnSchema[], overrides: Partial<TableSchema> = {}): TableSchema {
    return {
        table     : 'users',
        key       : 'id',
        increments: true,
        timestamps: false,
        columns,
        indexes   : [],
        ...overrides,
    };
}

const at: Date = new Date('2026-08-27T21:00:00.000Z');

const TEMPORAL: ColumnType[] = ['date', 'datetime'];

describe('Enforcer.coerce a date-only string in the connection\'s timezone', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const DAYS: [string, [number, number, number], string, string][] = [
        ['2024-01-15', [2024, 0, 15], '2024-01-15T00:00:00.000Z', '2024-01-15T05:00:00.000Z'],
        ['2024-02-29', [2024, 1, 29], '2024-02-29T00:00:00.000Z', '2024-02-29T05:00:00.000Z'],
        ['2024-12-31', [2024, 11, 31], '2024-12-31T00:00:00.000Z', '2024-12-31T05:00:00.000Z'],
        ['0099-01-01', [99, 0, 1], '0099-01-01T00:00:00.000Z', '0099-01-01T04:56:02.000Z'],
    ];

    afterEach((): void => {
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    describe.each(Env.zones())('with the process in %s', (process: string): void => {
        describe.each(TEMPORAL)('%s', (type: ColumnType): void => {
            test.each(DAYS)('stores %o as the first moment of that local day on a local connection', (value: string, [year, month, day]: [number, number, number]): void => {
                Env.moveTo(process);

                const stored: Date = Enforcer.coerce(value, type, true, 'local') as Date;

                expect([stored.getFullYear(), stored.getMonth(), stored.getDate(), stored.getHours(), stored.getMinutes()]).toEqual([year, month, day, 0, 0]);
                expect(Enforcer.coerce(value, type, false, 'local')).toEqual(stored);
            });

            test.each(DAYS)('stores %o as midnight UTC by default and as midnight in a named timezone, whatever the process', (value: string, _parts: [number, number, number], utc: string, york: string): void => {
                Env.moveTo(process);

                expect((Enforcer.coerce(value, type, true, 'UTC') as Date).toISOString()).toEqual(utc);
                expect((Enforcer.coerce(value, type, false, 'UTC') as Date).toISOString()).toEqual(utc);
                expect((Enforcer.coerce(value, type, true, 'America/New_York') as Date).toISOString()).toEqual(york);
            });

            test.each([
                ['2024-01-15T00:00:00Z', '2024-01-15T00:00:00.000Z'],
                ['2024-01-15T00:00+02:00', '2024-01-14T22:00:00.000Z'],
            ])('keeps reading %o as the moment it names under every timezone', (value: string, expected: string): void => {
                Env.moveTo(process);

                for (const timezone of ['local', 'UTC', 'America/New_York']) {
                    expect((Enforcer.coerce(value, type, true, timezone) as Date).toISOString()).toEqual(expected);
                }
            });

            test.each(['local', 'UTC', 'America/New_York'])('reads a date followed by a time as that wall clock in %s', (timezone: string): void => {
                Env.moveTo(process);

                expect(Enforcer.coerce('2024-01-15 00:00', type, true, timezone)).toEqual(Enforcer.coerce('2024-01-15', type, true, timezone));
            });

            test('stores a date-only default as the day it names in the connection\'s timezone', (): void => {
                Env.moveTo(process);

                const schema: TableSchema = table([column('on', type, { hasDefault: true, default: '2024-01-15' })]);
                const local: Date = Enforcer.insertable({}, schema, true, 'local', at)['on'] as Date;

                expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()]).toEqual([2024, 0, 15, 0]);
                expect((Enforcer.insertable({}, schema, true, 'UTC', at)['on'] as Date).toISOString()).toEqual('2024-01-15T00:00:00.000Z');
                expect((Enforcer.insertable({}, schema, true, 'America/New_York', at)['on'] as Date).toISOString()).toEqual('2024-01-15T05:00:00.000Z');
            });

            test('stores a day whose midnight Santiago skips as its first moment there', (): void => {
                Env.moveTo(process);

                expect((Enforcer.coerce('2024-09-08', type, true, 'America/Santiago') as Date).toISOString()).toEqual('2024-09-08T04:00:00.000Z');
            });

            test.each(['local', 'UTC', 'America/New_York'])('refuses a day the calendar does not have and a padded date in %s', (timezone: string): void => {
                Env.moveTo(process);

                expect((): unknown => Enforcer.coerce('2024-02-30', type, true, timezone)).toThrow(TypeError);
                expect((): unknown => Enforcer.coerce(' 2024-01-15 ', type, true, timezone)).toThrow(TypeError);
                expect(Enforcer.coerce('2024-02-30', type, false, timezone)).toBeNull();
            });
        });
    });

    describe.each(Env.zones(['America/Santiago']))('with the process in %s', (process: string): void => {
        test.each(TEMPORAL)('stores a %s on a day whose local midnight is skipped as its first moment', (type: ColumnType): void => {
            Env.moveTo(process);

            const stored: Date = Enforcer.coerce('2024-09-08', type, true, 'local') as Date;

            expect([stored.getDate(), stored.getHours()]).toEqual([8, 1]);
            expect(new Date(stored.getTime() - 1).getDate()).toEqual(7);
        });
    });
});
