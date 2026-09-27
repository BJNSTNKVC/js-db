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

> Modeled on Laravel's [Query Builder: Joins](https://laravel.com/docs/12.x/queries#joins). Rows
> stay flat as they do in Laravel, and the join itself runs in memory because IndexedDB has none.
