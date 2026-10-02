# Events

Listen for an event by its key, and the listener receives an instance of the class it maps to:

```ts
DB.listen('migration-started', (event: MigrationStarted): void => console.log(event.migration));
DB.listen('query', listener, { once: true });
DB.forget('query', listener);
```

Every event also has a shortcut named after its class, which takes the same options:

```ts
DB.onQueryExecuted((event: QueryExecuted): void => {
    console.log(event.plan, event.duration, event.records);
});
```

| Key                        | Class                    | Carries                                                                                |
|----------------------------|--------------------------|----------------------------------------------------------------------------------------|
| `query`                    | `QueryExecuted`          | `connection`, `table`, `plan`, `constraints`, `orders`, `limit`, `duration`, `records` |
| `transaction-beginning`    | `TransactionBeginning`   | `connection`                                                                           |
| `transaction-committed`    | `TransactionCommitted`   | `connection`                                                                           |
| `transaction-rolled-back`  | `TransactionRolledBack`  | `connection`, `reason`                                                                 |
| `migrations-started`       | `MigrationsStarted`      | `connection`, `migrations`                                                             |
| `migration-started`        | `MigrationStarted`       | `migration`                                                                            |
| `migration-ended`          | `MigrationEnded`         | `migration`                                                                            |
| `migrations-ended`         | `MigrationsEnded`        | `connection`, `migrations`                                                             |
| `no-pending-migrations`    | `NoPendingMigrations`    | `connection`                                                                           |
| `seeding-started`          | `SeedingStarted`         | `connection`, `seeders`                                                                |
| `seeder-started`           | `SeederStarted`          | `seeder`                                                                               |
| `seeder-ended`             | `SeederEnded`            | `seeder`                                                                               |
| `seeding-ended`            | `SeedingEnded`           | `connection`, `seeders`                                                                |
| `database-blocked`         | `DatabaseBlocked`        | `database`                                                                             |
| `database-version-changed` | `DatabaseVersionChanged` | `database`, `version`                                                                  |

A connection with no seeders announces nothing, so `seeding-started` firing always means at least
one seeder is about to run.

A transaction whose callback awaited something outside this package commits early, so it announces
`transaction-committed` and never `transaction-rolled-back`, even though `DB.transaction` rejects with
`TransactionClosedException`. See [What the callback may await](transactions.md#what-the-callback-may-await).

> Modeled on Laravel's [Migrations: Events](https://laravel.com/docs/12.x/migrations#events), with
> each event dispatched as a browser event and listened for by key.

## Query log

```ts
DB.enableQueryLog();

await DB.table<User>('users').where('role', 'admin').get();

DB.getQueryLog();
```

Resolves to one entry per `query` event dispatched while the log was enabled:

```
[
    { connection: 'app', table: 'users', plan: 'scan', duration: 2.41, records: 7 }
]
```

Because `plan` is on every entry, the log is enough to spot a query that scans a whole table.

Durations come from `performance.now()`, so they are sub-millisecond. `disableQueryLog()` stops
recording but keeps what was already recorded, and the log survives client-side navigation, so only
`flushQueryLog()` empties it.

```ts
DB.flushQueryLog();
DB.disableQueryLog();
```

`DB.logging()` then returns `false`, and `DB.getQueryLog()` an empty array.

> Modeled on Laravel's [Database: Listening for Query Events](https://laravel.com/docs/12.x/database#listening-for-query-events),
> with the same enable, get and flush surface, dispatched as a browser event.
