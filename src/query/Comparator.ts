import type { Order } from './types';

export class Comparator {
    /**
     * Sort rows by the requested orders, reading each column through the accessor.
     */
    static sort<R>(rows: R[], orders: Order[], value: (row: R, column: string) => unknown): R[] {
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
     * Compare two column values, treating null as the lowest value.
     */
    static compare(a: unknown, b: unknown): number {
        const left: unknown = a instanceof Date ? a.getTime() : a;
        const right: unknown = b instanceof Date ? b.getTime() : b;

        if (this.#missing(left) || this.#missing(right)) {
            return this.#missing(left) && this.#missing(right) ? 0 : (this.#missing(left) ? -1 : 1);
        }

        if (left === right) {
            return 0;
        }

        return (left as number) < (right as number) ? -1 : 1;
    }

    /**
     * Determine whether the value is absent, which SQL orders below everything else.
     */
    static #missing(value: unknown): boolean {
        return value === null || value === undefined;
    }
}
