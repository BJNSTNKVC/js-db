export class MigrationTransactionClosedException extends Error {
    /**
     * Create a new exception for a migration that outlived its transaction.
     */
    constructor(migration: string) {
        super(`Migration [${migration}] continued after its transaction closed. A migration may only await database operations from this package - awaiting a fetch, a timer or any other promise ends the transaction.`)

        this.name = 'MigrationTransactionClosedException'
    }
}
