# DB

A database layer for IndexedDB, with an API modeled on [Laravel's](https://laravel.com/docs/12.x/database): a `DB` class, a fluent query builder, a schema builder and forward-only migrations that run when your app boots.

The method names and their semantics follow Laravel closely enough that the docs are worth reading side by side, and the [documentation](docs/README.md) links each Laravel page it draws from. It is not a port: IndexedDB is a key-value store with no query language, so the places where behavior has to differ are called out where they arise. This project is not affiliated with the Laravel project.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Where it differs from Laravel](#where-it-differs-from-laravel)
- [Testing](#testing)

## Installation

You can install the package via npm:

```bash
npm install @bjnstnkvc/db
```

and then import it into your project

```ts
import { DB, Schema, Migration, type Blueprint } from '@bjnstnkvc/db';
```

The package supports Chrome 93, Edge 93, Firefox 92 and Safari 15.4 or later.

## Quick start

Declare your connections once, at module scope, then migrate when the app boots:

```ts
import { DB, Schema, Migration, type Blueprint, type Transaction } from '@bjnstnkvc/db';

interface User {
    id: number;
    name: string;
    email: string;
    age: number | null;
    role: string;
    created_at: Date | null;
    updated_at: Date | null;
}

class CreateUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('users', (table: Blueprint): void => {
            table.id();
            table.string('name');
            table.string('email').unique();
            table.integer('age').nullable().index();
            table.string('role').default('member').index();
            table.timestamps();
        });
    }
}

DB.configure({
    default    : 'app',
    connections: {
        app: {
            database  : 'app',
            migrations: [CreateUsersTable],
        },
    },
});

await DB.migrate('app');
```

`DB.migrate(name)` is idempotent, so calling it on every boot is the intended usage. Then query:

```ts
await DB.table<User>('users').insert({ name: 'John', email: 'john@example.com', age: 30 });

const users: User[] = await DB.table<User>('users')
    .where('age', '>=', 18)
    .whereIn('role', ['admin', 'owner'])
    .orderBy('created_at', 'desc')
    .limit(10)
    .get();

await DB.transaction(async (transaction: Transaction): Promise<void> => {
    const id: IDBValidKey = await transaction.table<User>('users').insertGetId({ name: 'Jane', email: 'jane@example.com' });

    await transaction.table('posts').insert({ user_id: id, title: 'Hello' });
});
```

## Documentation

- [Configuration](docs/configuration.md): declaring connections, migrating at boot, and resolving,
  disconnecting and purging connections
- [Migrations](docs/migrations.md): forward-only migrations, what a migration may await, and
  migration status
- [Seeding](docs/seeding.md): seeders, which connection they write to, running them safely on every
  boot, and rebuilding from scratch
- [Defining a schema](docs/schema.md): column types and modifiers, altering and changing columns,
  indexes over renamed and dropped columns, decimals, enums, and reserved tables
- [Querying](docs/querying.md): constraints, JSON columns, shaping, terminals and writes
- [Joins](docs/joins.md): inner, left, right and cross joins, and what they cost
- [Grouping](docs/grouping.md): `groupBy`, typed aggregates and `having`
- [Query plans](docs/query-plans.md): how constraints become an index range, and `explain()`
- [Transactions](docs/transactions.md): transaction scope, nesting and what the callback may await
- [Events](docs/events.md): listening for query, transaction, migration and seeding events, and the
  query log
- [Multiple tabs](docs/multiple-tabs.md): blocked upgrades and databases changed by another tab
- [Storage quota](docs/storage.md): quota errors, usage estimates and asking not to be evicted
- [Exceptions](docs/exceptions.md): every exception the package throws, and when

## Where it differs from Laravel

- **Migrations only run forward.** IndexedDB versions cannot decrease, so there is no `down()` and no
  `rollback()`, and migrations may only be appended. `DB.fresh(name)` starts over.
  See [Migrations](docs/migrations.md).
- **A migration or transaction may only await this package.** IndexedDB commits a transaction the
  moment its queue drains, so awaiting a `fetch` or a timer ends it early, and the next call throws
  `MigrationTransactionClosedException` or `TransactionClosedException`. Network data belongs in a
  [seeder](docs/seeding.md). See [What a migration may await](docs/migrations.md#what-a-migration-may-await)
  and [What the callback may await](docs/transactions.md#what-the-callback-may-await).
- **Schema changes only run inside a migration**, since they need the version-change transaction.
  The read side works anywhere. See [Schema outside a migration](docs/schema.md#schema-outside-a-migration).
- **Column types are enforced by this package at write time**, because IndexedDB stores whole
  objects and checks nothing itself. See [Defining a schema](docs/schema.md).
- **There is no `beginTransaction()`, `commit()` or `rollBack()`**, and a nested transaction joins
  the running one, since IndexedDB has no savepoints. See [Transactions](docs/transactions.md).
- **Joins and grouping run in memory**, writes through a join reach the base table only, and
  aggregates are named in a typed object rather than raw SQL. See [Joins](docs/joins.md) and
  [Grouping](docs/grouping.md).
- **A query uses at most one index.** `explain()` shows which. See [Query plans](docs/query-plans.md).
- **The browser adds its own failure modes**: storage quota, eviction and other tabs holding the
  database open. See [Storage quota](docs/storage.md) and [Multiple tabs](docs/multiple-tabs.md).

## Testing

IndexedDB does not exist in Node, so point your test setup at
[`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb):

In `tests/setup.ts`:

```ts
import 'fake-indexeddb/auto';
```

And in `vitest.config.ts`:

```ts
export default defineConfig({
    test: {
        setupFiles: ['./tests/setup.ts'],
    },
});
```

Give each test file its own database name so the suites do not share state.
