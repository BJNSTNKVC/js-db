import { Request } from '../database/Request';
import type { MigrationRecord } from './types';

export class Repository {
    /**
     * The name of the reserved store holding the migration records.
     */
    static readonly table: string = 'migrations';

    /**
     * Create the migrations store, unless it already exists.
     */
    static create(database: IDBDatabase): void {
        if (database.objectStoreNames.contains(this.table)) {
            return;
        }

        database.createObjectStore(this.table, { keyPath: 'order' });
    }

    /**
     * Record that a migration ran.
     */
    static log(transaction: IDBTransaction, order: number, migration: string, at: Date): void {
        transaction.objectStore(this.table).put({ order, migration, at: at.toISOString() } satisfies MigrationRecord);
    }

    /**
     * Get every recorded migration, in the order they were applied.
     */
    static ran(transaction: IDBTransaction): Promise<MigrationRecord[]> {
        return Request.settle(transaction.objectStore(this.table).getAll() as IDBRequest<MigrationRecord[]>);
    }
}
