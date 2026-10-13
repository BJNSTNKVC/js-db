import { describe, expect, test, vi } from 'vitest';
import { Calendar } from '../../src/schema/Calendar';
import type { MockInstance } from 'vitest';

const ALIASES: string[] = ['Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu', 'GMT', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich', 'Greenwich', 'GMT0'];

describe('Calendar.zone', (): void => {
    test.each(['UTC', 'local'])('keeps %o as given', (timezone: string): void => {
        expect(Calendar.zone(timezone)).toEqual(timezone);
    });

    test.each([
        ['utc', 'UTC'],
        ['america/new_york', 'America/New_York'],
        ['Asia/Tokyo', 'Asia/Tokyo'],
    ])('resolves %o to %o', (timezone: string, resolved: string): void => {
        expect(Calendar.zone(timezone)).toEqual(resolved);
    });

    test.each([...ALIASES, 'etc/utc'])('resolves %o to \'UTC\'', (timezone: string): void => {
        expect(Calendar.zone(timezone)).toEqual('UTC');
    });

    test.each(ALIASES)('reads %o as \'UTC\' when Intl keeps it as given', (timezone: string): void => {
        const resolved: Intl.ResolvedDateTimeFormatOptions = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions();
        const spy: MockInstance = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...resolved, timeZone: timezone });

        expect(Calendar.zone(timezone)).toEqual('UTC');

        spy.mockRestore();
    });

    test.each(['America/NewYork', 'Local', ''])('refuses %o with the RangeError Intl throws', (timezone: string): void => {
        expect((): string => Calendar.zone(timezone)).toThrow(RangeError);
    });
});
