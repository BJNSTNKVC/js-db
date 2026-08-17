import { describe, expect, test } from 'vitest';
import { Migration } from '../../src/migrations/Migration';

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class Renamed extends Migration {
    /**
     * Get the name of the migration.
     */
    override name(): string {
        return 'create_posts_table';
    }

    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class Asynchronous extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Promise.resolve();
    }
}

describe('Migration', (): void => {
    test('names itself after its class', (): void => {
        expect(new CreateUsersTable().name()).toEqual('CreateUsersTable');
    });

    test('honours an overridden name', (): void => {
        expect(new Renamed().name()).toEqual('create_posts_table');
    });

    test('accepts a synchronous up', (): void => {
        expect(new CreateUsersTable().up()).toBeUndefined();
    });

    test('accepts an asynchronous up', async (): Promise<void> => {
        await expect(new Asynchronous().up()).resolves.toBeUndefined();
    });
});
