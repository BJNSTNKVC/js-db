# DB

TypeScript equivalent of the [Laravel database layer](https://laravel.com/docs/12.x/database) over IndexedDB: a `DB` facade, a fluent query builder, a schema builder and forward-only migrations that run when your app boots.

## Installation & setup

### NPM

You can install the package via npm:

```bash
npm install @bjnstnkvc/db
```

and then import it into your project

```ts
import { DB, Schema, Migration, type Blueprint } from '@bjnstnkvc/db';
```

## Usage

### Configuration

Declare your connections once, at module scope, then migrate when the app boots:

```ts
import { DB, Schema, Migration, type Blueprint } from '@bjnstnkvc/db';

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
            seeders   : [UserSeeder],
            strict    : true,
        },
    },
});

await DB.migrate('app');
```

| Option | Meaning |
| --- | --- |
| `default` | The connection used when none is named |
| `connections[name].database` | The IndexedDB database name |
| `connections[name].migrations` | Ordered migration classes. Their order **is** the schema version. |
| `connections[name].seeders` | Ordered seeder classes, run by `DB.seed(name)`. See [Seeding](#seeding). |
| `connections[name].strict` | Defaults to `true`. Nullability violations and uncoercible values throw. `false` writes `null` instead. |

`DB.migrate(name)` is idempotent. It opens the database at the version your migrations ask for, and
when that already matches, nothing runs. Calling it on every boot is the intended usage, and there
is no "has this been migrated?" check for you to write.

The connection name is **required**, unlike every other method on the manager. Boot is the one place
where quietly falling back to the default connection would let an app start having migrated only one
of its databases, so an app with several of them awaits one call each:

```ts
await DB.migrate('app');
await DB.migrate('reporting');
```

### Migrations

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

Adding a column **with** a `default()` backfills every existing record. Without one, existing
records are left alone.

#### Migrations are forward-only

IndexedDB versions cannot decrease, so there is no `down()`, no `rollback()` and no batches. To
start over, `DB.fresh()` deletes the database and replays every migration.

Migrations may only ever be **appended**. Reordering them, or removing one that already ran, throws
`MigrationMismatchException` rather than corrupting the schema.

The recorded name defaults to the class name, so a bundler that mangles class names will look like a
reordered list. If you minify with class-name mangling, override `name()`:

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

#### What a migration may await

This is the one real footgun in the package, and it comes from IndexedDB itself: a transaction
commits the moment its request queue drains. A migration runs inside the version-change
transaction, so it may **only** await operations from this package.

```ts
// Wrong. Awaiting a fetch ends the transaction, and the next line throws
// MigrationTransactionClosedException.
override async up(): Promise<void> {
    const seed: Response = await fetch('/seed.json');

    await Schema.create('users', (table: Blueprint): void => table.id());
}
```

```ts
// Right. Fetch first, then migrate.
const seed: unknown[] = await (await fetch('/seed.json')).json();

DB.configure({ /* ... */ });

await DB.migrate('app');
await DB.table('users').insert(seed);
```

Awaiting `Schema.*` and `DB.table(...)` operations inside a migration is safe. Awaiting a `fetch`, a
timer, or any other promise is not.

#### Migration status

```ts
await DB.status();
// [{ migration: 'CreateUsersTable', ran: true, at: '2026-08-27T21:00:00.000Z' }]
```

`DB.status()` never migrates as a side effect, so you can call it before `DB.migrate(name)` to
see what is pending.

### Seeding

Seeding is a separate step from migrating, and deliberately so. A migration runs inside the version
change transaction and therefore cannot await a `fetch`. A seeder runs outside it, so it can await
anything at all, which makes it the right home for any seed data that comes off the network.

```ts
import { Seeder, type Connection } from '@bjnstnkvc/db';

class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(connection: Connection): Promise<void> {
        const fetched: User[] = await (await fetch('/users.json')).json();

        await connection.table<User>('users').insert(fetched);
    }
}
```

Register the seeders on the connection and run them when you want to:

```ts
await DB.seed('app');
// ['UserSeeder']
```

`DB.seed(name)` opens the connection first, which migrates it, so the tables a seeder writes to are
guaranteed to exist. The connection name is required for the same reason it is on `migrate`.

The seeder receives the `Connection` it is seeding rather than reaching for the `DB` facade, so a
seeder registered on a second connection writes to that one and not to the default.

#### Seeders are not recorded

Unlike migrations, nothing records that a seeder ran. Every call to `DB.seed(name)` runs every
registered seeder again, which matches Laravel and keeps the surface small. If you call it on each
boot, write your seeders idempotently:

```ts
class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(connection: Connection): Promise<void> {
        await connection.table<User>('users').upsert([
            { email: 'admin@example.com', name: 'Admin' },
        ], 'email');
    }
}
```

Seeding is also not atomic across seeders. They run one after another, and a failure in the third
leaves the first two committed. A seeder that needs all-or-nothing opens its own transaction:

```ts
class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(connection: Connection): Promise<void> {
        await connection.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await transaction.table('posts').insert({ user_id: 1, title: 'Hello' });
        });
    }
}
```

#### Rebuilding from scratch

`DB.fresh(name)` deletes the database and replays the migrations. Pass `{ seed: true }` to seed it
afterwards as well, the way `migrate:fresh --seed` does in Laravel:

```ts
await DB.fresh('app');
await DB.fresh('app', { seed: true });
```

### Defining a schema

IndexedDB stores whole objects and enforces only a key path, `autoIncrement` and indexes. Column
types are recorded as metadata and enforced by this package at write time.

| Blueprint | Effect |
| --- | --- |
| `table.id()` | `keyPath: 'id'`, `autoIncrement: true` |
| `table.uuid('id').primary()` | `keyPath: 'id'`, no autoIncrement |
| `table.string` / `integer` / `float` / `boolean` / `date` / `datetime` / `json` | Column metadata |
| `.nullable()` | Metadata, enforced at write time |
| `.default(value)` | Applied at write time, and backfilled when added to an existing table |
| `.primary()` | Makes the column the key path. At most one per table. |
| `.index()` | `createIndex('users_name_index', 'name')` |
| `.unique()` | `createIndex('users_email_unique', 'email', { unique: true })` |
| `table.index(['a', 'b'])` | Compound index |
| `.multiEntry()` | One index entry per array element |
| `table.timestamps()` | Nullable `created_at` / `updated_at`, filled automatically |

Altering a table also supports `dropColumn`, `renameColumn`, `dropIndex` and `Schema.rename`. The key
path may not be dropped or renamed, because IndexedDB fixes it when the store is created.

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.dropColumn('legacy');
    table.renameColumn('name', 'full_name');
    table.dropIndex('users_age_index');
    table.index(['full_name']);
});
```

`Schema.rename` is implemented as create-copy-drop, so it is O(n) in the number of records.

#### Schema outside a migration

`Schema.create`, `Schema.table`, `Schema.drop`, `Schema.dropIfExists` and `Schema.rename` need the
version-change transaction, so they only run **inside a migration** and throw `SchemaException`
anywhere else. This is a real divergence from Laravel, where `Schema::create()` works from anywhere.

The read side works anywhere:

```ts
await Schema.hasTable('users');
await Schema.hasColumn('users', 'email');
await Schema.getTables();
await Schema.getColumns('users');
await Schema.getIndexes('users');
await Schema.connection('reporting').hasTable('reports');
```

### Querying

Chaining is synchronous; terminals return promises.

```ts
interface User {
    id: number;
    name: string;
    email: string;
    age: number | null;
    role: string;
}

const users: User[] = await DB.table<User>('users')
    .where('age', '>=', 18)
    .whereIn('role', ['admin', 'owner'])
    .whereNotNull('email')
    .orderBy('created_at', 'desc')
    .limit(10)
    .get();
```

#### Constraints

```ts
DB.table<User>('users')
    .where('name', 'John')                            // implicit =
    .where('age', '>=', 18)                           // explicit operator
    .where({ role: 'admin', age: 30 })                // object form
    .where((query: Builder<User>): void => {          // nested group
        query.where('age', 25).orWhere('name', 'Jane');
    })
    .orWhere('role', 'owner')
    .whereNot('role', 'guest')
    .whereIn('role', ['admin', 'owner'])
    .whereNotIn('role', ['guest'])
    .whereNull('age')
    .whereNotNull('email')
    .whereBetween('age', [18, 65])
    .whereNotBetween('age', [0, 17])
    .whereLike('name', 'Jo%')
    .whereNotLike('name', 'Test%');
```

Operators: `=`, `==`, `===`, `!=`, `<>`, `!==`, `<`, `>`, `<=`, `>=`, `like`, `not like`. `==` is
loose and `===` is strict.

Constraints follow SQL's three-valued logic: a comparison against `null` is unknown, and negating
unknown leaves it unknown. So a record whose `age` is `null` satisfies neither
`whereBetween('age', [18, 65])` nor `whereNotBetween('age', [18, 65])`. Only `whereNull` matches it.

#### Shaping

```ts
DB.table<User>('users')
    .select('name', 'email')
    .distinct()
    .orderBy('name')
    .latest('created_at')
    .oldest('created_at')
    .limit(10)
    .offset(20)
    .forPage(2, 15)
    .when(role, (query: Builder<User>, value: unknown): void => query.where('role', value))
    .tap((query: Builder<User>): void => query.where('active', true))
    .clone()
    .dump();
```

`select()` projects in memory after the fetch. IndexedDB always returns whole records, so it shapes
the result rather than saving any work.

#### Terminals

```ts
await DB.table<User>('users').get();                     // User[]
await DB.table<User>('users').first();                   // User | null
await DB.table<User>('users').firstOrFail();             // throws RecordsNotFoundException
await DB.table<User>('users').find(1);                   // point lookup on the key path
await DB.table<User>('users').findOrFail(1);
await DB.table<User>('users').value('email');            // the column of the first record
await DB.table<User>('users').pluck('email');            // string[]
await DB.table<User>('users').pluck('email', 'name');    // Record<string, string>
await DB.table<User>('users').exists();
await DB.table<User>('users').doesntExist();
await DB.table<User>('users').count();
await DB.table<User>('users').sum('age');
await DB.table<User>('users').avg('age');
await DB.table<User>('users').min('age');
await DB.table<User>('users').max('age');
```

`chunk` and `each` walk the result a page at a time, and stop early when the callback returns
`false`:

```ts
await DB.table<User>('users').orderBy('id').chunk(100, async (records: User[], page: number): Promise<void> => {
    await send(records);
});

await DB.table<User>('users').each((user: User, index: number): void => {
    console.log(index, user.name);
});
```

#### Writes

```ts
await DB.table<User>('users').insert({ name: 'John', email: 'john@example.com' });
await DB.table<User>('users').insert([{ /* ... */ }, { /* ... */ }]);
await DB.table<User>('users').insertGetId({ name: 'John', email: 'john@example.com' });

await DB.table<User>('users').where('role', 'member').update({ role: 'owner' });
await DB.table<User>('users').updateOrInsert({ email: 'john@example.com' }, { name: 'John' });

await DB.table<User>('users').upsert([{ email: 'john@example.com', name: 'John' }], 'email');
await DB.table<User>('users').upsert([{ /* ... */ }], 'email', ['name']);

await DB.table<User>('users').where('id', 1).increment('visits');
await DB.table<User>('users').where('id', 1).decrement('credits', 5);

await DB.table<User>('users').where('role', 'guest').delete();
await DB.table<User>('users').truncate();
```

On insert, the connection applies declared defaults, fills `created_at`/`updated_at` when the table
declares `timestamps()`, coerces declared column types, and throws
`NotNullConstraintViolationException` for an absent non-nullable column. On update, only
`updated_at` is touched.

A violated unique index surfaces as `UniqueConstraintViolationException` naming the table and the
index, rather than a bare `DOMException`.

`upsert` requires its conflict target to be the key path or a unique index, because IndexedDB cannot
enforce anything else. Any other column throws `SchemaException`.

The key path may not be updated, so `update`, `upsert` and `increment` all refuse it.

`update` and `delete` honour `limit` and `offset` in the order the plan scans, which is index order
when an index drives the query and key order otherwise. Pair them with an indexed `orderBy` if you
need a defined order.

### Query plans

The builder does not fetch everything and filter in memory. It compiles your constraints into an
IndexedDB key range over one index, plus a residual predicate applied while cursoring:

```ts
await DB.table<User>('users').where('id', 1).explain();          // 'key'
await DB.table<User>('users').where('email', 'a@b.c').explain(); // 'index:users_email_unique'
await DB.table<User>('users').where('role', 'admin').explain();  // 'scan'
```

- One index only. IndexedDB has no index intersection, so the planner picks the most selective
  candidate: the key path, then a unique index, then a plain index.
- `orderBy` on a single indexed, **non-nullable** column cursors that index, which lets `limit`
  short-circuit the scan. Nullable columns are excluded because an IndexedDB index drops records
  with no value for its key path, which would silently lose rows.
- When a range and an order want different indexes, the range wins and the sort happens in memory.
- Any top-level `orWhere` forces a full scan.
- `count()` with no residual constraints uses `count()` on the store or index, reading no records.

### Transactions

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    const id: IDBValidKey = await transaction.table<User>('users').insertGetId({ name: 'John' });

    await transaction.table('posts').insert({ user_id: id, title: 'Hello' });
});
```

Throwing inside the callback aborts the transaction and rethrows your error.

By default the transaction covers every table, since the callback's reach is unknowable up front.
Narrow it when you care:

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    await transaction.table<User>('users').insert({ name: 'John' });
}, { tables: ['users'] });
```

A nested `DB.transaction` **joins** the one already running. IndexedDB has no savepoints, so there is
no partial rollback.

There is no `beginTransaction()` / `commit()` / `rollBack()`. A manually held IndexedDB transaction
commits behind your back the first time you await anything outside it, so offering that API would be
offering a trap. The same rule as migrations applies here: the callback may only await operations
from this package.

### Events and the query log

```ts
DB.onQueryExecuted((event: QueryExecuted): void => {
    console.log(event.plan, event.duration, event.records);
});

DB.listen('migration-started', (event: MigrationStarted): void => console.log(event.migration));
DB.listen('query', listener, { once: true });
DB.forget('query', listener);
```

Available events: `query`, `transaction-beginning`, `transaction-committed`,
`transaction-rolled-back`, `migrations-started`, `migration-started`, `migration-ended`,
`migrations-ended`, `no-pending-migrations`, `seeding-started`, `seeder-started`, `seeder-ended`,
`seeding-ended`, `database-blocked`.

A connection with no seeders announces nothing, so `seeding-started` firing always means at least
one seeder is about to run.

Listeners are **persistent by default**, with an opt-in `{ once: true }`. This is a deliberate
departure from `@bjnstnkvc/local-storage`, where every listener fires exactly once.

```ts
DB.enableQueryLog();

await DB.table<User>('users').where('role', 'admin').get();

DB.getQueryLog();
// [{ connection: 'app', table: 'users', plan: 'scan', duration: 2, records: 7 }]

DB.flushQueryLog();
DB.disableQueryLog();
DB.logging(); // false
```

Because `plan` is on every entry, the log is enough to spot a query that scans a whole table.

### Multiple tabs

IndexedDB is shared across tabs, which produces two situations worth handling:

- Another tab holds an older version open, blocking an upgrade. The connection emits
  `database-blocked` and rejects with `DatabaseBlockedException`, so you can ask the user to close
  the other tabs.
- Another tab upgrades the database. The connection closes its own handle so it does not block that
  upgrade. If the other tab is running newer code with more migrations, this tab can no longer open
  the database and reports `MigrationMismatchException`, so reload the page.

### Connections

```ts
DB.connection();                // the default connection
DB.connection('reporting');     // a named connection, cached after the first resolve
DB.disconnect();                // close the handle, keep the connection registered
DB.purge();                     // close it and drop it, so the next resolve rebuilds it
```

### Reserved tables

`migrations` and `schema` are reserved. A migration that tries to create either throws
`ReservedTableException`. Column metadata is read from `schema` once per connection and cached in
memory, so writes inside a narrowed transaction still get their defaults.

### Exceptions

`ConnectionNotConfiguredException`, `DatabaseBlockedException`, `MigrationMismatchException`,
`MigrationTransactionClosedException`, `NotNullConstraintViolationException`,
`RecordsNotFoundException`, `ReservedTableException`, `SchemaException`, `TableNotFoundException`,
`UniqueConstraintViolationException`.

## Not included

- Joins, `groupBy` / `having` and subqueries
- `down()` / `rollback()` / migration batches, because IndexedDB versions cannot decrease
- Soft deletes, which are an Eloquent concern. Laravel's `DB::table()` does not honour them either.
- Model hydration and relations
- A collection return type. Terminals return plain arrays, which keeps the package dependency-free.

## Testing

IndexedDB does not exist in Node, so point your test setup at
[`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb):

```ts
// tests/setup.ts
import 'fake-indexeddb/auto';
```

```ts
// vitest.config.ts
export default defineConfig({
    test: {
        setupFiles: ['./tests/setup.ts'],
    },
});
```

Give each test file its own database name so the suites do not share state.
