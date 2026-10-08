export class Binding {
    /**
     * Get the value Laravel binds for a comparison: the first value an array or an object holds at any depth, false when it holds none, or the value itself.
     */
    static scalar(value: unknown): unknown {
        if (!this.structured(value)) {
            return value;
        }

        const values: unknown[] = this.flatten(value);

        return values.length === 0 ? false : values[0];
    }

    /**
     * Flatten arrays and objects into the values they hold, at every depth, as Laravel's Arr::flatten does.
     */
    static flatten(value: unknown): unknown[] {
        return this.structured(value)
            ? Object.values(value as object).flatMap((held: unknown): unknown[] => this.flatten(held))
            : [value];
    }

    /**
     * Determine whether a value is an array or a plain object, which compare by content and kind, unlike a date or binary data.
     */
    static structured(value: unknown): boolean {
        return Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]';
    }
}
