import { afterEach, describe, expect, test, vi } from 'vitest';
import { Calendar } from '../../src/schema/Calendar';
import type { Parts } from '../../src/schema/Calendar';

const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PROCESSES: string[] = ['America/New_York', 'Asia/Tokyo', 'America/Santiago'];

/**
 * List the parts of a moment in order, the month numbered from zero.
 */
function listed(parts: Parts): number[] {
    return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond];
}

/**
 * Build the moment a UTC wall clock names, keeping a year below 100 as given.
 */
function utc(year: number, month: number, day: number, hour: number = 0, minute: number = 0, second: number = 0, millisecond: number = 0): Date {
    const date: Date = new Date(0);

    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, millisecond);

    return date;
}

afterEach((): void => {
    vi.stubEnv('TZ', zone);
    vi.unstubAllEnvs();
});

describe('Calendar.zone', (): void => {
    test.each(['UTC', 'local'])('keeps %o as given', (timezone: string): void => {
        expect(Calendar.zone(timezone)).toEqual(timezone);
    });

    test.each([
        ['utc', 'UTC'],
        ['Etc/UTC', 'UTC'],
        ['america/new_york', 'America/New_York'],
        ['Asia/Tokyo', 'Asia/Tokyo'],
    ])('resolves %o to %o', (timezone: string, resolved: string): void => {
        expect(Calendar.zone(timezone)).toEqual(resolved);
    });

    test.each(['America/NewYork', 'Local', ''])('refuses %o with the RangeError Intl throws', (timezone: string): void => {
        expect((): string => Calendar.zone(timezone)).toThrow(RangeError);
    });
});

describe('Calendar.midnight on a skipped local midnight', (): void => {
    test('gives the first moment after it, as a local Date does', (): void => {
        vi.stubEnv('TZ', 'America/Santiago');

        const first: Date = Calendar.midnight(2024, 8, 8, 'local');

        expect(first.toISOString()).toEqual('2024-09-08T04:00:00.000Z');
        expect(first).toEqual(new Date(2024, 8, 8));
    });
});

describe.each(PROCESSES)('Calendar with the process in %s', (process: string): void => {
    describe('parts', (): void => {
        const moment: Date = new Date('2024-01-15T02:00:00.250Z');

        test('reads an instant in UTC', (): void => {
            vi.stubEnv('TZ', process);

            expect(listed(Calendar.parts(moment, 'UTC'))).toEqual([2024, 0, 15, 2, 0, 0, 250]);
        });

        test('reads an instant in a named timezone', (): void => {
            vi.stubEnv('TZ', process);

            expect(listed(Calendar.parts(moment, 'America/New_York'))).toEqual([2024, 0, 14, 21, 0, 0, 250]);
            expect(listed(Calendar.parts(moment, 'Asia/Tokyo'))).toEqual([2024, 0, 15, 11, 0, 0, 250]);
        });

        test('reads an instant in the local timezone', (): void => {
            vi.stubEnv('TZ', process);

            expect(listed(Calendar.parts(moment, 'local'))).toEqual([
                moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours(), moment.getMinutes(), moment.getSeconds(), 250,
            ]);
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a year below 100, and the year 0, as given in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.parts(utc(99, 6, 1, 12), timezone).year).toEqual(99);
            expect(Calendar.parts(utc(0, 6, 1, 12), timezone).year).toEqual(0);
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads an invalid date as no parts in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(listed(Calendar.parts(new Date(NaN), timezone))).toEqual([NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
        });
    });

    describe('midnight', (): void => {
        test('gives the first moment of a UTC day, keeping a year below 100 and rolling an overflowing day over', (): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.midnight(2024, 0, 15, 'UTC').toISOString()).toEqual('2024-01-15T00:00:00.000Z');
            expect(Calendar.midnight(99, 0, 1, 'UTC').toISOString()).toEqual('0099-01-01T00:00:00.000Z');
            expect(Calendar.midnight(2024, 0, 32, 'UTC').toISOString()).toEqual('2024-02-01T00:00:00.000Z');
        });

        test('gives the first moment of a day in a named timezone, in winter and in summer', (): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.midnight(2024, 0, 15, 'America/New_York').toISOString()).toEqual('2024-01-15T05:00:00.000Z');
            expect(Calendar.midnight(2024, 6, 15, 'America/New_York').toISOString()).toEqual('2024-07-15T04:00:00.000Z');
            expect(Calendar.midnight(2024, 0, 15, 'Asia/Tokyo').toISOString()).toEqual('2024-01-14T15:00:00.000Z');
            expect(Calendar.midnight(2024, 0, 32, 'Asia/Tokyo').toISOString()).toEqual('2024-01-31T15:00:00.000Z');
        });

        test('gives the first moment of a local day', (): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.midnight(2024, 0, 15, 'local')).toEqual(new Date(2024, 0, 15));
            expect(listed(Calendar.parts(Calendar.midnight(99, 0, 1, 'local'), 'local'))).toEqual([99, 0, 1, 0, 0, 0, 0]);
        });

        test('gives the first moment after a skipped midnight in a named timezone', (): void => {
            vi.stubEnv('TZ', process);

            const first: Date = Calendar.midnight(2024, 8, 8, 'America/Santiago');

            expect(first.toISOString()).toEqual('2024-09-08T04:00:00.000Z');
            expect(listed(Calendar.parts(first, 'America/Santiago'))).toEqual([2024, 8, 8, 1, 0, 0, 0]);
            expect(listed(Calendar.parts(new Date(first.getTime() - 1), 'America/Santiago'))).toEqual([2024, 8, 7, 23, 59, 59, 999]);
        });

        test('gives a named day of 25 hours across the autumn change', (): void => {
            vi.stubEnv('TZ', process);

            const span: number = Calendar.midnight(2024, 3, 7, 'America/Santiago').getTime() - Calendar.midnight(2024, 3, 6, 'America/Santiago').getTime();

            expect(span).toEqual(25 * 3_600_000);
        });

        test.each(['UTC', 'local', 'America/New_York'])('gives an invalid date for parts that are not numbers in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.midnight(NaN, NaN, NaN, timezone).getTime()).toBeNaN();
        });
    });

    describe('moment', (): void => {
        test.each([
            ['UTC', '2024-01-15T00:00:00.000Z'],
            ['America/New_York', '2024-01-15T05:00:00.000Z'],
            ['Asia/Tokyo', '2024-01-14T15:00:00.000Z'],
        ])('reads a date-only string as the first moment of that day in %s', (timezone: string, expected: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment('2024-01-15', timezone)?.toISOString()).toEqual(expected);
        });

        test('reads a date-only string as the first moment of that local day', (): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment('2024-01-15', 'local')).toEqual(new Date(2024, 0, 15));
        });

        test.each([
            ['2024-01-15 10:00', 'UTC', '2024-01-15T10:00:00.000Z'],
            ['2024-01-15T10:00:30', 'UTC', '2024-01-15T10:00:30.000Z'],
            ['2024-01-15T10:00:30.5', 'UTC', '2024-01-15T10:00:30.500Z'],
            ['2024-01-15T10:00:30.123456', 'UTC', '2024-01-15T10:00:30.123Z'],
            ['2024-01-15 10:00', 'America/New_York', '2024-01-15T15:00:00.000Z'],
            ['2024-01-15 10:00', 'Asia/Tokyo', '2024-01-15T01:00:00.000Z'],
        ])('reads %o as that wall clock in %s', (value: string, timezone: string, expected: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment(value, timezone)?.toISOString()).toEqual(expected);
        });

        test('reads a date and time without an offset as that local wall clock', (): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment('2024-01-15 10:00:30.5', 'local')).toEqual(new Date(2024, 0, 15, 10, 0, 30, 500));
        });

        test.each([
            ['2024-11-03 01:30', 'America/New_York', '2024-11-03T05:30:00.000Z'],
            ['2024-04-06 23:30', 'America/Santiago', '2024-04-07T02:30:00.000Z'],
        ])('reads a repeated wall clock %o as its earlier moment in %s, as a local Date does', (value: string, timezone: string, expected: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment(value, timezone)?.toISOString()).toEqual(expected);

            vi.stubEnv('TZ', timezone);

            expect(Calendar.moment(value, 'local')?.toISOString()).toEqual(expected);
        });

        test.each([
            ['2024-03-10 02:30', 'America/New_York', '2024-03-10T07:30:00.000Z'],
            ['2024-09-08 00:30', 'America/Santiago', '2024-09-08T04:30:00.000Z'],
        ])('moves a skipped wall clock %o forward by the gap in %s, as a local Date does', (value: string, timezone: string, expected: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment(value, timezone)?.toISOString()).toEqual(expected);

            vi.stubEnv('TZ', timezone);

            expect(Calendar.moment(value, 'local')?.toISOString()).toEqual(expected);
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a year below 100 as given in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            const read: Date = Calendar.moment('0099-01-01', timezone) as Date;

            expect(listed(Calendar.parts(read, timezone))).toEqual([99, 0, 1, 0, 0, 0, 0]);
            expect(Calendar.moment('0099-01-01', 'UTC')?.toISOString()).toEqual('0099-01-01T00:00:00.000Z');
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a date or time the calendar does not have as no moment in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            for (const value of ['2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10', '2024-01-00', '2024-01-15 24:00', '2024-01-15 10:60', '2024-01-15 10:00:60']) {
                expect(Calendar.moment(value, timezone)).toBeNull();
            }
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a string with Z or an offset as the moment it names in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment('2024-01-15T10:00:00Z', timezone)?.toISOString()).toEqual('2024-01-15T10:00:00.000Z');
            expect(Calendar.moment('2024-01-15T10:00:00+02:00', timezone)?.toISOString()).toEqual('2024-01-15T08:00:00.000Z');
            expect(Calendar.moment('2024-01-15 10:00Z', timezone)?.toISOString()).toEqual('2024-01-15T10:00:00.000Z');
            expect(Calendar.moment('2024-01-15T10:00:30.123456-05:30', timezone)?.toISOString()).toEqual('2024-01-15T15:30:30.123Z');
            expect(Calendar.moment('0099-01-01T00:00:00+01:00', timezone)?.toISOString()).toEqual('0098-12-31T23:00:00.000Z');
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads an offset the clock does not have as no moment in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            expect(Calendar.moment('2024-01-15T10:00:00+24:00', timezone)).toBeNull();
            expect(Calendar.moment('2024-01-15T10:00:00+02:60', timezone)).toBeNull();
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a date as it is and a number as a timestamp in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            const date: Date = new Date('2024-01-15T10:00:00Z');

            expect(Calendar.moment(date, timezone)).toBe(date);
            expect(Calendar.moment(0, timezone)).toEqual(new Date(0));
            expect(Calendar.moment(new Date(NaN), timezone)).toBeNull();
            expect(Calendar.moment(NaN, timezone)).toBeNull();
        });

        test.each(['UTC', 'local', 'America/New_York'])('reads a string in a form a write refuses, and any other value, as no moment in %s', (timezone: string): void => {
            vi.stubEnv('TZ', process);

            for (const value of ['Jan 15 2024', '2024/01/15', ' 2024-01-15 ', '2024-01-15t10:00:00z', '2024-01-15T10:00:00+0200', '2024-01-15Z', 'Mon, 15 Jan 2024 10:00:00 GMT', 'garbage', '', true, null, [2024]]) {
                expect(Calendar.moment(value, timezone)).toBeNull();
            }
        });
    });
});
