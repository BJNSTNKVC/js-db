const SEPARATOR: string = '\u0001';

export class Signature {
    /**
     * Build a signature identifying a record by every column it holds.
     */
    static of(record: Record<string, unknown>): string {
        return this.#entries(record, new Set<object>([record]));
    }

    /**
     * Build a signature identifying an ordered list of values.
     */
    static ofValues(values: unknown[]): string {
        return values.map((value: unknown): string => this.#segment(this.value(value))).join('');
    }

    /**
     * Encode a single value, keeping types and absence distinguishable at every depth.
     */
    static value(value: unknown): string {
        return this.#encode(value, new Set<object>());
    }

    /**
     * Encode a value whose enclosing objects and arrays are the given ancestors.
     */
    static #encode(value: unknown, ancestors: Set<object>): string {
        if (value === undefined) {
            return '?';
        }

        if (value === null) {
            return '~';
        }

        if (value instanceof Date) {
            return `d:${value.getTime()}`;
        }

        if (value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt) {
            return `w:${this.#encode(value.valueOf(), ancestors)}`;
        }

        if (typeof value === 'object') {
            if (ancestors.has(value)) {
                throw new TypeError('Unable to compare a value that contains itself.');
            }

            ancestors.add(value);

            const encoded: string = Array.isArray(value)
                ? `a:${this.#elements(value, ancestors)}`
                : `o:${this.#entries(value as Record<string, unknown>, ancestors)}`;

            ancestors.delete(value);

            return encoded;
        }

        return `${(typeof value).charAt(0)}:${String(value)}`;
    }

    /**
     * Encode every key of an object with its value, in an order that ignores how the keys were written.
     */
    static #entries(record: Record<string, unknown>, ancestors: Set<object>): string {
        // Compared by code unit rather than localeCompare, which can rank distinct keys as equal and
        // leave them in insertion order. The keys of an object are unique, so none ever tie.
        return Object.keys(record)
            .sort((a: string, b: string): number => a < b ? -1 : 1)
            .map((key: string): string => this.#segment(key) + this.#segment(this.#encode(record[key], ancestors)))
            .join('');
    }

    /**
     * Encode every element of an array in order, a hole as an empty part.
     */
    static #elements(values: unknown[], ancestors: Set<object>): string {
        return Array.from(values.keys(), (index: number): string => this.#segment(index in values ? this.#encode(values[index], ancestors) : '')).join('');
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
}
