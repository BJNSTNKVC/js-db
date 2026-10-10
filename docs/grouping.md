# Grouping

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

`min` and `max` return the value as the column holds it and compare values as `orderBy` does, as
[Querying](querying.md#terminals) describes, so `{ max: 'created_at' }` gives a `Date` and
`{ min: 'name' }` a string. Each is typed by its column, `User['age'] | null` for `{ max: 'age' }`,
and `unknown` for a qualified column or a path. `having` and `orderBy` compare them as they hold
them, so `having('latest', '>', new Date('2026-01-01'))` keeps the groups whose latest date is later.
Before 11.0.0 they read every value as a number. `sum` and `avg` still do.

| Aggregate                                 | Meaning                                                               |
|-------------------------------------------|-----------------------------------------------------------------------|
| `{ count: '*' }`                          | The number of records in the group, always a `number`                 |
| `{ count: 'column' }`                     | The number of records whose column is not null                        |
| `{ sum: 'column' }`                       | The total, `0` for a group with no values                             |
| `{ avg: 'column' }`                       | The mean, `null` for a group with no values                           |
| `{ min: 'column' }` / `{ max: 'column' }` | The extreme as the column holds it, `null` for a group with no values |

Group by several columns by passing several names:

```ts
await DB.table<User>('users').groupBy('team', 'role').aggregate({ total: { count: '*' } }).get();
```

`aggregate()` is optional. Grouping with nothing aggregated gives you one row per distinct
combination, which is what `distinct()` does over the same columns. Calling `distinct()` on the
query you group changes nothing, since every group is already distinct, and each aggregate still
sees every record of its group.

A JSON column groups by content, comparing values the way `distinct()` does, as described in
[Querying](querying.md#shaping). Objects holding the same keys and values fall into one group in
whatever order their keys were written, at every depth, and an array shares a group only with arrays
holding the same elements in the same order. The group carries the value its first record holds.

A JSON path groups by the value it reads, and the row carries it under the path's last step, the way
`select` names a path, so `groupBy('settings->theme')` gives rows such as `{ theme: 'dark' }`. An
aggregate can read a path too, as in `{ sum: 'stats->points' }`, leaving out a record the path
finds nothing in.

## Grouping beside a select

A grouping reads every row the query matches, whatever its `select`, as SQL's `GROUP BY` runs before
the select list. So `select('name').groupBy('team')` still groups by `team`, and every aggregate and
`having` reads the columns the select leaves out.

A grouped column may name a select alias, as MySQL, SQLite and Postgres allow. The grouping groups
by the column the alias selects and names it after the alias, and `having` and `orderBy` accept that
column by its own name too:

```ts
await DB.table('users')
    .select('team as squad')
    .groupBy('squad')
    .aggregate({ total: { count: '*' } })
    .having('team', 'ops')
    .get();
```

```
[
    { squad: 'ops', total: 2 }
]
```

A column declared by a table the query reads wins over an alias of the same name, as it does in
those databases, so `select('name as role').groupBy('role')` groups by `role`.

## having, ordering and paging apply to groups

`having` and `orHaving` filter the grouped rows, and take the same operators as `where`. They can
name either a grouped column or an aggregate alias, since by then both are just columns on the row.
A grouped column can be named as it was grouped, by the name it takes on the row, or qualified with
its table, so after `groupBy('role')`, `having('users.role', 'admin')` and `orderBy('users.role')`
both read `role`. A column qualified with a table the query does not read throws `SchemaException`,
as it does in `where`.

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

They read their values as a query's `limit` and `offset` do: a negative or non-finite limit is
ignored, such an offset is 0, and a fraction is truncated.

Grouping happens in memory after the records are fetched, so the planner still applies to the
`where` clauses that select them, and a grouped query reports the plan of that underlying fetch.

> Modeled on Laravel's [Query Builder: Grouping](https://laravel.com/docs/12.x/queries#groupby-having),
> with the aggregates named in a typed object instead of raw SQL.
