# Defining a schema

IndexedDB stores whole objects and enforces only a key path, `autoIncrement` and indexes. Column
types are recorded as metadata and enforced by this package at write time, as
[Coercion on the way in](querying.md#coercion-on-the-way-in) describes.

| Blueprint                                                                       | Effect                                                                             |
|---------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| `table.id()`                                                                    | `keyPath: 'id'`, `autoIncrement: true`                                             |
| `table.uuid('id').primary()`                                                    | `keyPath: 'id'`, no autoIncrement                                                  |
| `table.string` / `integer` / `float` / `boolean` / `date` / `datetime` / `json` | Column metadata                                                                    |
| `table.decimal('price', 2)`                                                     | Column metadata, stored as a whole number of the smallest unit                     |
| `table.enum('role', Role)`                                                      | Column metadata, checked at write time. Takes a list, an enum or a constant object |
| `.nullable()`                                                                   | Metadata, enforced at write time                                                   |
| `.default(value)`                                                               | Applied at write time, and backfilled when added to an existing table              |
| `.primary()`                                                                    | Makes the column the key path. At most one per table.                              |
| `.index()`                                                                      | `createIndex('users_name_index', 'name')`                                          |
| `.unique()`                                                                     | `createIndex('users_email_unique', 'email', { unique: true })`                     |
| `table.index(['a', 'b'])`                                                       | Compound index                                                                     |
| `.multiEntry()`                                                                 | One index entry per array element, which `whereJsonContains` reads                 |
| `table.timestamps()`                                                            | Nullable `created_at` / `updated_at`, filled automatically                         |
| `.change()`                                                                     | Inside `Schema.table`, replaces the existing column of the same name               |

Altering a table also supports `dropColumn`, `renameColumn`, `dropIndex`, `change()` and
`Schema.rename`. The key path may not be dropped, renamed or changed, because IndexedDB fixes it when
the store is created.

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.dropColumn('legacy');
    table.renameColumn('name', 'full_name');
    table.dropIndex('users_age_index');
    table.index(['email', 'full_name']);
});
```

`Schema.rename` is implemented as create-copy-drop, so it is O(n) in the number of records.

## Multi-entry indexes serve whereJsonContains

`.multiEntry()` gives a column holding arrays one index entry per distinct element, rather than one
per record. `whereJsonContains` with a single string or number reads through it, visiting only the
records whose array holds that element, each once however often the array repeats it:

```ts
await Schema.create('posts', (table: Blueprint): void => {
    table.id();
    table.json('tags').multiEntry();
});

await DB.table<Post>('posts').whereJsonContains('tags', 'news').get();
```

No other query uses it. `where`, `whereIn`, `whereBetween` and the comparison operators compare the
whole value, and `orderBy` sorts by it, which an index of single elements cannot answer, so they read
the table as they would with no index. `min` and `max` read the records too.
[Query plans](query-plans.md) lists the `whereJsonContains` values the index serves.

## Adding columns

A column declared inside `Schema.table` without `.change()` is added to the table, and the rows it
already holds are brought into line in the same migration:

| Added column                   | What happens to the rows                                                                                |
|--------------------------------|---------------------------------------------------------------------------------------------------------|
| With `.default(value)`         | A row without a value takes the default, and so does a row holding `null` unless the column is nullable |
| `.nullable()`, with no default | The rows are left as they are                                                                           |
| Required, with no default      | Any row that would hold no value fails the migration                                                    |

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.string('role').default('member');
    table.string('nickname').nullable();
    table.integer('level');
});
```

On a table holding three rows, the required `level` fails the whole migration:

```
SchemaException: Column [level] of table [users] cannot be added as required without a default,
because it would hold no value in 3 rows.
```

The rule holds on a loose connection too, since strictness only governs the values a write
coerces. An empty table takes the column, so a fresh install, which runs every migration against
empty tables, is unaffected. A row that already holds a value under the name, written before the
column was declared, counts as filled. When one call adds several such columns, the message names
each one some row would lack and counts the rows lacking any of them. A column dropped or renamed in
the same blueprint frees its name, and a column added under that name starts empty, so the rows
take its default or, without one, fail the migration.

Each `Schema.table` call is checked on its own, so a default given by a later call in the same
migration comes too late. Declare the default with the column, or add it as nullable and make it
required with [`.change()`](#changing-columns) once every row holds a value.

Before 4.0.0 such a column was added anyway, leaving every row already in the table without a value.
A migration shipped before 4.0.0 that adds one, and has not yet run on some device, now fails there
when the table holds rows. Give the column a default or make it nullable.

## Indexes follow renamed and dropped columns

IndexedDB cannot change the columns an index covers, so `renameColumn` and `dropColumn` rebuild or
delete the indexes over the column in the same migration:

| Index over the column                      | `renameColumn('email', 'mail')`                            | `dropColumn('email')`                |
|--------------------------------------------|------------------------------------------------------------|--------------------------------------|
| `users_email_unique`, a generated name     | Rebuilt over `mail` as `users_mail_unique`                 | Deleted with the column              |
| `by_email`, a name chosen by hand          | Rebuilt over `mail`, keeping the name `by_email`           | Deleted with the column              |
| `users_team_email_index`, a compound index | Rebuilt over `['team', 'mail']` as `users_team_mail_index` | Refused while it still covers `team` |

A rebuilt index keeps its other columns, their order, and whether it is unique or multi entry, so a
unique rule holds under the new name and `upsert(rows, 'mail')` accepts the column as its conflict
target. An index over columns the blueprint drops together is deleted with them.

Dropping a column that a compound index still needs would quietly lose that index's rule, so it is
refused with `SchemaException` and the migration rolls back:

```
SchemaException: Column [email] of table [users] may not be dropped while index
[users_team_email_index] covers it. Drop the index first.
```

Dropping the index first, in the same blueprint or an earlier one, lets the drop through:

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.dropIndex('users_team_email_index');
    table.dropColumn('email');
});
```

Before 2.6.1 both operations left the index over the old column, where no record holds a value any
more. A database that renamed or dropped an indexed column then keeps that stale index until a
migration drops it by name and declares the one intended:

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.dropIndex('users_email_unique');
    table.unique('mail');
});
```

`getIndexes()` lists what a table holds, so it shows whether a database needs the repair.

## Changing columns

Declaring a column again with `.change()` inside `Schema.table` replaces the existing declaration,
keeping the column where it stands among the others:

```ts
await Schema.table('users', (table: Blueprint): void => {
    table.string('nickname').nullable().change();
    table.integer('age').default(18).index().change();
    table.enum('role', ['admin', 'editor', 'member', 'owner']).default('member').change();
});
```

The new declaration is the whole of it, as in Laravel, so a modifier left out is removed rather than
kept. Changing `age` above without `.index()` would delete its index, and without `.default(18)`
would remove its default. Only the indexes over that column alone are redeclared this way. An index
spanning several columns is left as it is.

A change may make a column nullable or required, add, change or remove its default, change the
values an enum accepts, and add or remove `.index()` and `.unique()`. What the rows already hold is
checked in the same migration:

| Change                  | What happens to the rows                                                                        |
|-------------------------|-------------------------------------------------------------------------------------------------|
| Becoming required       | A row with no value takes the default. Without a default, any such row fails the migration      |
| Adding a default        | A row without the column takes the default. A row holding `null` keeps it                       |
| An enum dropping values | Any row still holding a dropped value fails the migration, since a replacement would be a guess |
| Adding `.unique()`      | Values repeated across rows fail the migration                                                  |

A failure throws `SchemaException` naming the table, the column and how many rows are in the way:

```
SchemaException: Column [age] of table [users] cannot be made required without a default,
because it holds no value in 3 rows.
```

Throwing aborts the migration's transaction, so the whole migration rolls back and nothing is left
half changed. The same check guards a unique index added with `table.unique()` inside
`Schema.table`, which is reported the same way rather than as IndexedDB's `ConstraintError`.

Three changes are refused with `SchemaException`:

- **The key path**, which IndexedDB fixes when the store is created. A column cannot become the key
  path through a change either.
- **The type.** Each pair of types would need its own conversion rules. Add a new column, copy the
  values across and drop the old one.
- **The scale of a decimal.** Stored values are whole numbers of the smallest unit, so 1999 at two
  places would silently read as 1.999 at three.

Changing a column that does not exist throws `SchemaException`, as `dropColumn` does.

> Modeled on Laravel's [Modifying Columns](https://laravel.com/docs/12.x/migrations#modifying-columns).

## Fixed point columns hold their smallest unit

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

A loose connection rounds instead of throwing, with `Math.round`, which takes a half toward the
larger number: 19.5 becomes 20 and -19.5 becomes -19. An `integer` column follows the same rule,
refusing a fraction under strict and rounding it when loose. See
[Coercion on the way in](querying.md#coercion-on-the-way-in) for every column type.

## Enumerated columns are checked on the way in

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

## Schema outside a migration

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

> Modeled on Laravel's [Migrations: Tables](https://laravel.com/docs/12.x/migrations#tables).
> Column types are metadata this package enforces at write time, since IndexedDB stores whole objects
> and checks nothing itself.

## Reserved tables

`migrations` and `schema` are reserved. A migration that tries to create either throws
`ReservedTableException`. Column metadata is read from `schema` once per connection and cached in
memory, so writes inside a narrowed transaction still get their defaults.
