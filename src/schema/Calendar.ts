const WALL: RegExp = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

const DAY: number = 86_400_000;

export interface Parts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

export class Calendar {
    /**
     * The formatters that read a wall clock in each named timezone.
     */
    static #formatters: Map<string, Intl.DateTimeFormat> = new Map<string, Intl.DateTimeFormat>();

    /**
     * Resolve a timezone to the name the calendar reads it by, 'UTC', 'local' or a canonical IANA name, throwing the RangeError Intl throws for one it does not know.
     */
    static zone(timezone: string): string {
        if (timezone === 'UTC' || timezone === 'local') {
            return timezone;
        }

        return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    }

    /**
     * Read a value as a date, a YYYY-MM-DD string, alone or followed by a time without an offset, as that wall clock in the timezone.
     */
    static read(value: Date | string | number, timezone: string): Date {
        const wall: RegExpExecArray | null = typeof value === 'string' ? WALL.exec(value) : null;

        if (wall === null) {
            return new Date(value);
        }

        const [year, month, day, hour, minute, second]: number[] = wall.slice(1, 7).map((part: string | undefined): number => Number(part ?? 0)) as [number, number, number, number, number, number];
        const millisecond: number = Number((wall[7] ?? '').padEnd(3, '0').slice(0, 3));

        if (!this.#exists(year, month - 1, day) || hour > 23 || minute > 59 || second > 59) {
            return new Date(NaN);
        }

        return this.#instant({ year, month: month - 1, day, hour, minute, second, millisecond }, timezone);
    }

    /**
     * Get the first moment of a calendar day in the timezone, with the month numbered from zero and a year below 100 kept as given, or the first moment after a skipped midnight.
     */
    static midnight(year: number, month: number, day: number, timezone: string): Date {
        return this.#instant({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }, timezone);
    }

    /**
     * Read the wall clock an instant shows in the timezone, with the month numbered from zero.
     */
    static parts(date: Date, timezone: string): Parts {
        if (Number.isNaN(date.getTime())) {
            return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN, millisecond: NaN };
        }

        if (timezone === 'local') {
            return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), millisecond: date.getMilliseconds() };
        }

        if (timezone === 'UTC') {
            return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), millisecond: date.getUTCMilliseconds() };
        }

        const read: Record<string, string> = {};

        for (const part of this.#formatter(timezone).formatToParts(date)) {
            read[part.type] = part.value;
        }

        // Intl numbers the years before year 1 backwards from 1 BC, which is the year 0.
        const year: number = read['era'] === 'BC' ? 1 - Number(read['year']) : Number(read['year']);

        return { year, month: Number(read['month']) - 1, day: Number(read['day']), hour: Number(read['hour']), minute: Number(read['minute']), second: Number(read['second']), millisecond: date.getUTCMilliseconds() };
    }

    /**
     * Turn a wall clock in the timezone into an instant, taking the earlier of a repeated one and moving a skipped one forward by the gap, as a local Date does.
     */
    static #instant(parts: Parts, timezone: string): Date {
        if (timezone === 'local') {
            const date: Date = new Date(2000, 0, 1);

            date.setFullYear(parts.year, parts.month, parts.day);
            date.setHours(parts.hour, parts.minute, parts.second, parts.millisecond);

            return date;
        }

        const wall: number = this.#utc(parts);

        if (timezone === 'UTC' || Number.isNaN(wall)) {
            return new Date(wall);
        }

        const before: number = this.#offset(wall - DAY, timezone);
        const after: number = this.#offset(wall + DAY, timezone);
        const shown: number[] = [wall - before, wall - after].filter((moment: number): boolean => moment + this.#offset(moment, timezone) === wall);

        return new Date(shown.length === 0 ? wall - before : Math.min(...shown));
    }

    /**
     * Get how far the timezone's wall clock runs ahead of UTC at an instant.
     */
    static #offset(moment: number, timezone: string): number {
        const whole: number = moment - (((moment % 1000) + 1000) % 1000);

        return this.#utc(this.parts(new Date(whole), timezone)) - whole;
    }

    /**
     * Get the instant a wall clock names in UTC, keeping a year below 100 as given and rolling overflowing parts over.
     */
    static #utc(parts: Parts): number {
        const date: Date = new Date(0);

        date.setUTCFullYear(parts.year, parts.month, parts.day);

        return date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
    }

    /**
     * Determine whether a calendar day exists, with the month numbered from zero.
     */
    static #exists(year: number, month: number, day: number): boolean {
        const date: Date = new Date(this.#utc({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }));

        return date.getUTCMonth() === month && date.getUTCDate() === day;
    }

    /**
     * Get the formatter that reads a wall clock in a named timezone, made once per timezone.
     */
    static #formatter(timezone: string): Intl.DateTimeFormat {
        let formatter: Intl.DateTimeFormat | undefined = this.#formatters.get(timezone);

        if (formatter === undefined) {
            formatter = new Intl.DateTimeFormat('en-US', {
                timeZone : timezone,
                hourCycle: 'h23',
                era      : 'short',
                year     : 'numeric',
                month    : 'numeric',
                day      : 'numeric',
                hour     : 'numeric',
                minute   : 'numeric',
                second   : 'numeric',
            });

            this.#formatters.set(timezone, formatter);
        }

        return formatter;
    }
}
