import { TransactionClosedException } from '../exceptions';

export class Handles {
    /**
     * The transactions that transaction calls opened, under their connection's name.
     */
    static readonly #opened: WeakMap<IDBTransaction, string> = new WeakMap<IDBTransaction, string>();

    /**
     * The transactions that have committed, each under the name of its connection.
     */
    static readonly #closed: WeakMap<IDBTransaction, string> = new WeakMap<IDBTransaction, string>();

    /**
     * The transactions whose migration or transaction call has finished.
     */
    static readonly #released: WeakSet<IDBTransaction> = new WeakSet<IDBTransaction>();

    /**
     * Mark the transaction as opened by a transaction call.
     */
    static open(transaction: IDBTransaction, connection: string): void {
        this.#opened.set(transaction, connection);
    }

    /**
     * Mark the transaction as committed.
     */
    static close(transaction: IDBTransaction, connection: string): void {
        this.#closed.set(transaction, connection);
    }

    /**
     * Mark the transaction as finished with by its migration or transaction call.
     */
    static release(transaction: IDBTransaction): void {
        this.#released.add(transaction);
    }

    /**
     * Determine whether the transaction's migration or transaction call has finished.
     */
    static released(transaction: IDBTransaction): boolean {
        return this.#released.has(transaction);
    }

    /**
     * Get the transaction, refusing one that no longer accepts requests.
     */
    static alive(transaction: IDBTransaction): IDBTransaction | null {
        if (this.released(transaction)) {
            return null;
        }

        const closed: string | undefined = this.#closed.get(transaction);

        if (closed !== undefined) {
            throw new TransactionClosedException(closed);
        }

        const opened: string | undefined = this.#opened.get(transaction);

        if (opened !== undefined && this.inactive(transaction)) {
            throw new TransactionClosedException(opened);
        }

        return transaction;
    }

    /**
     * Determine whether the transaction has stopped accepting requests.
     */
    static inactive(transaction: IDBTransaction): boolean {
        // A browser deactivates a transaction once control returns to the
        // event loop, though it completes only when its requests drain.
        let error: unknown = null;

        // IndexedDB checks that the transaction is active before it reads the key,
        // so a get with no key throws TransactionInactiveError on an inactive one,
        // and on an active one throws a DataError without making a request.
        try {
            transaction.objectStore(transaction.objectStoreNames[0] as string).get(undefined as unknown as IDBValidKey);
        } catch (thrown: unknown) {
            error = thrown;
        }

        return error instanceof DOMException && error.name === 'TransactionInactiveError';
    }
}
