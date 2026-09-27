# Seeding

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

## Which connection a seeder writes to

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

## Seeders are not recorded

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

## Why seeding fits development better

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
`migrations` and `schema`, which is why those two names are [reserved](schema.md#reserved-tables) and nothing
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

## Rebuilding from scratch

`DB.fresh(name)` deletes the database and replays the migrations. Pass `{ seed: true }` to seed it
afterwards as well, the way [`migrate:fresh --seed`](https://laravel.com/docs/12.x/migrations#refreshing-the-database)
does in Laravel:

```ts
await DB.fresh('app');
await DB.fresh('app', { seed: true });
```

> Modeled on Laravel's [Database: Seeding](https://laravel.com/docs/12.x/seeding), down to the
> seeded connection standing in as the default for the duration of the run.
