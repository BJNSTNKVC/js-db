export class TransactionCommitted extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string;

    /**
     * Create a new Transaction Committed event instance.
     */
    constructor(connection: string) {
        super('db:transaction-committed');

        this.#connection = connection;
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection;
    }
}
