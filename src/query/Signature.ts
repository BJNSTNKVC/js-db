const SEPARATOR: string = '\u0001';

export class Signature {
    /**
     * Build a signature identifying a record by every column it holds.
     */
    static of(record: Record<string, unknown>): string {
        return Object.keys(record)
            .sort()
            .map((column: string): string => this.#segment(column) + this.#segment(this.value(record[column])))
            .join('');
    }

    /**
     * Build a signature identifying an ordered list of values.
     */
    static ofValues(values: unknown[]): string {
        return values.map((value: unknown): string => this.#segment(this.value(value))).join('');
    }

    /**
     * Encode one part of a signature so that its own content cannot be read as a boundary.
     */
    static #segment(part: string): string {
        // Joining on a separator alone let a value containing that separator forge a boundary, so two
        // different group keys could encode identically and their groups would silently merge. The
        // length says how far the part reaches, which leaves no way to fake the end of one.
        return `${part.length}${SEPARATOR}${part}`;
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
