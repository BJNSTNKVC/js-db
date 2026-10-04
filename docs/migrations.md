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
column stores it. A `nullable()` column without one leaves existing records alone. A column that is
neither, required with no default, can only be added while no record would be left without a value,
so to an empty table, or to one whose records already hold a value under its name. Otherwise the migration throws `SchemaException` and
rolls back. [Adding columns](schema.md#adding-columns) has the details.

A definition IndexedDB cannot honor, such as a unique boolean column, an index over a column the
table lacks or a default its column cannot store, fails the migration with `SchemaException` too.
[Definitions IndexedDB cannot honor](schema.md#definitions-indexeddb-cannot-honor) lists them, and
what to do about a migration written before 6.0.0 that declares one, which a fresh install now
refuses.

A migration that fails rolls back with every other migration the same open was running, since they
share one version change transaction. The database stays at its previous version, and the next
open runs them again.

## Migrations are forward-only

IndexedDB versions cannot decrease, so there is no `down()`, no `rollback()` and no batches. To
start over, `DB.fresh(name)` deletes the database and replays every migration.

Migrations may only ever be **appended**. Reordering them, or removing one that already ran, throws
`MigrationMismatchException` rather than corrupting the schema.

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
Awaiting `Schema.*` and `DB.table(...)` is safe. Awaiting a `fetch`, a timer, or any other promise
ends the transaction, and the next schema call or query throws `MigrationTransactionClosedException`.

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

While a migration runs, every query on its connection joins it, including one the rest of the app
starts at that moment. Migrating at boot with `await DB.migrate(name)`, before the rest of the app
starts, keeps that from mattering. Before 7.0.0 a query inside a migration waited for the very
upgrade it was part of and never settled.

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
