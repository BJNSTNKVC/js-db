import { SchemaException } from '../exceptions'
import type { Builder } from '../query/Builder'
import type { Connection } from './Connection'

export class Transaction {
    /**
     * The connection the transaction runs on.
     */
    readonly #connection: Connection

    /**
     * The underlying transaction.
     */
    readonly #transaction: IDBTransaction

    /**
     * Create a new transaction.
     */
    constructor(connection: Connection, transaction: IDBTransaction) {
        this.#connection = connection
        this.#transaction = transaction
    }

    /**
     * Get the names of the tables the transaction is scoped to.
     */
    get tables(): string[] {
        return Array.from(this.#transaction.objectStoreNames)
    }

    /**
     * Begin a query against a table inside the transaction.
     */
    table<T = Record<string, unknown>>(name: string): Builder<T> {
        if (!this.#transaction.objectStoreNames.contains(name)) {
            throw new SchemaException(`Table [${name}] is outside the scope of this transaction.`)
        }

        return this.#connection.table<T>(name, this.#transaction)
    }
}
