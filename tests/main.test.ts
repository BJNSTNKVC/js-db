import { describe, expect, test } from 'vitest';
import * as db from '../src/main';

const values: string[] = [
    'Blueprint',
    'Builder',
    'ColumnDefinition',
    'Connection',
    'DB',
    'DatabaseBlocked',
    'DatabaseBlockedException',
    'DatabaseManager',
    'ConnectionNotConfiguredException',
    'Migration',
    'MigrationEnded',
    'MigrationMismatchException',
    'MigrationStarted',
    'MigrationTransactionClosedException',
    'MigrationsEnded',
    'MigrationsStarted',
    'NoPendingMigrations',
    'NotNullConstraintViolationException',
    'QueryExecuted',
    'RecordsNotFoundException',
    'ReservedTableException',
    'Schema',
    'Seeder',
    'SeederEnded',
    'SeederStarted',
    'SeedingEnded',
    'SeedingStarted',
    'SchemaException',
    'TableNotFoundException',
    'Transaction',
    'TransactionBeginning',
    'TransactionCommitted',
    'TransactionRolledBack',
    'UniqueConstraintViolationException',
];

describe('main', (): void => {
    test.each(values)('exports %s', (name: string): void => {
        expect((db as unknown as Record<string, unknown>)[name]).toBeTypeOf('function');
    });

    test('exports DB as an alias of DatabaseManager', (): void => {
        expect(db.DB).toBe(db.DatabaseManager);
    });

    test('exports nothing beyond what is documented', (): void => {
        expect(Object.keys(db).sort()).toEqual([...values].sort());
    });

    test('keeps the internals out of the public surface', (): void => {
        const internals: string[] = ['Migrator', 'Repository', 'Registry', 'Coercer', 'Planner', 'Predicate', 'Request', 'Dispatcher'];

        for (const name of internals) {
            expect((db as unknown as Record<string, unknown>)[name]).toBeUndefined();
        }
    });
});
