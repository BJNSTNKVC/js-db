# DB

A database layer for IndexedDB, with an API modelled on [Laravel's](https://laravel.com/docs/12.x/database): a `DB` class, a fluent query builder, a schema builder and forward-only migrations that run when your app boots.

The method names and their semantics follow Laravel closely enough that the docs are worth reading side by side, and each section below links the page it draws from. It is not a port: IndexedDB is a key-value store with no query language, so the places where behaviour has to differ are called out where they arise. This project is not affiliated with the Laravel project.

## Contents

- [Installation & setup](#installation--setup)
- [Configuration](#configuration)
- [Migrations](#migrations)
- [Seeding](#seeding)
- [Defining a schema](#defining-a-schema)
- [Querying](#querying)
- [Joins](#joins)
- [Grouping](#grouping)
- [Query plans](#query-plans)
- [Transactions](#transactions)
- [Events and the query log](#events-and-the-query-log)
- [Multiple tabs](#multiple-tabs)
- [Connections](#connections)
- [Storage quota](#storage-quota)
- [Reserved tables](#reserved-tables)
- [Exceptions](#exceptions)
- [Testing](#testing)

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
            seeders   : [UserSeeder],
            strict    : true,
        },
    },
});

await DB.migrate('app');
```

`User` is your own interface describing a row of the table. Nothing in this package generates it,
and every example below passes it as `DB.table<User>('users')` so the builder can type its
constraints, its return values and its aggregate keys.

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

The connection name is **required** here. Every method whose subject is the connection itself names
it rather than falling back to the default, since a silent fallback would migrate, seed or delete the
wrong database. That covers `migrate`, `seed`, `fresh`, `status`, `disconnect` and `purge`. The
table-level helpers still default, because there the subject is the table:

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
start over, `DB.fresh(name)` deletes the database and replays every migration.

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

A migration runs inside the version-change transaction, and IndexedDB commits a transaction the
moment its request queue drains. So a migration may **only** await operations from this package.
Awaiting `Schema.*` and `DB.table(...)` is safe. Awaiting a `fetch`, a timer, or any other promise
ends the transaction, and the next schema call throws `MigrationTransactionClosedException`.

If you need data from the network, that is what a seeder is for. See [Seeding](#seeding).

#### Migration status

```ts
await DB.status('app');
```

Resolves to one entry per registered migration:

```
[
    { migration: 'CreateUsersTable', ran: true, at: '2026-08-27T21:00:00.000Z' },
    { migration: 'AddRoleToUsersTable', ran: false, at: null }
]
```

`DB.status(name)` never migrates as a side effect, so you can call it before `DB.migrate(name)` to
see what is pending.

> Modelled on Laravel's [Migrations](https://laravel.com/docs/12.x/migrations). These only run
> forward, and they are registered in the connection config rather than discovered from a directory.

### Seeding

> **Use this for development, demos and tests, not for state your app ships and users edit.** A
> seeder cannot tell a row the user deleted from a row it never wrote, so re-running one puts back
> data the user removed on purpose. Recording that a seeder ran does not fix it. See
> [why seeding fits development better](#why-seeding-fits-development-better) for what to do instead.

Seeding is a separate step from migrating, and deliberately so. A migration runs inside the version
change transaction and therefore cannot await a `fetch`. A seeder runs outside it, so it can await
anything at all, which makes it the right home for any seed data that comes off the network.

```ts
import { DB, Seeder } from '@bjnstnkvc/db';

class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        const fetched: User[] = await (await fetch('/users.json')).json();

        await DB.table<User>('users').insert(fetched);
    }
}
```

Register the seeders on the connection and run them when you want to:

```ts
await DB.seed('app');
```

Resolves to the names of the seeders that ran:

```
['UserSeeder']
```

`DB.seed(name)` opens the connection first, which migrates it, so the tables a seeder writes to are
guaranteed to exist. The connection name is required for the same reason it is on `migrate`.

#### Which connection a seeder writes to

For the duration of the run, the connection being seeded **stands in as the default**. So a seeder
registered on `reporting` that calls `DB.table('users')` writes to `reporting`, not to the
configured default, and the previous default is restored when the run finishes or fails. Laravel's
[`SeedCommand`](https://laravel.com/docs/12.x/seeding#running-seeders) does the same thing.

Naming a connection explicitly still wins, so a seeder may reach across:

```ts
await DB.connection('app').table<User>('users').insert({ name: 'Alice' });
```

One consequence worth knowing: while a seed run is in flight, `DB.table(...)` anywhere in the app
resolves to the connection being seeded. Seeding at boot, before the rest of the app starts, keeps
that from mattering.

#### Seeders are not recorded

Unlike migrations, nothing records that a seeder ran. Every call to `DB.seed(name)` runs every
registered seeder again, which matches [Laravel](https://laravel.com/docs/12.x/seeding) and keeps
the surface small.

This is the one place where a browser differs from a server in a way that bites. On a server
`db:seed` is a command someone runs. In an app, boot happens on every refresh. Migrations are safe
there, since the database is already at the version its migrations ask for and nothing runs. Seeding
has no such guard, so a seeder inserting two rows leaves four after the second refresh and six after
the third.

There are two ways to handle it, and they answer different questions.

**Seed only a database that has never been migrated.** `DB.status` reads the stored version without
migrating, so it can be asked before `DB.migrate` whether this is a first run:

```ts
const status: MigrationStatus[] = await DB.status('app');
const fresh: boolean = status.every((entry: MigrationStatus): boolean => !entry.ran);

await DB.migrate('app');

if (fresh) {
    await DB.seed('app');
}
```

Do not use `DB.migrate`'s return value for this. It reports the migrations that call ran, so it is
non-empty for an existing user whenever you add a table, and they would be seeded again. Note also
that this seeds a new database only, so a seeder you add later never reaches anyone who already has
the app.

**Or write seeders that do not care how often they run.** This is the better answer for reference
data, and it keeps working when you add a seeder later. `upsert` against a unique index, or
`insertOrIgnore`, makes a second run a no-op:

```ts
class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        await DB.table<User>('users').upsert([
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
    override async run(): Promise<void> {
        await DB.transaction(async (transaction: Transaction): Promise<void> => {
            await transaction.table<User>('users').insert({ name: 'Alice' });
            await transaction.table('posts').insert({ user_id: 1, title: 'Hello' });
        });
    }
}
```

#### Why seeding fits development better

Everything above makes a seeder safe to run repeatedly. None of it makes a seeder safe to run
against data a user owns, and that limit is structural rather than a gap in this package.

A seeder cannot distinguish a row the user deleted from a row it never wrote, because both are
simply absent. An idempotent seeder therefore puts back whatever the user removed.

The examples below share these shapes. `settings` holds the configuration, `seeds` records which
seeder last ran and what it wrote, and `dismissed` records the keys the user removed on purpose:

```ts
interface Setting {
    id: number;
    key: string;
    value: string;
}

interface Seed {
    seeder: string;
    digest: string;
}

interface Dismissed {
    key: string;
}

type Default = Omit<Setting, 'id'>;

const DEFAULTS: Default[] = [
    { key: 'theme', value: 'dark' },
    { key: 'locale', value: 'en' },
];

const DIGEST: string = 'v1';
```

Those three are your tables, so a migration creates them like any other. This package creates only
`migrations` and `schema`, which is why those two names are [reserved](#reserved-tables) and nothing
else is made for you:

```ts
class CreateSettingsTables extends Migration {
    /**
     * Run the migration.
     */
    override async up(): Promise<void> {
        await Schema.create('settings', (table: Blueprint): void => {
            table.id();
            table.string('key').unique();
            table.string('value');
        });

        await Schema.create('seeds', (table: Blueprint): void => {
            table.string('seeder').primary();
            table.string('digest');
        });

        await Schema.create('dismissed', (table: Blueprint): void => {
            table.string('key').primary();
        });
    }
}
```

The indexes are not decoration. `upsert` needs its conflict target to be the key path or a unique
index, so `key` on `settings` is unique and `seeder` and `key` are the key paths of the other two.
Without them each `upsert` below would throw `SchemaException`.

Suppose a seeder installs those defaults, and records the digest so it re-runs only when they
actually change:

```ts
class ConfigSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        const seen: Seed | null = await DB.table<Seed>('seeds').find('ConfigSeeder');

        if (seen !== null && seen.digest === DIGEST) {
            return;
        }

        await DB.table<Setting>('settings').upsert(DEFAULTS, 'key');
        await DB.table<Seed>('seeds').upsert([{ seeder: 'ConfigSeeder', digest: DIGEST }], 'seeder');
    }
}
```

That holds up until the next time the defaults change:

```
boot 1, seeder v1     ['locale', 'theme']
boot 2, unchanged     ['locale', 'theme']
user deletes locale   ['theme']
boot 3, seeder v2     ['currency', 'locale', 'theme']
```

Adding `currency` re-ran the seeder, and `locale` came back with it. A ledger only defers the
problem to the next release, which is why this package does not ship one.

There are two ways out, and neither of them is a seeder.

**Keep the defaults in code.** Store only what the user changed, and merge when reading:

```ts
async function settings(): Promise<Record<string, string>> {
    const defaults: Record<string, string> = Object.fromEntries(
        DEFAULTS.map((row: Default): [string, string] => [row.key, row.value]),
    );

    const overrides: Record<string, string> = await DB.table<Setting>('settings').pluck<string>('value', 'key');

    return { ...defaults, ...overrides };
}
```

Deleting is then an explicit override rather than an absent row, so nothing can resurrect it, and a
new default ships with the app instead of needing a data migration. The cost is that defaults are
not rows, so a query cannot filter or join across them.

**Or record what the user dismissed.** Keep the rows in the table, and have the seeder skip anything
the user removed on purpose:

```ts
class ConfigSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        const dismissed: string[] = await DB.table<Dismissed>('dismissed').pluck<string>('key');
        const wanted: Default[] = DEFAULTS.filter((row: Default): boolean => !dismissed.includes(row.key));

        await DB.table<Setting>('settings').upsert(wanted, 'key');
    }
}
```

Your delete handler writes to `dismissed` as well as removing the row. The seeder is then free to
run on every boot, because the user's intent is recorded rather than inferred. A `source` column
marking which rows the seeder owns pairs well with this, so a seeder never overwrites something the
user authored.

Seeding stays the right tool where nobody has edited the data yet: fixtures in tests, demo data
behind a developer menu, and one-shot imports where deleting a row carries no meaning.

#### Rebuilding from scratch

`DB.fresh(name)` deletes the database and replays the migrations. Pass `{ seed: true }` to seed it
afterwards as well, the way [`migrate:fresh --seed`](https://laravel.com/docs/12.x/migrations#refreshing-the-database)
does in Laravel:

```ts
await DB.fresh('app');
await DB.fresh('app', { seed: true });
```

> Modelled on Laravel's [Database: Seeding](https://laravel.com/docs/12.x/seeding), down to the
> seeded connection standing in as the default for the duration of the run.

### Defining a schema

IndexedDB stores whole objects and enforces only a key path, `autoIncrement` and indexes. Column
types are recorded as metadata and enforced by this package at write time.

| Blueprint | Effect |
| --- | --- |
| `table.id()` | `keyPath: 'id'`, `autoIncrement: true` |
| `table.uuid('id').primary()` | `keyPath: 'id'`, no autoIncrement |
| `table.string` / `integer` / `float` / `boolean` / `date` / `datetime` / `json` | Column metadata |
| `table.decimal('price', 2)` | Column metadata, stored as a whole number of the smallest unit |
| `table.enum('role', Role)` | Column metadata, checked at write time. Takes a list, an enum or a constant object |
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

#### Fixed point columns hold their smallest unit

`table.decimal` records a scale and stores the value as a plain integer counting the smallest unit
that scale describes. A price with two places is written as 1999, not 19.99:

```ts
interface Product {
    id: number;
    name: string;
    price: number;
    weight: number;
}

await Schema.create('products', (table: Blueprint): void => {
    table.id();
    table.string('name');
    table.decimal('price');
    table.decimal('weight', 3);
});

await DB.table<Product>('products').insert({ name: 'Keyboard', price: 1999, weight: 1250 });
```

Writing a fractional value throws, because rounding it silently is how money goes missing:

```ts
await DB.table<Product>('products').insert({ name: 'Keyboard', price: 19.99 });
```

```
TypeError: A decimal column stores a whole number of its smallest unit, so [19.99] cannot be
written. Scale it first, as in Math.round(19.99 * 100).
```

The reason for the integer is that JavaScript has one number type and it is a float, so 0.1 + 0.2
is not 0.3. Every sum, every `orderBy` against an index and every `between` range would inherit
that error. An integer number of pence has none of it, and IndexedDB orders integers exactly.

Scale on the way in and format on the way out. The declared scale is metadata, so a formatter can
read it back from `Schema.getColumns` rather than hardcoding the same 100 in two places:

```ts
const columns: ColumnSchema[] = await Schema.getColumns('products');
const places: number = columns.find((column: ColumnSchema): boolean => column.name === 'price')!.places!;

const money = (minor: number): string => (minor / 10 ** places).toFixed(places);
```

A loose connection rounds instead of throwing, in keeping with every other coercion.

#### Enumerated columns are checked on the way in

`table.enum` stores a string and refuses anything outside the declared list:

```ts
await Schema.create('users', (table: Blueprint): void => {
    table.id();
    table.string('email').unique();
    table.enum('role', ['admin', 'editor', 'member']).default('member');
    table.enum('tier', ['free', 'paid']).nullable();
});

await DB.table<User>('users').insert({ email: 'john@example.com', role: 'owner' });
```

```
CheckConstraintViolationException: Column [role] of table [users] does not accept [owner].
It accepts [admin, editor, member].
```

The check runs on `insert`, `update` and `upsert`, and applies to a nullable column too: null is
accepted, an undeclared value is not. A loose connection writes null instead of throwing, so a
non-nullable enumerated column still reports the problem as
`NotNullConstraintViolationException`.

Declaring one over an empty list throws `SchemaException` at migration time, since nothing could
ever be written to it.

The list can come from a TypeScript string enum or an `as const` object instead, which keeps the
values in one place and lets the compiler check them at the call site:

```ts
enum Role {
    Admin  = 'admin',
    Editor = 'editor',
    Member = 'member',
}

await Schema.create('users', (table: Blueprint): void => {
    table.enum('role', Role).default(Role.Member);
});
```

The column stores the enum's **values**, never its keys, so `Role.Admin` is written as `admin`. Two
members sharing a value collapse to one, since a duplicate would otherwise reach anything rendering
the column.

A **numeric** enum is refused. TypeScript compiles one to an object carrying a reverse mapping, so
its runtime values are both the names and the numbers, and there is no string form worth storing:

```ts
enum Status {
    Draft,
    Live,
}

table.enum('status', Status);
```

```
SchemaException: Column [status] of table [items] is enumerated over a numeric enum, which has no
string form to store. Give the enum string values, or use integer() instead.
```

The declared values are metadata, so a form can read them back rather than repeating the list:

```ts
const columns: ColumnSchema[] = await Schema.getColumns('users');
const roles: string[] = columns.find((column: ColumnSchema): boolean => column.name === 'role')!.values!;
```

TypeScript is not involved in the check. Narrow the column to a union on your row type if you want
the compiler to help as well:

```ts
interface User {
    // ...
    role: 'admin' | 'editor' | 'member';
}
```

#### Schema outside a migration

`Schema.create`, `Schema.table`, `Schema.drop`, `Schema.dropIfExists` and `Schema.rename` need the
version-change transaction, so they only run **inside a migration** and throw `SchemaException`
anywhere else. This is a real divergence from Laravel, where
[`Schema::create()`](https://laravel.com/docs/12.x/migrations#creating-tables) works from anywhere.

The read side works anywhere:

```ts
await Schema.hasTable('users');
await Schema.hasColumn('users', 'email');
await Schema.getTables();
await Schema.getColumns('users');
await Schema.getIndexes('users');
await Schema.connection('reporting').hasTable('reports');
```

> Modelled on Laravel's [Migrations: Tables](https://laravel.com/docs/12.x/migrations#tables).
> Column types are metadata this package enforces at write time, since IndexedDB stores whole objects
> and checks nothing itself.

### Querying

Every chained method returns the builder straight away. Only a terminal returns a promise.

```ts
const users: User[] = await DB.table<User>('users')
    .where('age', '>=', 18)
    .whereIn('role', ['admin', 'owner'])
    .whereNotNull('email')
    .orderBy('created_at', 'desc')
    .limit(10)
    .get();
```

#### Constraints

`where` takes four forms: a column and a value for an implicit `=`, a column with an explicit
operator, an object of column-value pairs, and a closure that opens a nested group.

```ts
DB.table<User>('users')
    .where('name', 'John')
    .where('age', '>=', 18)
    .where({ role: 'admin', age: 30 })
    .where((query: Builder<User>): void => {
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

Every one of these has an `or` form too: `orWhere`, `orWhereIn`, `orWhereNotIn`, `orWhereNull`,
`orWhereNotNull`, `orWhereBetween`, `orWhereNotBetween`, `orWhereLike`, `orWhereNotLike` and
`orWhereColumn`, so a disjunction no longer needs a nested closure.

Operators: `=`, `==`, `===`, `!=`, `<>`, `!==`, `<`, `>`, `<=`, `>=`, `like`, `not like`. `==` is
loose and `===` is strict.

Constraints follow SQL's three-valued logic: a comparison against `null` is unknown, and negating
unknown leaves it unknown. So a record whose `age` is `null` satisfies neither
`whereBetween('age', [18, 65])` nor `whereNotBetween('age', [18, 65])`. Only `whereNull` matches it.

`like` and `not like` take SQL's wildcards, where `%` matches any run of characters and `_` matches
exactly one. Both are case insensitive, both cross newlines, and a backslash escapes a wildcard so
`'100\\%'` matches a literal percent. Everything else in the pattern is a literal, so a pattern full
of regular expression syntax matches only itself.

The pattern is matched by a direct scan rather than a regular expression, which matters if your
patterns come from a search box. A regular expression compiled from `%%%%%` backtracks over every
way of splitting the value between the wildcards, and that is exponential in their number. The scan
walks the value once per wildcard instead, so a hostile or careless pattern costs time in proportion
to its length rather than freezing the tab.

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
await DB.table<User>('users').get();
await DB.table<User>('users').first();
await DB.table<User>('users').firstOrFail();
await DB.table<User>('users').find(1);
await DB.table<User>('users').findOrFail(1);
await DB.table<User>('users').value('email');
await DB.table<User>('users').pluck('email');
await DB.table<User>('users').pluck('email', 'name');
await DB.table<User>('users').exists();
await DB.table<User>('users').doesntExist();
await DB.table<User>('users').count();
await DB.table<User>('users').sum('age');
await DB.table<User>('users').avg('age');
await DB.table<User>('users').min('age');
await DB.table<User>('users').max('age');
```

| Terminal | Resolves to |
| --- | --- |
| `get()` | `T[]` |
| `first()` | `T` or `null` |
| `firstOrFail()` | `T`, or throws `RecordsNotFoundException` |
| `find(key)` | `T` or `null`, by point lookup on the key path |
| `findOrFail(key)` | `T`, or throws `RecordsNotFoundException` |
| `value(column)` | The column of the first matching record, or `null` |
| `pluck(column)` | `V[]` in result order |
| `pluck(column, key)` | `Record<string, V>`, keyed by a second column |
| `exists()` / `doesntExist()` | `boolean` |
| `count()` | `number` |
| `sum(column)` | `number` |
| `avg(column)` / `min(column)` / `max(column)` | `number` or `null` when nothing matched |
| `sole()` | `T`, or throws `RecordsNotFoundException` / `MultipleRecordsFoundException` |
| `paginate(page?, perPage?)` | `{ data, total, perPage, currentPage, lastPage }` |

`min` and `max` read the answer straight off the index when the column has one and the query is
unconstrained, so they cost one cursor rather than a full scan.

`paginate` gives you the totals a pager needs, which `forPage` cannot, and counts what the query
matches rather than what the page returns:

```ts
const page = await DB.table<User>('users').orderBy('name').paginate(2, 15);
```

```
{ data: [ ... ], total: 132, perPage: 15, currentPage: 2, lastPage: 9 }
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

> Modelled on Laravel's [Database: Query Builder](https://laravel.com/docs/12.x/queries). The method
> names and their semantics match, and every terminal is asynchronous because IndexedDB is.

### Joins

```ts
const rows = await DB.table('users')
    .join('posts', 'users.id', '=', 'posts.user_id')
    .where('users.name', 'John')
    .orderBy('posts.created_at', 'desc')
    .get();
```

`join`, `leftJoin`, `rightJoin` and `crossJoin` are available. The operator may be left implicit:

```ts
await DB.table('users').join('posts', 'users.id', 'posts.user_id').get();
```

For more than one condition, pass a closure:

```ts
await DB.table('users')
    .join('posts', (join: Join): void => {
        join.on('users.id', '=', 'posts.user_id').on('posts.published', '=', 'users.active');
    })
    .get();
```

#### The row is flat, and collisions clobber

A joined row is flattened the way SQL hands it back, so a column present on both tables keeps the
value from the table joined later:

```ts
const row = await DB.table('users').join('posts', 'users.id', '=', 'posts.user_id').first();
```

```
{ id: 3, name: 'John', user_id: 2, title: 'Hello' }
```

That `id` is `posts.id`. Since `table.timestamps()` gives every table a `created_at` and an
`updated_at`, collisions are the norm rather than the exception on a join. `select` with an alias is
how both sides survive:

```ts
const rows = await DB.table('users')
    .join('posts', 'users.id', '=', 'posts.user_id')
    .select('users.id as user_id', 'posts.id as post_id', 'posts.title')
    .get();
```

```
[
    { user_id: 1, post_id: 1, title: 'Hello' }
]
```

`as` works on any query, joined or not.

#### Ambiguous columns are rejected, not guessed

Once a join is in play, a bare column name that two tables share cannot be resolved, so it throws
`SchemaException` naming the tables rather than silently picking one:

```ts
await DB.table('users').join('posts', 'users.id', '=', 'posts.user_id').where('id', 1).get();
```

```
SchemaException: Column [id] is ambiguous across tables [users, posts]. Qualify it, as in [users.id].
```

A bare column only one table has still resolves, so `where('title', 'Hello')` is fine. Naming a
table the query does not join, or a column no table has, throws in the same way.

#### A left join nulls the missing side

Every column of the unmatched table comes back `null`, as in SQL, which makes the usual
find-the-orphans query work:

```ts
await DB.table('users')
    .leftJoin('posts', 'users.id', '=', 'posts.user_id')
    .whereNull('posts.id')
    .get();
```

#### What joins cost, and what they do not support

IndexedDB has no join, so every one is performed in memory. A single equality condition uses a hash
join, and anything else falls back to a nested loop. The `where` clauses still narrow each table through
the planner, but the join itself reads both sides in full, so memory is proportional to the tables
involved. That is fine at the data volumes a browser holds, and worth knowing before joining two
large tables.

Joined queries are **read-only**. `update`, `delete`, `insert` and `upsert` are not supported through
a join. `orderBy` on a joined query always sorts in memory, since the row is synthesised and no index
covers it, and `chunk` slices the materialised result rather than walking keys.

`whereColumn` compares two columns of the same row, and is available on any query:

```ts
await DB.table('users').whereColumn('updated_at', '>', 'created_at').get();
```

> Modelled on Laravel's [Query Builder: Joins](https://laravel.com/docs/12.x/queries#joins). Rows
> stay flat as they do in Laravel, and the join itself runs in memory because IndexedDB has none.

### Grouping

Laravel spells aggregates as [raw SQL](https://laravel.com/docs/12.x/queries#raw-methods), which has
nothing to hand a string to here. So the aggregates are named in an object instead, and the alias
becomes the key:

```ts
const rows = await DB.table<User>('users')
    .where('active', true)
    .groupBy('role')
    .aggregate({
        total : { count: '*' },
        oldest: { max: 'age' },
    })
    .having('total', '>', 5)
    .orderBy('total', 'desc')
    .get();
```

Resolves to one row per group, carrying the grouped columns and the aggregates:

```
[
    { role: 'member', total: 12, oldest: 61 },
    { role: 'admin', total: 7, oldest: 44 }
]
```

Because the alias is an object key rather than a string inside an expression, the result type is
inferred rather than cast. That row is typed `{ role: string; total: number; oldest: number | null }`,
and reading a column you did not group or aggregate is a compile error.

| Aggregate | Meaning |
| --- | --- |
| `{ count: '*' }` | The number of records in the group, always a `number` |
| `{ count: 'column' }` | The number of records whose column is not null |
| `{ sum: 'column' }` | The total, `0` for a group with no values |
| `{ avg: 'column' }` | The mean, `null` for a group with no values |
| `{ min: 'column' }` / `{ max: 'column' }` | The extreme, `null` for a group with no values |

Group by several columns by passing several names:

```ts
await DB.table<User>('users').groupBy('team', 'role').aggregate({ total: { count: '*' } }).get();
```

`aggregate()` is optional. Grouping with nothing aggregated gives you one row per distinct
combination, which is what `distinct()` does over the same columns.

#### having, ordering and paging apply to groups

`having` and `orHaving` filter the grouped rows, and take the same operators as `where`. They can
name either a grouped column or an aggregate alias, since by then both are just columns on the row.

`orderBy`, `limit` and `offset` on a grouping apply to **groups**, not records. Any ordering or
paging set before `groupBy` is dropped, because paging records before grouping them is almost never
what you meant:

```ts
await DB.table<User>('users')
    .groupBy('role')
    .aggregate({ total: { count: '*' } })
    .orderBy('total', 'desc')
    .limit(3)
    .get();
```

Grouping happens in memory after the records are fetched, so the planner still applies to the
`where` clauses that select them, and a grouped query reports the plan of that underlying fetch.

> Modelled on Laravel's [Query Builder: Grouping](https://laravel.com/docs/12.x/queries#groupby-having),
> with the aggregates named in a typed object instead of raw SQL.

### Query plans

The builder does not fetch everything and filter in memory. It compiles your constraints into an
IndexedDB key range over one index, plus a residual predicate applied while cursoring:

```ts
await DB.table<User>('users').where('id', 1).explain();
await DB.table<User>('users').where('email', 'a@b.c').explain();
await DB.table<User>('users').where('role', 'admin').explain();
```

Each resolves to a description of the plan chosen:

```
'key'
'index:users_email_unique'
'scan'
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

> Modelled on Laravel's [Database: Transactions](https://laravel.com/docs/12.x/database#database-transactions).
> The tables have to be declared up front, because an IndexedDB transaction fixes its scope when it
> opens.

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
```

Resolves to one entry per query that ran while the log was enabled:

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

> Modelled on Laravel's [Database: Listening for Query Events](https://laravel.com/docs/12.x/database#listening-for-query-events),
> with the same enable, get and flush surface, dispatched as a browser event.

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
DB.connection();
DB.connection('reporting');
DB.disconnect('app');
DB.purge('app');
```

| Call | Effect |
| --- | --- |
| `connection()` | The default connection |
| `connection(name)` | A named connection, cached after the first resolve |
| `disconnect(name)` | Close the handle, leaving the connection registered so the next query reopens it |
| `purge(name)` | Close it and drop it, so the next resolve rebuilds it from configuration |

> Modelled on Laravel's [Database: Multiple Connections](https://laravel.com/docs/12.x/database#using-multiple-database-connections),
> resolved by name and cached, with one IndexedDB database behind each.

### Storage quota

A browser gives each origin a finite storage budget, and a write that exceeds it fails. This is the
likeliest failure a client-side database hits in production, and it has no equivalent in a server
database, so it is worth handling explicitly.

The platform reports it as a bare `DOMException` whose message says nothing about the fix. This
package names it instead:

```ts
try {
    await DB.table<User>('users').insert(records);
} catch (error) {
    if (error instanceof QuotaExceededException) {
        const { usage, quota } = await DB.estimate();

        console.warn(`Using ${usage} of ${quota} bytes.`);
    }
}
```

`QuotaExceededException` is raised from any operation the quota stops, including one that aborts a
transaction, so a single `catch` around a transaction covers everything inside it.

#### Asking not to be evicted

Browsers evict an origin's IndexedDB under storage pressure. If that happens, your migrations replay
against an empty database on the next boot and the data is simply gone. `DB.persist()` asks the
browser to exempt this origin:

```ts
await DB.persist();     // true when the browser agreed
await DB.persisted();   // true when this origin is already exempt
```

Whether the request is granted is up to the browser and depends on things like whether the site is
installed or has engagement history. Any app storing data it cares about should ask at boot.

`DB.estimate()` wraps `navigator.storage.estimate()`, and reports `{}` where the Storage Manager is
not available rather than throwing.

### Reserved tables

`migrations` and `schema` are reserved. A migration that tries to create either throws
`ReservedTableException`. Column metadata is read from `schema` once per connection and cached in
memory, so writes inside a narrowed transaction still get their defaults.

### Exceptions

Every exception extends `Error` and sets its own `name`, so `instanceof` and the stack both read
true. All of them are exported from the package root.

| Exception | Thrown when |
| --- | --- |
| `CheckConstraintViolationException` | A write gives an enumerated column a value it does not accept |
| `ConnectionNotConfiguredException` | A connection is resolved under a name `DB.configure` never declared |
| `DatabaseBlockedException` | Another tab holds the database open at an older version, so the upgrade cannot start |
| `MigrationMismatchException` | The recorded migration list is not a prefix of the registered one, so one was removed, renamed or reordered |
| `MigrationTransactionClosedException` | A migration awaited something outside this package, letting the versionchange transaction commit early |
| `MultipleRecordsFoundException` | `sole()` matched more than one record |
| `NotNullConstraintViolationException` | A non-nullable column is written as null, or is absent with no default |
| `QuotaExceededException` | The origin's storage quota stopped the operation |
| `RecordsNotFoundException` | `firstOrFail()`, `sole()` or `findOrFail()` matched nothing |
| `ReservedTableException` | A migration tries to create `migrations` or `schema` |
| `SchemaException` | A schema or query call the shape of the database cannot support |
| `TableNotFoundException` | A query or schema read names a table the database does not have |
| `UniqueConstraintViolationException` | A write collides with a unique index, named in the message |

`SchemaException` is the broad one, so here is every case that raises it:

- `Schema.create`, `table`, `drop`, `dropIfExists` or `rename` called outside a migration
- `Schema.create` on a table that already exists, or `Schema.rename` onto a name already taken
- dropping or renaming the key path, which IndexedDB fixes when the store is created
- declaring the same column, or the same index name, twice on one blueprint, or adding a column
  that the table already has
- declaring more than one primary column, including `.primary()` alongside `table.id()`
- dropping or renaming a column, or dropping an index, that does not exist on the table
- declaring an enumerated column over an empty list of values
- `upsert` whose conflict target is neither the key path nor a unique index
- `update`, `upsert`, `increment` or `decrement` touching the key path
- a qualified column naming a table the query does not join
- an unqualified column that is ambiguous across the tables a join reads
- a column that exists on none of the tables the query reads
- reading a table inside `DB.transaction` that the transaction did not declare

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
