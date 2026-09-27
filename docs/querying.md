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

`whereTime` compares zero padded `HH:MM:SS` strings, and pads `HH:MM` with `:00`, so `'09:30'`
means `09:30:00`. `whereDate` becomes a range and can be served by an index. The other parts, and
`whereTime`, are checked against every record the query reads. None of them has an `or` form.

Operators: `=`, `==`, `===`, `!=`, `<>`, `!==`, `<`, `>`, `<=`, `>=`, `like`, `not like`. `==` is
loose and `===` is strict.

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

`chunk`, `each` and `lazy` decide which records match when the walk starts, and fetch each page
fresh when it is reached. A record that stops matching or is deleted before its page arrives is left
out, so every record is delivered at most once, and only while it still matches. A record that
starts matching during the walk is not picked up. Since records can drop out, any page may be
shorter than the size asked for. A page left empty is skipped, and the page numbers stay
consecutive.

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
declares `timestamps()`, coerces declared column types, and throws
`NotNullConstraintViolationException` for an absent non-nullable column. On update, only
`updated_at` is touched.

A violated unique index surfaces as `UniqueConstraintViolationException` naming the table and the
index, rather than a bare `DOMException`.

`upsert` requires its conflict target to be the key path or a unique index, because IndexedDB cannot
enforce anything else. Any other column throws `SchemaException`.

The key path may not be updated, so `update`, `upsert` and `increment` all refuse it.

`update`, `delete`, `increment` and `decrement` honor `orderBy` together with `limit` and
`offset`, so they touch the same records a read of the query would return, whether or not an index
serves the order. Without an `orderBy`, they follow the order the plan scans, which is index order
when an index drives the query and key order otherwise. With `inRandomOrder()`, a `limit` or
`offset` picks the records from the shuffled match, so
`where('role', 'guest').inRandomOrder().limit(10).delete()` removes ten guests at random.

> Modeled on Laravel's [Database: Query Builder](https://laravel.com/docs/12.x/queries). The method
> names and their semantics match, and every terminal is asynchronous because IndexedDB is.
