import type { Order } from './types';

const KEY: number = 0;

const BOOLEAN: number = 1;

const ARRAY: number = 2;

const OTHER: number = 3;

export class Comparator {
    /**
     * Sort rows by the requested orders, reading each column through the accessor.
     */
    static sort<R>(rows: R[], orders: readonly Order[], value: (row: R, column: string) => unknown): R[] {
        if (orders.length === 0) {
            return rows;
        }

        return [...rows].sort((a: R, b: R): number => {
            for (const order of orders) {
                const compared: number = this.compare(value(a, order.column), value(b, order.column));

                if (compared !== 0) {
                    return order.direction === 'desc' ? -compared : compared;
                }
            }

            return 0;
        });
    }

    /**
     * Compare two column values in the order orderBy sorts by.
     */
    static compare(a: unknown, b: unknown): number {
        if (this.#missing(a) || this.#missing(b)) {
            return this.#missing(a) && this.#missing(b) ? 0 : (this.#missing(a) ? -1 : 1);
        }

        // Null sorts first, then keys as IndexedDB orders them,
        // then false and true, then arrays that are not keys,
        // element by element. Every other value ties.
        const rank: number = this.#rank(a);
        const other: number = this.#rank(b);

        if (rank !== other) {
            return rank < other ? -1 : 1;
        }

        switch (rank) {
            case KEY:
                return this.#keys(a, b);

            case BOOLEAN:
                return Number(a) - Number(b);

            case ARRAY:
                return this.#elements(a as unknown[], b as unknown[]);

            default:
                return 0;
        }
    }

    /**
     * Determine whether IndexedDB accepts the value as a key.
     */
    static key(value: unknown): boolean {
        if (typeof value === 'number') {
            return !Number.isNaN(value);
        }

        if (value instanceof Date) {
            return !Number.isNaN(value.getTime());
        }

        if (typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            return true;
        }

        return Array.isArray(value) && Array.from(value).every((element: unknown): boolean => this.key(element));
    }

    /**
     * Get the rank of the kind of a value that is present.
     */
    static #rank(value: unknown): number {
        if (this.key(value)) {
            return KEY;
        }

        if (typeof value === 'boolean') {
            return BOOLEAN;
        }

        return Array.isArray(value) ? ARRAY : OTHER;
    }

    /**
     * Compare two keys as IndexedDB orders them.
     */
    static #keys(a: unknown, b: unknown): number {
        const left: unknown = a instanceof Date && b instanceof Date ? a.getTime() : a;
        const right: unknown = a instanceof Date && b instanceof Date ? b.getTime() : b;

        if ((typeof left !== 'number' || typeof right !== 'number') && (typeof left !== 'string' || typeof right !== 'string')) {
            return indexedDB.cmp(a, b);
        }

        return left === right ? 0 : (left < right ? -1 : 1);
    }

    /**
     * Compare two arrays element by element, the shorter first on a tie.
     */
    static #elements(a: unknown[], b: unknown[]): number {
        for (let index: number = 0; index < Math.min(a.length, b.length); index++) {
            const compared: number = this.compare(a[index], b[index]);

            if (compared !== 0) {
                return compared;
            }
        }

        return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
    }

    /**
     * Determine whether the value is absent, which SQL orders below everything else.
     */
    static #missing(value: unknown): boolean {
        return value === null || value === undefined;
    }
}
