import { afterEach, describe, expect, test, vi } from 'vitest';
import { Predicate } from '../../src/query/Predicate';
import { Env } from '../environment';
import type { Conjunction, Constraint, DatePart } from '../../src/query/types';

/**
 * Build a nested group of constraints.
 */
function nested(constraints: Constraint[], not: boolean = false, conjunction: Conjunction = 'and'): Constraint {
    return {
        type: 'nested',
        constraints,
        conjunction,
        not,
    };
}

/**
 * Test a record against the given constraints.
 */
function matches(constraints: Constraint[], record: Record<string, unknown>): boolean {
    return Predicate.compile(constraints)(record);
}

describe('Predicate date parts in the constraint\'s timezone', (): void => {
    const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

    /**
     * Build a constraint on one date part of a column, read in the given timezone.
     */
    function part(which: DatePart, value: number, timezone: string): Constraint {
        return { type: 'part', column: 'on', part: which, operator: '=', value, timezone, conjunction: 'and', not: false };
    }

    /**
     * Build a constraint on the time of day of a column, read in the given timezone.
     */
    function time(value: string, timezone: string): Constraint {
        return { type: 'time', column: 'on', operator: '=', value, timezone, conjunction: 'and', not: false };
    }

    afterEach((): void => {
        vi.stubEnv('TZ', zone);
        vi.unstubAllEnvs();
    });

    describe.each(Env.zones())('with the process in %s', (process: string): void => {
        test('reads the local day a held string names on a local connection', (): void => {
            Env.moveTo(process);

            expect(matches([part('year', 2024, 'local'), part('month', 1, 'local'), part('day', 1, 'local')], { on: '2024-01-01' })).toEqual(true);
            expect(matches([part('day', 15, 'local')], { on: '2024-01-15' })).toEqual(true);
            expect(matches([time('00:00:00', 'local')], { on: '2024-01-15' })).toEqual(true);
        });

        test('reads a held string with a time as the moment it names on a local connection', (): void => {
            Env.moveTo(process);

            expect(matches([part('day', 15, 'local'), time('10:30:00', 'local')], { on: '2024-01-15T10:30' })).toEqual(true);
            expect(matches([part('year', 2023, 'local')], { on: '2024-01-01T00:00:00Z' })).toEqual(new Date('2024-01-01T00:00:00Z').getFullYear() === 2023);
        });

        test.each(['UTC', 'America/New_York'])('reads the day and time a held string names in %s', (timezone: string): void => {
            Env.moveTo(process);

            expect(matches([part('year', 2024, timezone), part('month', 1, timezone), part('day', 15, timezone)], { on: '2024-01-15' })).toEqual(true);
            expect(matches([time('00:00:00', timezone)], { on: '2024-01-15' })).toEqual(true);
            expect(matches([part('day', 15, timezone), time('10:30:00', timezone)], { on: '2024-01-15 10:30' })).toEqual(true);
        });

        test('reads an instant by the day and time it falls on in the timezone, whatever the process', (): void => {
            Env.moveTo(process);

            const evening: Date = new Date('2024-01-15T02:00:00Z');

            expect(matches([part('day', 15, 'UTC'), time('02:00:00', 'UTC')], { on: evening })).toEqual(true);
            expect(matches([part('day', 14, 'America/New_York'), time('21:00:00', 'America/New_York')], { on: evening })).toEqual(true);
            expect(matches([part('year', 2023, 'UTC')], { on: '2024-01-01T00:00:00Z' })).toEqual(false);
            expect(matches([part('year', 2023, 'America/New_York')], { on: '2024-01-01T00:00:00Z' })).toEqual(true);
        });

        test.each(['local', 'UTC', 'America/New_York'])('reads a day the calendar does not have as no date in %s', (timezone: string): void => {
            Env.moveTo(process);

            expect(matches([part('month', 3, timezone)], { on: '2024-02-30' })).toEqual(false);
            expect(matches([nested([part('month', 3, timezone)], true)], { on: '2024-02-30' })).toEqual(false);
        });

        test('reads a day whose midnight Santiago skips from its first moment there', (): void => {
            Env.moveTo(process);

            expect(matches([part('day', 8, 'America/Santiago'), time('01:00:00', 'America/Santiago')], { on: '2024-09-08' })).toEqual(true);
        });

        test('reads both moments of an hour Santiago repeats as the same time of day', (): void => {
            Env.moveTo(process);

            expect(matches([part('day', 6, 'America/Santiago'), time('23:30:00', 'America/Santiago')], { on: new Date('2024-04-07T02:30:00Z') })).toEqual(true);
            expect(matches([part('day', 6, 'America/Santiago'), time('23:30:00', 'America/Santiago')], { on: new Date('2024-04-07T03:30:00Z') })).toEqual(true);
        });
    });

    describe.each(Env.zones(['America/Santiago']))('with the process in %s', (process: string): void => {
        test('reads a day whose local midnight is skipped from its first moment', (): void => {
            Env.moveTo(process);

            expect(matches([part('day', 8, 'local'), time('01:00:00', 'local')], { on: '2024-09-08' })).toEqual(true);
        });
    });
});
