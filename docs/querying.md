# Querying

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

## Constraints

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

`whereAny`, `whereAll` and `whereNone` apply one comparison to several columns at once, as a nested
group joined to the rest of the query with `and`:

```ts
DB.table<User>('users')
    .where('active', true)
    .whereAny(['name', 'email'], 'like', '%john%')
    .whereAll(['email', 'backup_email'], '!=', '')
    .whereNone(['role', 'status'], 'banned');
```

| Method      | A record matches when                   |
|-------------|-----------------------------------------|
| `whereAny`  | Any of the columns meets the comparison |
| `whereAll`  | Every one of the columns meets it       |
| `whereNone` | None of the columns meets it            |

Date columns can be constrained by their parts, read in local time:

```ts
DB.table<Post>('posts')
    .whereDate('published_at', '2026-02-01')
    .whereYear('published_at', 2026)
    .whereMonth('published_at', 2)
    .whereDay('published_at', 1)
    .whereTime('published_at', '>=', '09:30');
```

Each takes an operator between the column and the value, `=` when it is left out:

```ts
DB.table<Post>('posts')
    .whereDate('published_at', '>', '2025-12-31')
    .whereYear('published_at', '<=', 2026)
    .whereMonth('published_at', '!=', '07')
    .whereDay('published_at', '>=', 15);
```

All five take `=`, `!=`, `<>`, `<`, `>`, `<=` and `>=`, and throw `SchemaException` for any other.
The year, month and day may be a whole number written as a string, such as `'2026'` or `'07'`,
which compares as that number. Any other string, such as `''`, `'2026.0'`, `'-1'` or `'twenty'`,
throws `SchemaException`.

`whereTime` compares zero padded `HH:MM:SS` strings, and pads `HH:MM` with `:00`, so `'09:30'`
means `09:30:00`. `whereDate` reads a `YYYY-MM-DD` string as that calendar day in the local
timezone, so `'2026-02-01'` matches 1 February wherever the code runs, and a day the calendar does
not have, such as `'2026-02-30'`, matches nothing. It reads any other string as `new Date` does, and
a `Date` by the local day it falls on, and a value it cannot read as a date matches nothing under
any operator. It compares whole days: `>` matches from the start of the next day, `<=` up to the end
of the day, and `!=` everything before or after it.

`whereDate` becomes a range and can be served by an index under every operator but `!=` and `<>`,
which become a nested pair of ranges joined with `or` and are checked against every record the
query reads. The other parts, and `whereTime`, are always checked that way. A null or missing value
matches none of them, under `!=` as under any other operator. None of them has an `or` form.

Operators: `=`, `==`, `===`, `!=`, `<>`, `!==`, `<`, `>`, `<=`, `>=`, `like`, `not like`. `==` is
loose and `===` is strict.

A value compared with a declared column is first converted to that column's type, so a value that
arrives as a string from a form, a URL or storage matches what the typed value would. This applies
to `where` and its `or` and `not` forms with every operator except `===`, `!==`, `like` and
`not like`, to every value of `whereIn` and `whereNotIn`, and to both bounds of `whereBetween` and
`whereNotBetween`:

| Column type              | Converts                                                    | Example                                    |
|--------------------------|-------------------------------------------------------------|--------------------------------------------|
| `integer`, `decimal`     | A whole number, or a non-blank string holding one           | `where('age', '>=', '18')` compares 18     |
| `float`                  | A finite number, or a non-blank string holding one          | `where('price', '<', '9.5')` compares 9.5  |
| `date`, `datetime`       | Any date, number or string `new Date` reads as a valid date | `where('published_at', '>', '2026-02-01')` |
| `boolean`                | Any value, read as an insert stores it                      | `where('active', 'true')` compares `true`  |
| `string`, `enum`, `json` | Nothing, the value is compared as given                     |                                            |

A date string therefore matches the moment it names, and `'true'` or `'false'` compared with a
boolean column matches the rows holding `true` or `false`. The moment is the one `new Date` reads,
so a date-only string such as `'2026-02-01'` is midnight UTC, not local midnight. To match a whole
day, use `whereDate`. A boolean column reads a string the way
an insert stores it: `'false'`, `'0'` and `''` are `false` and every other string is `true`, so
`where('active', 'no')` matches the active rows, just as inserting `'no'` stores `true`.

A value that does not convert cleanly, such as `'1.5'` or `''` for an integer column or `'soon'` for
a date column, is compared as given, the same loose way as before. `===` and `!==` never convert,
since strict means the value's type matters, so `where('age', '===', '18')` matches nothing. Nor
does a path into a JSON column, which has no declared type, or a column the table does not declare.
On a joined query each value is converted with the schema of the table its column belongs to.

Whether an index serves the query never changes which rows it returns. A converted value can be
looked up through an index, and a value that did not convert is checked against every record the
query reads. See [Query plans](query-plans.md).

Constraints follow SQL's three-valued logic: a comparison against `null` is unknown, and negating
unknown leaves it unknown. So a record whose `age` is `null` satisfies neither
`whereBetween('age', [18, 65])` nor `whereNotBetween('age', [18, 65])`. Only `whereNull` matches it.
The same holds through groups, so `whereNot((query) => query.where('age', '>', 26))` and
`whereNone(['age'], '>', 26)` both leave that record out too. A `null` in the list or among the
bounds is unknown as well, so `whereNotIn('role', ['admin', null])` matches nothing, and
`whereNotBetween('age', [null, 26])` matches only the ages above 26.

As in Laravel, `where('age', null)` is short for `whereNull('age')`, and `where('age', '!=', null)`
for `whereNotNull('age')`. This holds for `=`, `==` and `===`, for `!=`, `<>` and `!==`, and for
`undefined` as well as `null`, and `whereNot` flips the check. Any other operator compared against
`null`, such as `where('age', '>', null)`, is unknown and matches nothing, and so is every `having`
against `null`, which Laravel leaves as SQL too.

`like` and `not like` take SQL's wildcards, where `%` matches any run of characters and `_` matches
exactly one. Both are case insensitive, both cross newlines, and a backslash escapes a wildcard so
`'100\\%'` matches a literal percent. Everything else in the pattern is a literal, so a pattern full
of regular expression syntax matches only itself. Only strings are matched, so a number, a date or
any other value satisfies neither `like` nor `not like`.

The pattern is matched by a direct scan rather than a regular expression, which matters if your
patterns come from a search box. A regular expression compiled from `%%%%%` backtracks over every
way of splitting the value between the wildcards, and that is exponential in their number. The scan
walks the value once per wildcard instead, so a hostile or careless pattern costs time in proportion
to its length rather than freezing the tab.

## JSON columns

The values inside a `json()` column can be queried with `->`, the path syntax Laravel uses. A path
works anywhere a column is compared or sorted by, so `where` and every other constraint above take
one, and so does `orderBy`.

```ts
DB.table<User>('users')
    .where('settings->theme', 'dark')
    .where('settings->notifications->email', true)
    .whereNull('settings->deleted_at')
    .whereJsonContains('tags', 'admin')
    .whereJsonContains('tags', ['admin', 'owner'])
    .whereJsonDoesntContain('settings->roles', 'guest')
    .whereJsonLength('tags', '>', 1)
    .orderBy('settings->rank', 'desc');
```

| Method                                       | A record matches when                                                    |
|----------------------------------------------|--------------------------------------------------------------------------|
| `whereJsonContains(column, value)`           | The array holds the value, or every one of an array of values            |
| `whereJsonDoesntContain(column, value)`      | The array lacks the value, or at least one of an array of values         |
| `whereJsonLength(column, operator?, length)` | The number of elements in the array meets the comparison, `=` by default |

Each has an `or` form: `orWhereJsonContains`, `orWhereJsonDoesntContain` and `orWhereJsonLength`.

A path steps only through objects, and only through keys they hold themselves, so a step such as
`__proto__` or `constructor` never reaches the prototype, and a path never picks an element out of
an array. A missing step reads as `null`. So `whereNull('settings->rank')` matches a record whose
settings have no rank, that record satisfies neither `where('settings->rank', 2)` nor
`whereNot('settings->rank', 2)`, and sorting places it where it places `null`.

`whereJsonContains` and `whereJsonLength` expect the path to hold an array. Values are compared
strictly, so `'3'` is not found in `[3]`, and an object is never found, since that would need
comparing objects by their structure. A target that holds anything but an array satisfies neither
the constraint nor its negation, the way `like` treats anything but a string.

In a joined query, a path may start from a column qualified by its table, as in
`users.settings->theme`. That is why the steps are separated by `->` rather than `.`, which already
qualifies a column.

No index covers a value inside a JSON column, so a constraint on a path is checked against every
record the query reads, and ordering by a path sorts in memory. Another constraint on an indexed
column can still drive the scan.

The one exception is `whereJsonContains` with a single string or number on a column declared with
`.multiEntry()`, as described in [Defining a schema](schema.md#multi-entry-indexes-serve-wherejsoncontains).
It reads only the records whose array holds the value, through the index, and returns the same
records a scan would, each once. An array of values, any other kind of value, a path, a negation and
an `or` form are checked against every record instead. A multi-entry index serves nothing else: a
`where`, `whereIn`, `whereBetween` or `orderBy` on the column compares the whole value, as it would
with no index.

`select`, `pluck` and `value` read a path too. Left unaliased, a selected path is named after its
last step, the way `select('users.name')` is named `name`:

```ts
await DB.table<User>('users').select('name', 'settings->theme').get();
// [{ name: 'Alice', theme: 'dark' }, ...]

await DB.table<User>('users').select('settings->notifications->email as email').get();
await DB.table<User>('users').pluck('settings->theme');
await DB.table<User>('users').where('id', 1).value('settings->rank');
```

A missing path selects as `undefined`, and `value` returns `null` for it. `update` cannot write
through a path yet.

> Modeled on Laravel's [JSON Where Clauses](https://laravel.com/docs/12.x/queries#json-where-clauses).

## Shaping

```ts
DB.table<User>('users')
    .select('name', 'email')
    .distinct()
    .orderBy('name')
    .latest('created_at')
    .oldest('created_at')
    .reorder('email', 'desc')
    .inRandomOrder()
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

`distinct()` drops a row when an earlier one holds the same value in every column it returns, and
keeps the first. A JSON column compares by content, as SQL's JSON comparison does: two objects
holding the same keys and values are one value in whatever order their keys were written, at every
depth, while arrays compare element by element in order, so `[1, 2]` and `[2, 1]` stay apart. Inside
a JSON value, every distinction a column makes still holds: `1` and `'1'`, `true` and `'true'`, a
date and its ISO string, `null` and `undefined`, a key holding `undefined` and a missing key, a hole
in an array and `undefined`, and `{}` and `[]` are all different values, while `NaN` matches `NaN`
and `-0` matches `0`.

```ts
await DB.table<User>('users').select('settings').distinct().get();
// { theme: 'dark', rank: 2 } and { rank: 2, theme: 'dark' } come back as one row
```

A `Map`, a `Set`, an `ArrayBuffer` and a `RegExp` hold no keys of their own, so each compares as an
empty object, and a typed array compares as an object keyed by its indexes. A value that contains
itself cannot be compared, and `distinct()` throws a `TypeError` on it.

`limit` and `offset` read their values as Laravel does. `limit` ignores a negative or non-finite
value and keeps any limit set before it, `offset` treats one as 0, and both truncate a fraction. So
`offset(-2)` skips nothing, and a limited `update` or `delete` given `limit(-1)` writes every match.

| Method                        | Effect                                                                        |
|-------------------------------|-------------------------------------------------------------------------------|
| `reorder()`                   | Clears every order, including a random one                                    |
| `reorder(column, direction?)` | Replaces every order with one, ascending unless told otherwise                |
| `inRandomOrder()`             | Returns the records shuffled, setting any other order aside until `reorder()` |

`reorder` suits a shared base query that already sorts, such as one ending in `latest()`:

```ts
const recent: Builder<Post> = DB.table<Post>('posts').where('published', true).latest();

const alphabetical: Post[] = await recent.clone().reorder('title').get();
```

`inRandomOrder` shuffles every matching record before applying `limit` and `offset`, so a random
`first()` still reads the whole match, and no index is used for the order. `chunk`, `each` and
`lazy` walk the match in the shuffled order.

## Terminals

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

| Terminal                                      | Resolves to                                                                 |
|-----------------------------------------------|-----------------------------------------------------------------------------|
| `get()`                                       | `T[]`                                                                       |
| `first()`                                     | `T` or `null`                                                               |
| `firstOrFail()`                               | `T`, or throws `RecordsNotFoundException`                                   |
| `find(key)`                                   | `T` or `null`, by point lookup on the key path                              |
| `findOrFail(key)`                             | `T`, or throws `RecordsNotFoundException`                                   |
| `value(column)`                               | The column of the first matching record, or `null`                          |
| `pluck(column)`                               | `V[]` in result order                                                       |
| `pluck(column, key)`                          | `Record<string, V>`, keyed by a second column                               |
| `exists()` / `doesntExist()`                  | `boolean`                                                                   |
| `count()`                                     | `number`                                                                    |
| `sum(column)`                                 | `number`                                                                    |
| `avg(column)` / `min(column)` / `max(column)` | `number` or `null` when nothing matched                                     |
| `sole()`                                      | `T`, or throws `RecordsNotFoundException` / `MultipleRecordsFoundException` |
| `paginate(page?, perPage?)`                   | `{ data, total, perPage, currentPage, lastPage }`                           |

`find` converts its key to the type of the key path column first, as `where` does, so
`find(route.params.id)` finds the record even though a route parameter is always a string. A key
that is `null`, `undefined` or anything else IndexedDB cannot use as a key, such as a boolean,
returns `null` without reading the store, and `findOrFail` throws `RecordsNotFoundException` for it.

`count`, `sum`, `avg`, `min` and `max` aggregate every match, ignoring `limit`, `offset`, `orderBy`
and `inRandomOrder` as Laravel's aggregates do, so whether an index serves them never changes the
answer, and an offset past every match still gives the answer over the whole match. To aggregate a
single page, get the page and reduce it:

```ts
const page: Order[] = await DB.table<Order>('orders').orderBy('created_at').limit(10).get();
const total: number = page.reduce((sum: number, order: Order): number => sum + order.amount, 0);
```

`min` and `max` read the answer straight off the index when the column has one and the query is
unconstrained, whatever its order and paging, so they cost one cursor rather than a full scan.

`paginate` gives you the totals a pager needs, which `forPage` cannot, and counts what the query
matches rather than what the page returns:

```ts
const page = await DB.table<User>('users').orderBy('name').paginate(2, 15);
```

```
{ data: [ ... ], total: 132, perPage: 15, currentPage: 2, lastPage: 9 }
```

As Laravel's paginator does, `paginate` reads a page that is below 1 or not a whole number as page
1, so a page number taken straight from a URL cannot go out of range. A page size that is not a
whole number of at least 1 throws `SchemaException`.

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

`chunk`, `each` and `lazy` decide which records match when the walk starts, and fetch each page
fresh when it is reached. A record that stops matching or is deleted before its page arrives is left
out, so every record is delivered at most once, and only while it still matches. A record that
starts matching during the walk is not picked up. Since records can drop out, any page may be
shorter than the size asked for. A page left empty is skipped, and the page numbers stay
consecutive.

`chunk` and `lazy` throw `SchemaException` for a size that is not a whole number of at least 1, as
Laravel's `lazy` does, since a walk in pages of nothing would never end.

## Writes

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
await DB.table<User>('users').oldest('created_at').limit(100).delete();
await DB.table<User>('users').truncate();
```

On insert, the connection applies declared defaults, fills `created_at`/`updated_at` when the table
declares `timestamps()`, coerces declared column types as
[Coercion on the way in](#coercion-on-the-way-in) describes, and throws
`NotNullConstraintViolationException` for an absent non-nullable column. On update, only
`updated_at` is touched.

A violated unique index surfaces as `UniqueConstraintViolationException` naming the table and the
index, rather than a bare `DOMException`, whether the write is an `insert`, an `update`, an `upsert`,
an `increment` or a `decrement`. An `update`, `increment` or `decrement` that collides on any of the
records it matches writes none of them. Inside `DB.transaction`, the exception aborts the whole
transaction as it leaves the callback. IndexedDB cannot undo one write alone, so a callback that
catches it keeps whatever the failed write changed before the collision.

`upsert` requires its conflict target to be the key path or a unique index, because IndexedDB cannot
enforce anything else. Any other column throws `SchemaException`. The conflict key is coerced the way
an insert coerces it before it is looked up, so `upsert([{ code: '5' }], 'code')` on an integer
column merges into the record holding 5 rather than inserting a second one. A conflict key holding
`null`, or left out, matches no record, as SQL's `ON CONFLICT` treats null, so the record is
inserted. A blank string in a nullable number column is such a key.

The key path may not be updated, so `update`, `upsert` and `increment` all refuse it.

`update`, `delete`, `increment` and `decrement` honor `orderBy` together with `limit` and
`offset`, so they touch the same records a read of the query would return, whether or not an index
serves the order. Without an `orderBy`, they follow the order the plan scans, which is index order
when an index drives the query and key order otherwise. With `inRandomOrder()`, a `limit` or
`offset` picks the records from the shuffled match, so
`where('role', 'guest').inRandomOrder().limit(10).delete()` removes ten guests at random.

## Coercion on the way in

Every write coerces the value it gives a declared column into that column's type: `insert`,
`insertOrIgnore`, `insertGetId`, `update`, `updateOrInsert`, `upsert` and its conflict key, the
extra columns of `increment` and `decrement` and the value they leave behind, and a declared
default. A strict connection throws `TypeError` for a value its column cannot store faithfully. A
loose connection writes `null` in its place, and a non-nullable column then holds `null` too, as it
does for any missing value.

| Column type          | Accepts                                                                     | Stores                                                                  |
|----------------------|-----------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `integer`, `decimal` | A finite number, a numeric string, a bigint within the safe integer range   | A whole number. A fraction throws when strict and is rounded when loose |
| `float`              | A finite number, a numeric string, a bigint within the safe integer range   | The number                                                              |
| `string`, `enum`     | A string, a finite number, a boolean, a bigint, a valid `Date`              | The string as given, `String(value)`, or a date's `toISOString()`       |
| `date`, `datetime`   | A valid `Date`, a whole timestamp in milliseconds, an ISO 8601 string       | A `Date`                                                                |
| `boolean`            | Any value                                                                   | `false` for `'false'`, `'0'` and any falsy value, `true` otherwise      |
| `json`               | Any value                                                                   | A string parsed as JSON, anything else as given                         |

A numeric string is written in decimal notation: an optional sign, digits with an optional fraction,
and an optional exponent, with surrounding whitespace ignored. So `' 12 '`, `'+5'`, `'-0.5'`, `'.5'`
and `'1e3'` are numbers, while `'0x10'`, `'0b11'`, `'Infinity'` and `'12abc'` are not. Arrays,
objects, booleans and dates are never numbers, so `[5]` and `true` throw rather than becoming 5
and 1. `NaN` and `Infinity` throw in number, string and date columns, and a bigint outside the safe
integer range throws in a number column, since it would lose digits.

Rounding uses `Math.round`, which takes a half toward the larger number, so 2.5 becomes 3 and -2.5
becomes -2. Before 5.0.0 an integer column truncated a fraction on either connection.

A blank string, one that is empty or holds only whitespace, is `null` in a number, `date` or
`datetime` column. A nullable column stores `null`, and a required one throws
`NotNullConstraintViolationException` when strict. A string column keeps a blank string as given.

An ISO 8601 string is `YYYY-MM-DD`, optionally followed by `T` or a space and `HH:MM`, then
optionally `:SS` and a fraction of a second, and then optionally `Z` or an offset such as `+02:00`.
A time without `Z` or an offset is local, and a date alone is UTC midnight, as `new Date` reads it.
The date and time must exist, so `'2024-02-30'`, `'2023-02-29'` and `'24:00'` throw rather than
roll over into the next day or month. Any other form `new Date` reads, such as `'01/15/2024'`,
`'Jan 15 2024'`, `'2024'` or a `toUTCString()` string, throws, and so do `'1'` and `true`. A `date`
column takes the same values as a `datetime` column, time of day included.

`increment` and `decrement` throw `TypeError` on either connection for an amount that is not a
finite number. The value they leave behind is coerced as an update coerces it, so
`increment('visits', 0.5)` on an integer column throws when strict, writing none of the records,
and rounds when loose.

A form handler can pass an empty optional field through as it is, since a blank string in a nullable
number or date column is stored as `null`, or send `null` itself. It should check required fields
before writing, and turn a value the form holds in its own format, such as a date picker's
`'01/15/2024'`, into a `Date` first.

Query values are read more leniently, since a value that does not convert is compared as given
rather than refused. See [Constraints](#constraints).

> Modeled on Laravel's [Database: Query Builder](https://laravel.com/docs/12.x/queries). The method
> names and their semantics match, and every terminal is asynchronous because IndexedDB is.
