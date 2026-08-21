export class TransactionRolledBack extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string;

    /**
     * The reason the transaction was rolled back.
     */
    readonly #reason: unknown;

    /**
     * Create a new Transaction Rolled Back event instance.
     */
    constructor(connection: string, reason: unknown) {
        super('db:transaction-rolled-back');

        this.#connection = connection;
        this.#reason = reason;
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection;
    }

    /**
     * Get the reason the transaction was rolled back.
     */
    get reason(): unknown {
        return this.#reason;
    }
}
