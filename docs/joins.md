# Joins

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

## The row is flat, and collisions clobber

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

## Reading a qualified column

`pluck` and `value` take a qualified column as `select` does, so they read the table it names
rather than whichever one won the flat row. A qualified column can also lead a JSON path:

```ts
// Alice, whose theme is dark, wrote First and Second. Bob wrote Hello.
const query = DB.table('users').join('posts', 'users.id', '=', 'posts.user_id').orderBy('posts.id');

await query.pluck('users.name');
await query.pluck('posts.title', 'users.name');
await query.value('users.settings->theme');
```

```
['Alice', 'Alice', 'Bob']
{ Alice: 'Second', Bob: 'Hello' }
'dark'
```

As on any query, a key that repeats keeps the last value it meets. A bare column still reads the
flat row, so `pluck('id')` returns `posts.id`. Once one column of a `pluck` is qualified, the other
is resolved the way `select` resolves it, so a bare column two tables share throws
`SchemaException` there.

`groupBy`, the columns an aggregate names and `having` take qualified columns too. A grouped column
is named after its last part, the way `select('users.name')` is named `name`, and `having` accepts
either name:

```ts
// Alice's posts have 3 and 5 likes, Bob's has 1.
await DB.table('users')
    .join('posts', 'users.id', '=', 'posts.user_id')
    .groupBy('users.name')
    .aggregate({ total: { count: '*' }, likes: { sum: 'posts.likes' } })
    .having('users.name', 'Alice')
    .get();
```

```
[
    { name: 'Alice', total: 2, likes: 8 }
]
```

Two grouped columns that share a last part, as in `groupBy('users.id', 'posts.id')`, still group by
both, but the row keeps the later one under `id`, as `select('users.id', 'posts.id')` does.

## Ambiguous columns are rejected, not guessed

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

## A left join nulls the missing side

Every column of the unmatched table comes back `null`, as in SQL, which makes the usual
find-the-orphans query work:

```ts
await DB.table('users')
    .leftJoin('posts', 'users.id', '=', 'posts.user_id')
    .whereNull('posts.id')
    .get();
```

## What joins cost, and what they do not support

IndexedDB has no join, so every one is performed in memory. A single equality between a column of
the joined table and one of the tables before it uses a hash join when both columns hold values of
one type, and anything else falls back to a nested loop. Either way a condition matches the rows
`whereColumn` would, so a number matches the same number held as a string, two dates match when they
name the same moment, and a null or missing value matches nothing. The join reads every table it
names in full, without an index, and the `where` clauses then filter the joined rows, so memory is
proportional to the tables involved. That is fine at the data volumes a browser holds, and worth
knowing before joining two large tables.

`orderBy` on a joined query always sorts in memory, since the row is synthesised and no index covers
it, and `chunk` slices the materialised result rather than walking keys.

`count` and `paginate` count the joined rows, as `get` returns them, so a user with two posts counts
twice and a left join counts each user it keeps without a post once:

```ts
// Alice wrote two posts, Bob one and Carol none.
await DB.table('users').join('posts', 'users.id', '=', 'posts.user_id').count();
await DB.table('users').leftJoin('posts', 'users.id', '=', 'posts.user_id').count();
```

```
3
4
```

Like `paginate`'s total, the count takes every row the join and its `where` clauses keep, whatever
the `limit` and `offset`. `explain` on a joined query returns `'join'`, the plan it runs under.

## Writing through a join

`update`, `delete`, `increment` and `decrement` on a joined query write to the rows of this table
that the join and its constraints keep, as Laravel does through MySQL's multi-table `UPDATE` and
`DELETE`:

```ts
// Delete the users who wrote a post with this title.
await DB.table('users')
    .join('posts', 'users.id', '=', 'posts.user_id')
    .where('posts.title', 'Hello')
    .delete();

// Delete the users who have written nothing at all.
await DB.table('users')
    .leftJoin('posts', 'users.id', '=', 'posts.user_id')
    .whereNull('posts.id')
    .delete();
```

A row joined to several others is written once, so `increment` adds its amount once however many
posts a user has. A row a right join keeps for the other table alone is skipped, since there is no
record of this table behind it.

- **Only this table is written.** `update` takes its columns qualified or not, so `'users.active'`
  and `'active'` both work, and a column of a joined table throws `SchemaException`.
- **Values are fixed,** as in every other `update`. Setting a column from a joined one, as in
  `SET users.title = posts.title`, would need raw expressions, which this package does not have.
- **`orderBy`, `inRandomOrder`, `limit` and `offset` throw**, as MySQL refuses them on a
  multi-table write, since it would be unclear whether a limit counts joined rows or records.
- **`insert`, `insertOrIgnore`, `insertGetId`, `upsert`, `updateOrInsert` and `truncate` throw**,
  since they have no meaning through a join.
- **It runs in one transaction** over every table the join reads, so no other tab can change the
  joined rows between choosing the records and writing them. Inside `DB.transaction()` with
  `options.tables`, every one of those tables has to be listed.
- **It costs what a joined read does:** every table involved is read in full and joined in memory.

`whereColumn` compares two columns of the same row, and is available on any query:

```ts
await DB.table('users').whereColumn('updated_at', '>', 'created_at').get();
```

> Modeled on Laravel's [Query Builder: Joins](https://laravel.com/docs/12.x/queries#joins). Rows
> stay flat as they do in Laravel, and the join itself runs in memory because IndexedDB has none.
