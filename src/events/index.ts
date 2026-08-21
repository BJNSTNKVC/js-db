import type { DatabaseBlocked } from './DatabaseBlocked';
import type { MigrationEnded } from './MigrationEnded';
import type { MigrationsEnded } from './MigrationsEnded';
import type { MigrationsStarted } from './MigrationsStarted';
import type { MigrationStarted } from './MigrationStarted';
import type { NoPendingMigrations } from './NoPendingMigrations';
import type { QueryExecuted } from './QueryExecuted';
import type { SeederEnded } from './SeederEnded';
import type { SeederStarted } from './SeederStarted';
import type { SeedingEnded } from './SeedingEnded';
import type { SeedingStarted } from './SeedingStarted';
import type { TransactionBeginning } from './TransactionBeginning';
import type { TransactionCommitted } from './TransactionCommitted';
import type { TransactionRolledBack } from './TransactionRolledBack';

export { DatabaseBlocked } from './DatabaseBlocked';
export { MigrationEnded } from './MigrationEnded';
export { MigrationsEnded } from './MigrationsEnded';
export { MigrationsStarted } from './MigrationsStarted';
export { MigrationStarted } from './MigrationStarted';
export { NoPendingMigrations } from './NoPendingMigrations';
export { QueryExecuted } from './QueryExecuted';
export { SeederEnded } from './SeederEnded';
export { SeederStarted } from './SeederStarted';
export { SeedingEnded } from './SeedingEnded';
export { SeedingStarted } from './SeedingStarted';
export { TransactionBeginning } from './TransactionBeginning';
export { TransactionCommitted } from './TransactionCommitted';
export { TransactionRolledBack } from './TransactionRolledBack';

export type DatabaseEvent = {
    'database-blocked'       : DatabaseBlocked;
    'migration-ended'        : MigrationEnded;
    'migration-started'      : MigrationStarted;
    'migrations-ended'       : MigrationsEnded;
    'migrations-started'     : MigrationsStarted;
    'no-pending-migrations'  : NoPendingMigrations;
    'query'                  : QueryExecuted;
    'seeder-ended'           : SeederEnded;
    'seeder-started'         : SeederStarted;
    'seeding-ended'          : SeedingEnded;
    'seeding-started'        : SeedingStarted;
    'transaction-beginning'  : TransactionBeginning;
    'transaction-committed'  : TransactionCommitted;
    'transaction-rolled-back': TransactionRolledBack;
};

export type DatabaseEventListener<K extends keyof DatabaseEvent> = (event: DatabaseEvent[K]) => void;
