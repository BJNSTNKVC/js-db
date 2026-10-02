import { TransactionClosedException } from '../exceptions';

export class Handles {
    /**
     * The transactions that have committed, each under the name of its connection.
     */
    static readonly #closed: WeakMap<IDBTransaction, string> = new WeakMap<IDBTransaction, string>();

    /**
     * Mark the transaction as committed.
     */
    static close(transaction: IDBTransaction, connection: string): void {
        this.#closed.set(transaction, connection);
    }

    /**
     * Get the transaction, refusing one that has already committed.
     */
    static alive(transaction: IDBTransaction): IDBTransaction {
        const connection: string | undefined = this.#closed.get(transaction);

        if (connection !== undefined) {
            throw new TransactionClosedException(connection);
        }

        return transaction;
    }
}
