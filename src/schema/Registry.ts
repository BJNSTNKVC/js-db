import { Request } from '../database/Request';
import type { TableSchema } from './types';

export class Registry {
    /**
     * The name of the reserved store holding the table schemas.
     */
    static readonly table: string = 'schema';

    /**
     * Create the schema store, unless it already exists.
     */
    static create(database: IDBDatabase): void {
        if (database.objectStoreNames.contains(this.table)) {
            return;
        }

        database.createObjectStore(this.table, { keyPath: 'table' });
    }

    /**
     * Get the schema of every table.
     */
    static all(transaction: IDBTransaction): Promise<TableSchema[]> {
        return Request.settle(transaction.objectStore(this.table).getAll() as IDBRequest<TableSchema[]>);
    }

    /**
     * Record the schema of a table.
     */
    static put(transaction: IDBTransaction, schema: TableSchema): void {
        transaction.objectStore(this.table).put(schema);
    }

    /**
     * Forget the schema of a table.
     */
    static forget(transaction: IDBTransaction, table: string): void {
        transaction.objectStore(this.table).delete(table);
    }
}
