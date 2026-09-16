import { describe, expect, test } from 'vitest';
import { Migration } from '../../src/migrations/Migration';

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class AddOAuthTokensToHTTPClients extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class AddV2ColumnsToUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override up(): void {
    }
}

class create_posts_table extends Migration {
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
    test('names itself after its class in snake case', (): void => {
        expect(new CreateUsersTable().name()).toEqual('create_users_table');
    });

    test('keeps an acronym together when snake casing its class', (): void => {
        expect(new AddOAuthTokensToHTTPClients().name()).toEqual('add_o_auth_tokens_to_http_clients');
    });

    test('keeps a digit with the word before it when snake casing its class', (): void => {
        expect(new AddV2ColumnsToUsersTable().name()).toEqual('add_v2_columns_to_users_table');
    });

    test('leaves a class already in snake case alone', (): void => {
        expect(new create_posts_table().name()).toEqual('create_posts_table');
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
