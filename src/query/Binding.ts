export class Binding {
    /**
     * Get the scalar value a comparison binds.
     */
    static scalar(value: unknown): unknown {
        if (!this.structured(value)) {
            return value;
        }

        const values: unknown[] = this.flatten(value);

        return values.length === 0 ? false : values[0];
    }

    /**
     * Flatten arrays and objects into the values they hold, at every depth.
     */
    static flatten(value: unknown): unknown[] {
        return this.#flatten(value, new Set<object>());
    }

    /**
     * Flatten a value whose enclosing arrays and objects are the given ancestors.
     */
    static #flatten(value: unknown, ancestors: Set<object>): unknown[] {
        if (!this.structured(value)) {
            return [value];
        }

        if (ancestors.has(value as object)) {
            throw new TypeError('Unable to compare a value that contains itself.');
        }

        ancestors.add(value as object);

        const values: unknown[] = Object.values(value as object).flatMap((held: unknown): unknown[] => this.#flatten(held, ancestors));

        ancestors.delete(value as object);

        return values;
    }

    /**
     * Determine whether a value is an array or a plain object.
     */
    static structured(value: unknown): boolean {
        return Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]';
    }
}
