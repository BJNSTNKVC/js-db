export class TransactionBeginning extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string

    /**
     * Create a new Transaction Beginning event instance.
     */
    constructor(connection: string) {
        super('db:transaction-beginning')

        this.#connection = connection
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection
    }
}
