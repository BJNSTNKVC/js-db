import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DB } from '../../src/main';
import { Request } from '../../src/database/Request';
import { Migration } from '../../src/migrations/Migration';
import { Schema } from '../../src/schema/Schema';
import { Blueprint } from '../../src/schema/Blueprint';
import { QuotaExceededException } from '../../src/exceptions';

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

let sequence: number = 0;

beforeEach((): void => {
    DB.configure({
        default    : 'app',
        connections: {
            app: { database: `storage-${++sequence}`, migrations: [CreateUsersTable] },
        },
    });
});

afterEach((): void => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('QuotaExceededException', (): void => {
    test('carries a default message naming the cause', (): void => {
        const exception: QuotaExceededException = new QuotaExceededException();

        expect(exception).toBeInstanceOf(Error);
        expect(exception.name).toEqual('QuotaExceededException');
        expect(exception.message).toContain('storage quota for this origin is full');
    });

    test('accepts an overridden message', (): void => {
        expect(new QuotaExceededException('Full.').message).toEqual('Full.');
    });
});

describe('Request.translate', (): void => {
    test('names a quota failure', (): void => {
        const error: DOMException = new DOMException('over quota', 'QuotaExceededError');

        expect(Request.translate(error)).toBeInstanceOf(QuotaExceededException);
    });

    test('leaves any other failure alone', (): void => {
        const error: DOMException = new DOMException('nope', 'ConstraintError');

        expect(Request.translate(error)).toBe(error);
    });

    test('leaves an absent failure alone', (): void => {
        expect(Request.translate(null)).toBeNull();
    });
});

describe('A write that exceeds the quota', (): void => {
    /**
     * Fail the next store write with the given platform error.
     */
    const failing: (name: string) => void = (name: string): void => {
        vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore): IDBRequest<IDBValidKey> {
            const request: Partial<IDBRequest<IDBValidKey>> = { error: new DOMException('boom', name) };

            setTimeout((): void => {
                (request.onerror as ((event: Event) => void) | null)?.(new Event('error'));
            }, 0);

            return request as IDBRequest<IDBValidKey>;
        });
    };

    test('reports the quota rather than a bare platform error', async (): Promise<void> => {
        await DB.migrate('app');

        failing('QuotaExceededError');

        await expect(DB.table<User>('users').insert({ name: 'Alice' })).rejects.toBeInstanceOf(QuotaExceededException);
    });

    test('leaves an unrelated platform error untranslated', async (): Promise<void> => {
        await DB.migrate('app');

        failing('UnknownError');

        await expect(DB.table<User>('users').insert({ name: 'Alice' })).rejects.toBeInstanceOf(DOMException);
    });
});

describe('DB.estimate', (): void => {
    test('reports what the browser says', async (): Promise<void> => {
        vi.stubGlobal('navigator', { storage: { estimate: async (): Promise<StorageEstimate> => ({ usage: 1024, quota: 8192 }) } });

        expect(await DB.estimate()).toEqual({ usage: 1024, quota: 8192 });
    });

    test('reports nothing where the Storage Manager is absent', async (): Promise<void> => {
        vi.stubGlobal('navigator', {});

        expect(await DB.estimate()).toEqual({});
    });
});

describe('DB.persist', (): void => {
    test('asks the browser to exempt this origin from eviction', async (): Promise<void> => {
        vi.stubGlobal('navigator', { storage: { persist: async (): Promise<boolean> => true } });

        expect(await DB.persist()).toEqual(true);
    });

    test('reports false where the Storage Manager is absent', async (): Promise<void> => {
        vi.stubGlobal('navigator', {});

        expect(await DB.persist()).toEqual(false);
    });
});

describe('DB.persisted', (): void => {
    test('reports whether this origin is already exempt', async (): Promise<void> => {
        vi.stubGlobal('navigator', { storage: { persisted: async (): Promise<boolean> => true } });

        expect(await DB.persisted()).toEqual(true);
    });

    test('reports false where the Storage Manager is absent', async (): Promise<void> => {
        vi.stubGlobal('navigator', {});

        expect(await DB.persisted()).toEqual(false);
    });
});
