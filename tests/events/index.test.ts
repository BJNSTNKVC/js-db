import { describe, expect, test } from 'vitest';
import {
    DatabaseBlocked,
    MigrationEnded,
    MigrationsEnded,
    MigrationsStarted,
    MigrationStarted,
    NoPendingMigrations,
    QueryExecuted,
    SeederEnded,
    SeederStarted,
    SeedingEnded,
    SeedingStarted,
    TransactionBeginning,
    TransactionCommitted,
    TransactionRolledBack,
} from '../../src/events';
import type { Constraint, Order } from '../../src/query/types';

describe('QueryExecuted', (): void => {
    test('exposes the executed query', (): void => {
        const constraints: Constraint[] = [{ type: 'basic', column: 'id', operator: '=', value: 1, conjunction: 'and', not: false }];
        const orders: Order[] = [{ column: 'id', direction: 'asc' }];
        const event: QueryExecuted = new QueryExecuted('app', 'users', 'key', constraints, orders, 10, 3, 7);

        expect(event).toBeInstanceOf(Event);
        expect(event.type).toEqual('db:query');
        expect(event.connection).toEqual('app');
        expect(event.table).toEqual('users');
        expect(event.plan).toEqual('key');
        expect(event.constraints).toEqual(constraints);
        expect(event.orders).toEqual(orders);
        expect(event.limit).toEqual(10);
        expect(event.duration).toEqual(3);
        expect(event.records).toEqual(7);
    });

    test('accepts an absent limit', (): void => {
        expect(new QueryExecuted('app', 'users', 'scan', [], [], null, 1, 0).limit).toBeNull();
    });
});

describe('TransactionBeginning', (): void => {
    test('exposes the connection', (): void => {
        const event: TransactionBeginning = new TransactionBeginning('app');

        expect(event).toBeInstanceOf(Event);
        expect(event.type).toEqual('db:transaction-beginning');
        expect(event.connection).toEqual('app');
    });
});

describe('TransactionCommitted', (): void => {
    test('exposes the connection', (): void => {
        const event: TransactionCommitted = new TransactionCommitted('app');

        expect(event.type).toEqual('db:transaction-committed');
        expect(event.connection).toEqual('app');
    });
});

describe('TransactionRolledBack', (): void => {
    test('exposes the connection and the reason', (): void => {
        const reason: Error = new Error('Nope.');
        const event: TransactionRolledBack = new TransactionRolledBack('app', reason);

        expect(event.type).toEqual('db:transaction-rolled-back');
        expect(event.connection).toEqual('app');
        expect(event.reason).toBe(reason);
    });
});

describe('MigrationsStarted', (): void => {
    test('exposes the connection and the pending migrations', (): void => {
        const event: MigrationsStarted = new MigrationsStarted('app', ['CreateUsersTable']);

        expect(event.type).toEqual('db:migrations-started');
        expect(event.connection).toEqual('app');
        expect(event.migrations).toEqual(['CreateUsersTable']);
    });
});

describe('MigrationStarted', (): void => {
    test('exposes the migration', (): void => {
        const event: MigrationStarted = new MigrationStarted('CreateUsersTable');

        expect(event.type).toEqual('db:migration-started');
        expect(event.migration).toEqual('CreateUsersTable');
    });
});

describe('MigrationEnded', (): void => {
    test('exposes the migration', (): void => {
        const event: MigrationEnded = new MigrationEnded('CreateUsersTable');

        expect(event.type).toEqual('db:migration-ended');
        expect(event.migration).toEqual('CreateUsersTable');
    });
});

describe('MigrationsEnded', (): void => {
    test('exposes the connection and the migrations that ran', (): void => {
        const event: MigrationsEnded = new MigrationsEnded('app', ['CreateUsersTable']);

        expect(event.type).toEqual('db:migrations-ended');
        expect(event.connection).toEqual('app');
        expect(event.migrations).toEqual(['CreateUsersTable']);
    });
});

describe('NoPendingMigrations', (): void => {
    test('exposes the connection', (): void => {
        const event: NoPendingMigrations = new NoPendingMigrations('app');

        expect(event.type).toEqual('db:no-pending-migrations');
        expect(event.connection).toEqual('app');
    });
});

describe('DatabaseBlocked', (): void => {
    test('exposes the database', (): void => {
        const event: DatabaseBlocked = new DatabaseBlocked('app');

        expect(event.type).toEqual('db:database-blocked');
        expect(event.database).toEqual('app');
    });
});

describe('SeedingStarted', (): void => {
    test('exposes the connection and the seeders', (): void => {
        const event: SeedingStarted = new SeedingStarted('app', ['UserSeeder']);

        expect(event).toBeInstanceOf(Event);
        expect(event.type).toEqual('db:seeding-started');
        expect(event.connection).toEqual('app');
        expect(event.seeders).toEqual(['UserSeeder']);
    });
});

describe('SeederStarted', (): void => {
    test('exposes the seeder', (): void => {
        const event: SeederStarted = new SeederStarted('UserSeeder');

        expect(event.type).toEqual('db:seeder-started');
        expect(event.seeder).toEqual('UserSeeder');
    });
});

describe('SeederEnded', (): void => {
    test('exposes the seeder', (): void => {
        const event: SeederEnded = new SeederEnded('UserSeeder');

        expect(event.type).toEqual('db:seeder-ended');
        expect(event.seeder).toEqual('UserSeeder');
    });
});

describe('SeedingEnded', (): void => {
    test('exposes the connection and the seeders', (): void => {
        const event: SeedingEnded = new SeedingEnded('app', ['UserSeeder']);

        expect(event.type).toEqual('db:seeding-ended');
        expect(event.connection).toEqual('app');
        expect(event.seeders).toEqual(['UserSeeder']);
    });
});
