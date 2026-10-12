# Migrations

A migration declares `up()` and nothing else:

```ts
class AddRoleToUsersTable extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('users', (table: Blueprint): void => {
            table.string('role').default('member');
        });
    }
}
```

Adding a column **with** a `default()` backfills every existing record with the default as the
column stores it, a date-only default as that day in the migrating connection's timezone. A `nullable()` column without one leaves existing records alone. A column that is
neither, required with no default, can only be added while no record would be left without a value,
so to an empty table, or to one whose records already hold a value under its name. Otherwise the migration throws `SchemaException` and
rolls back. [Adding columns](schema.md#adding-columns) has the details.

A definition IndexedDB cannot honor, such as a unique boolean column, an index over a column the
table lacks or a default its column cannot store, fails the migration with `SchemaException` too.
[Definitions IndexedDB cannot honor](schema.md#definitions-indexeddb-cannot-honor) lists them, and
what to do about a migration written before 6.0.0 that declares one, which a fresh install now
refuses. The same goes for a column named with ` as `, refused since 13.0.0.

Since 13.0.0, `dropColumn` and `renameColumn` on a column the same callback declares apply to that
declaration, where before they did nothing. A migration written that way builds something else on a
fresh install than it did on devices that already ran it, or fails when the column carries an index.
[Dropping or renaming a column the same callback declares](schema.md#dropping-or-renaming-a-column-the-same-callback-declares)
says how to correct it.

A migration that fails rolls back with every other migration the same open was running, since they
share one version change transaction. The database stays at its previous version, and the next
open runs them again.

A migration can also fail after its upgrade committed, such as one that awaits outside work (see
[What a migration may await](#what-a-migration-may-await)). Nothing is left to roll back then: the
migrations before it stay recorded, and what it did before the commit survives, but it is not
recorded as run. The next open runs it again, with every migration registered after it. A rerun that
meets its own earlier work usually fails, such as `Schema.create` on the table it already made,
which throws `SchemaException`. Rebuild such a database with `DB.fresh(name)`, or have the migration
check `Schema.hasTable` first. Before 16.0.0 no later open ran it or any migration after it, and
`DB.status` listed them as not run for good.

## Migrations are forward-only

IndexedDB versions cannot decrease, so there is no `down()`, no `rollback()` and no batches. To
start over, `DB.fresh(name)` deletes the database and replays every migration.

Migrations may only ever be **appended**. Reordering them, or removing one that already ran, throws
`MigrationMismatchException` rather than corrupting the schema.

An open runs the registered migrations past those recorded as run, upgrading the database to the
number of migrations plus one, or to one above its stored version when that is higher. So the
version is the number of migrations plus one until a migration is retried, and higher after. Before
16.0.0 it was always the number of migrations plus one, and a database stored past that version
threw `MigrationMismatchException` even when its recorded migrations matched.

The recorded name defaults to the class name in snake case, the way Laravel names a migration file,
so `CreateUsersTable` is recorded as `create_users_table`. Because it is derived from the class name,
a bundler that mangles class names will look like a reordered list. If you minify with class-name
mangling, override `name()`:

```ts
class CreateUsersTable extends Migration {
    /**
     * Get the name of the migration.
     */
    override name(): string {
        return 'create_users_table';
    }

    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        // ...
    }
}
```

## What a migration may await

A migration runs inside the version-change transaction, and IndexedDB commits a transaction the
moment its request queue drains. So a migration may **only** await operations from this package.
Awaiting `Schema.*`, `DB.table(...)` and `DB.transaction(...)` is safe. Awaiting a `fetch`, a timer, or any other promise
ends the transaction, and the next schema call or query throws `MigrationTransactionClosedException`.

A browser stops taking requests the moment a migration awaits outside work, but writes the commit in
the background. A schema call or query made before the commit lands throws
`MigrationTransactionClosedException` all the same, as does a query through a builder made earlier
or a `DB.transaction` joining the migration, and the migration is not recorded as run even if it
catches the exception. Before 15.0.3 a browser threw IndexedDB's own `TransactionInactiveError` there
instead.

A query on the connection being migrated joins the version-change transaction, so a migration can
read and rewrite rows between schema changes:

```ts
class FillUserSlugs extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.table('users', (table: Blueprint): void => {
            table.string('slug').nullable().unique();
        });

        for (const user of await DB.table<User>('users').get()) {
            await DB.table<User>('users').where('id', user.id).update({ slug: user.name.toLowerCase() });
        }
    }
}
```

The query sees the tables and columns the migration has declared so far, and its writes are coerced
and checked against them. A write that fails, such as one breaking a unique index, fails the
migration and rolls back the whole upgrade, rows and schema alike. `DB.table` resolves the default
connection, so a migration registered on another connection names it, as in
`DB.connection('reporting').table('events')`. A query on a different database is not part of the
upgrade, and awaiting it ends the transaction like any other promise.

`DB.transaction` on the connection being migrated joins the upgrade too, so a seeder or helper that
wraps its writes in one can run inside a migration. Its callback runs in the version-change
transaction, and resolves with what the callback returns:

- `options.tables` is ignored, since the version-change transaction covers every table.
- No `transaction-beginning`, `transaction-committed` or `transaction-rolled-back` is dispatched,
  since nothing begins or ends there. The migration events cover it.
- An error the callback throws fails the migration and rolls back the whole upgrade, as a failing
  `DB.table` write does. A failed write the callback catches leaves the rest of the upgrade in place.
- A callback that awaits something outside this package ends the upgrade's transaction, and its next
  query throws `MigrationTransactionClosedException`, as `DB.table` does.

While a migration runs, every query and every `DB.transaction` on its connection joins it, including
one the rest of the app starts at that moment and one through a builder made before it. Migrating
at boot with `await DB.migrate(name)`, before the rest of the app starts, keeps that from mattering.
Before 7.0.0 a query inside a migration waited for the very upgrade it was part of and never
settled, and before 9.0.1 so did `DB.transaction`.

A builder, or a `Transaction` from `DB.transaction`, made in a migration and kept after it has
finished runs as a builder made afresh would. It joins a migration running at that moment, and
otherwise each query opens a transaction of its own, so a kept `Transaction` reaches any table. One
used in a later migration of the same upgrade joins that migration. Before 17.0.0 a query through one
kept past the upgrade failed with IndexedDB's own `InvalidStateError`, and one made before a
migration and run inside it opened its own transaction, making the migration throw
`MigrationTransactionClosedException`.

If you need data from the network, that is what a seeder is for. See [Seeding](seeding.md).

## Migration status

```ts
await DB.status('app');
```

Resolves to one entry per registered migration:

```
[
    { migration: 'create_users_table', ran: true, at: '2026-08-27T21:00:00.000Z' },
    { migration: 'add_role_to_users_table', ran: false, at: null }
]
```

`DB.status(name)` never migrates as a side effect, so you can call it before `DB.migrate(name)` to
see what is pending.

> Modeled on Laravel's [Migrations](https://laravel.com/docs/12.x/migrations). These only run
> forward, and they are registered in the connection config rather than discovered from a directory.
