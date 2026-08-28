import { afterEach, describe, expect, test } from 'vitest';
import { Repository } from '../../src/migrations/Repository';
import { Request } from '../../src/database/Request';
import type { MigrationRecord } from '../../src/migrations/types';

let sequence: number = 0;

/**
 * Open a database, letting the callback shape it during the upgrade.
 */
function open(name: string, version: number, upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve: (value: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
        const request: IDBOpenDBRequest = indexedDB.open(name, version);

        request.onupgradeneeded = (): void => upgrade(request.result, request.transaction as IDBTransaction);
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void => reject(request.error);
    });
}

const opened: IDBDatabase[] = [];

/**
 * Open a uniquely named database with the migrations store present.
 */
async function repository(): Promise<IDBDatabase> {
    const database: IDBDatabase = await open(`repository-${++sequence}`, 1, (database: IDBDatabase): void => {
        Repository.create(database);
    });

    opened.push(database);

    return database;
}

afterEach((): void => {
    for (const database of opened.splice(0)) {
        database.close();
    }
});

describe('Repository.create', (): void => {
    test('creates the migrations store keyed by order', async (): Promise<void> => {
        const database: IDBDatabase = await repository();

        expect(Array.from(database.objectStoreNames)).toEqual(['migrations']);

        const transaction: IDBTransaction = database.transaction('migrations', 'readonly');

        expect(transaction.objectStore('migrations').keyPath).toEqual('order');
        expect(transaction.objectStore('migrations').autoIncrement).toEqual(false);
    });

    test('is idempotent when the store already exists', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const name: string = database.name;

        database.close();
        opened.length = 0;

        const reopened: IDBDatabase = await open(name, 2, (database: IDBDatabase): void => {
            Repository.create(database);
            Repository.create(database);
        });

        opened.push(reopened);

        expect(Array.from(reopened.objectStoreNames)).toEqual(['migrations']);
    });
});

describe('Repository.log', (): void => {
    test('writes a record for the migration', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readwrite');

        Repository.log(transaction, 1, 'CreateUsersTable', new Date('2026-08-27T21:00:00.000Z'));

        const records: MigrationRecord[] = await Repository.ran(transaction);

        expect(records).toEqual([
            { order: 1, migration: 'CreateUsersTable', at: '2026-08-27T21:00:00.000Z' },
        ]);
    });
});

describe('Repository.ran', (): void => {
    test('returns no records for an untouched store', async (): Promise<void> => {
        const database: IDBDatabase = await repository();

        expect(await Repository.ran(database.transaction('migrations', 'readonly'))).toEqual([]);
    });

    test('returns records in migration order, not insertion order', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readwrite');
        const at: Date = new Date('2026-08-27T21:00:00.000Z');

        Repository.log(transaction, 3, 'Third', at);
        Repository.log(transaction, 1, 'First', at);
        Repository.log(transaction, 2, 'Second', at);

        const records: MigrationRecord[] = await Repository.ran(transaction);

        expect(records.map((record: MigrationRecord): string => record.migration)).toEqual(['First', 'Second', 'Third']);
    });
});

describe('Repository.table', (): void => {
    test('names the reserved store', (): void => {
        expect(Repository.table).toEqual('migrations');
    });
});

describe('Request.settle', (): void => {
    test('rejects when the request fails', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readwrite');
        const store: IDBObjectStore = transaction.objectStore('migrations');
        const at: string = '2026-08-27T21:00:00.000Z';

        await Request.settle(store.add({ order: 1, migration: 'First', at }));

        await expect(Request.settle(store.add({ order: 1, migration: 'Duplicate', at }))).rejects.toBeInstanceOf(Error);
    });
});

describe('Request.walk', (): void => {
    test('stops early when the callback returns false', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readwrite');
        const at: Date = new Date('2026-08-27T21:00:00.000Z');

        Repository.log(transaction, 1, 'First', at);
        Repository.log(transaction, 2, 'Second', at);
        Repository.log(transaction, 3, 'Third', at);

        const seen: string[] = [];

        await Request.walk(transaction.objectStore('migrations').openCursor(), (cursor: IDBCursorWithValue): boolean => {
            seen.push((cursor.value as MigrationRecord).migration);

            return seen.length < 2;
        });

        expect(seen).toEqual(['First', 'Second']);
    });

    test('walks every record when the callback returns nothing', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readwrite');
        const at: Date = new Date('2026-08-27T21:00:00.000Z');

        Repository.log(transaction, 1, 'First', at);
        Repository.log(transaction, 2, 'Second', at);

        const seen: string[] = [];

        await Request.walk(transaction.objectStore('migrations').openCursor(), (cursor: IDBCursorWithValue): void => {
            seen.push((cursor.value as MigrationRecord).migration);
        });

        expect(seen).toEqual(['First', 'Second']);
    });

    test('rejects when the cursor request fails', async (): Promise<void> => {
        const database: IDBDatabase = await repository();
        const transaction: IDBTransaction = database.transaction('migrations', 'readonly');
        const request: IDBRequest<IDBCursorWithValue | null> = transaction.objectStore('migrations').openCursor();

        transaction.abort();

        await expect(Request.walk(request, (): void => {})).rejects.toBeDefined();
    });
});
