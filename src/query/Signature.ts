const SEPARATOR: string = '\u0001';

export class Signature {
    /**
     * Build a signature identifying a record by every column it holds.
     */
    static of(record: Record<string, unknown>): string {
        return Object.keys(record)
            .sort()
            .map((column: string): string => `${column}=${this.value(record[column])}`)
            .join(SEPARATOR);
    }

    /**
     * Build a signature identifying an ordered list of values.
     */
    static ofValues(values: unknown[]): string {
        return values.map((value: unknown): string => this.value(value)).join(SEPARATOR);
    }

    /**
     * Encode a single value, keeping types and absence distinguishable.
     */
    static value(value: unknown): string {
        // JSON.stringify drops undefined entirely, which would collapse a column holding it into a
        // column that is simply absent, and it renders 1 and '1' identically once nested.
        if (value === undefined) {
            return '?';
        }

        if (value === null) {
            return '~';
        }

        if (value instanceof Date) {
            return `d:${value.getTime()}`;
        }

        if (typeof value === 'object') {
            return `o:${JSON.stringify(value)}`;
        }

        return `${(typeof value).charAt(0)}:${String(value)}`;
    }
}
