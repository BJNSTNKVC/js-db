export class Resolver {
    /**
     * The connection standing in for the configured default.
     */
    static #override: string | null = null;

    /**
     * Get the connection standing in for the configured default.
     */
    static override(): string | null {
        return this.#override;
    }

    /**
     * Run the callback with the given connection standing in as the default.
     */
    static async during<R>(name: string, callback: () => Promise<R>): Promise<R> {
        const previous: string | null = this.#override;

        this.#override = name;

        try {
            return await callback();
        } finally {
            this.#override = previous;
        }
    }
}
