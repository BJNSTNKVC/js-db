# Configuration

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
            timezone  : 'UTC',
        },
    },
});

await DB.migrate('app');
```

`User` is your own interface describing a row of the table. Nothing in this package generates it,
and every example in these docs passes it as `DB.table<User>('users')` so the builder can type its
constraints, its return values and its aggregate keys.

| Option                         | Meaning                                                                                                    |
|--------------------------------|------------------------------------------------------------------------------------------------------------|
| `default`                      | The connection used when none is named                                                                     |
| `connections[name].database`   | The IndexedDB database name                                                                                |
| `connections[name].migrations` | Ordered migration classes. Their order **is** the schema version.                                          |
| `connections[name].seeders`    | Ordered seeder classes, run by `DB.seed(name)`. See [Seeding](seeding.md).                                 |
| `connections[name].strict`     | Defaults to `true`. Missing required values and values a column cannot store throw. `false` writes `null`. |
| `connections[name].timezone`   | Defaults to `'UTC'`. The timezone every calendar day and time of day is read and stored in.                |

A strict connection stores a value only when its column can hold it faithfully, so an empty form
field never becomes 0 and a fraction never loses its digits unseen. The rules for each column type
are in [Coercion on the way in](querying.md#coercion-on-the-way-in).

A `Date` is a moment and holds no timezone, so the calendar day it falls on and the time of day it
shows depend on where it is read. `timezone` names that place for the connection, so every device
gives the same answer: `'UTC'` by default, `'local'` for the timezone of the device running the
code, or an IANA name such as `'America/New_York'`. It decides the moment a date-only string such as
`'2024-01-15'`, or a date and time without an offset, is stored as, and the day and time
`whereDate`, `whereYear`, `whereMonth`, `whereDay` and `whereTime` read. A `Date`, and a string
with `Z` or an offset, keep naming their own moment under every setting. `DB.configure` throws
`RangeError` for a name the browser does not know, naming the connection, and leaves the
configuration before it in place. `DB.connection(name).timezone` gives the name the connection reads,
as `Intl` spells it, so `'utc'` reads as `'UTC'`. [Dates and timezones](querying.md#dates-and-timezones)
has the details. Before 8.0.0 the date parts, `whereTime` and `whereDate` read the device's timezone,
as `'local'` still does.

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

## Connections

```ts
DB.connection();
DB.connection('reporting');
DB.disconnect('app');
DB.purge('app');
```

| Call               | Effect                                                                           |
|--------------------|----------------------------------------------------------------------------------|
| `connection()`     | The default connection                                                           |
| `connection(name)` | A named connection, cached after the first resolve                               |
| `disconnect(name)` | Close the handle, leaving the connection registered so the next query reopens it |
| `purge(name)`      | Close it and drop it, so the next resolve rebuilds it from configuration         |

> Modeled on Laravel's [Database: Multiple Connections](https://laravel.com/docs/12.x/database#using-multiple-database-connections),
> resolved by name and cached, with one IndexedDB database behind each.
