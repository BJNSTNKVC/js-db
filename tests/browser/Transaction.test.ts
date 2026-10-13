import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { DB } from '../../src/main';
import { TransactionClosedException } from '../../src/exceptions';
import type { Transaction } from '../../src/database/Transaction';
import type { DatabaseEvent } from '../../src/events';

interface User {
    id: number;
    name: string;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
        });
    }
}

const EVENTS: (keyof DatabaseEvent)[] = ['transaction-beginning', 'transaction-committed', 'transaction-rolled-back'];

let sequence: number = 0;

/**
 * Wait on a real timer, which ends the task the transaction was active in.
 */
function elsewhere(delay: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, delay);
    });
}

/**
 * Run a transaction, returning the reason it rejects with and the transaction events it dispatches.
 */
async function rejected(callback: (transaction: Transaction) => Promise<unknown>): Promise<[unknown, string[]]> {
    const seen: string[] = [];

    const listener: (event: Event) => void = (event: Event): void => {
        seen.push(event.type);
    };

    for (const event of EVENTS) {
        DB.listen(event, listener);
    }

    try {
        await DB.transaction(callback);
    } catch (error: unknown) {
        return [error, seen];
    } finally {
        for (const event of EVENTS) {
            DB.forget(event, listener);
        }
    }

    return [null, seen];
}

beforeEach(async (): Promise<void> => {
    DB.configure({ default: 'app', connections: { app: { database: `browser-transactions-${++sequence}`, migrations: [CreateUsersTable] } } });

    await DB.migrate('app');
});

afterEach((): void => {
    DB.purge('app');
});

describe.each([0, 50])('A DB.transaction callback that awaits a %i ms timer', (delay: number): void => {
    test('throws from the next query, rejects, and keeps the work committed before the await', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere(delay);
            await transaction.table<User>('users').insert({ name: 'Bob' });
        });

        expect(reason).toEqual(new TransactionClosedException('app'));
        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect((reason as Error).cause).toBeUndefined();
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await DB.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);

    test('rejects even when the callback catches the exception from a read', async (): Promise<void> => {
        let caught: unknown = null;

        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere(delay);

            try {
                await transaction.table<User>('users').get();
            } catch (error: unknown) {
                caught = error;
            }

            return 'done';
        });

        expect(caught).toBeInstanceOf(TransactionClosedException);
        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await DB.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);

    test('rejects once the callback settles, though it made no further query', async (): Promise<void> => {
        const [reason, seen]: [unknown, string[]] = await rejected(async (transaction: Transaction): Promise<string> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await elsewhere(delay);

            return 'done';
        });

        expect(reason).toBeInstanceOf(TransactionClosedException);
        expect(seen).toEqual(['db:transaction-beginning', 'db:transaction-committed']);
        expect(await DB.table<User>('users').pluck('name')).toEqual(['Alice']);
    }, 2000);
});
