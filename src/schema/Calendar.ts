const DAY: RegExp = /^(\d{4})-(\d{2})-(\d{2})$/;

export class Calendar {
    /**
     * Read a value as a date, a YYYY-MM-DD string as the first moment of that local calendar day.
     */
    static read(value: Date | string | number): Date {
        const parts: RegExpExecArray | null = typeof value === 'string' ? DAY.exec(value) : null;

        if (parts === null) {
            return new Date(value);
        }

        const [year, month, day]: number[] = parts.slice(1).map(Number) as [number, number, number];
        const date: Date = this.midnight(year, month - 1, day);

        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
    }

    /**
     * Get the first moment of a local calendar day, with the month numbered from zero and a year below 100 kept as given.
     */
    static midnight(year: number, month: number, day: number): Date {
        const date: Date = new Date(2000, 0, 1);

        date.setFullYear(year, month, day);
        date.setHours(0, 0, 0, 0);

        return date;
    }
}
