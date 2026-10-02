export class TransactionClosedException extends Error {
    /**
     * Create a new exception for a transaction callback that outlived its transaction.
     */
    constructor(connection: string, options?: ErrorOptions) {
        super(`Transaction on connection [${connection}] continued after it closed. A transaction may only await database operations from this package - awaiting a fetch, a timer or any other promise ends the transaction.`, options);

        this.name = 'TransactionClosedException';
    }
}
