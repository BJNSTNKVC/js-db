# Query plans

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
  with no value for its key path, which would silently lose rows, and so are multi-entry indexes,
  described below.
- A non-nullable column can still lack values: a loose connection stores `null` where a required
  value is missing, a column added by `Schema.table` without a default leaves every existing row
  without it, and an index on a boolean column holds nothing, since a boolean is not a valid key. So
  before ordering through an index, the query compares the index's `count()` with the table's,
  reading no records. When they differ, it sorts in memory instead, placing `null` and missing
  values first ascending and last descending, and the plan reads `'scan'`. Reads, `explain` and
  ordered writes all take this check, and `count`, `sum`, `avg`, `min` and `max` set the order
  aside along with the paging. It is skipped when a range
  or point lookup on the ordering column drives the query, since `null` never satisfies one, and
  when ordering by the key path, since every record has a key.
- `whereIn` on the key path or an index becomes one point lookup per distinct value, so a repeated
  value never returns, counts or writes a record twice.
- An `update`, `increment` or `decrement` that changes a column of the index it walks first
  collects the matching keys, reading keys only, then writes each record by key. A changed record
  that moves ahead of the walk is never reached again, so moving an item in an ordered list with
  `where('position', '>=', n).increment('position')` shifts each position once. A write that leaves
  the column alone keeps the single walk.
- A constraint drives the key path or an index only when its value is a key of the type the column
  stores, after the conversion described in [Querying](querying.md): a whole number for an integer
  or decimal column, a number for a float, a valid date for a date or datetime, a string for a
  string or enum, and any valid key for a JSON column. Anything else, including every boolean, an
  object, an invalid date or a value that did not convert, is checked against every record the
  query reads instead, so an index never changes which rows come back.
- A multi-entry index holds one entry per distinct element of the array a record stores, so it
  never drives an equality, a `whereIn`, a range, a `whereBetween` or an order, which compare the
  whole value. It drives `whereJsonContains(column, value)` alone, as a point lookup of the value,
  when the value is a string or a finite number, the elements it finds exactly where a scan does.
  An array of values, a date, `NaN`, a boolean, an object or `null` is checked against every record
  instead: a scan finds an element by strict equality, so it finds `NaN` yet never finds a date or
  an object by value, while the index finds a date by its time and holds no `NaN`, boolean, object
  or `null` at all. The index also holds a value that is not an
  array as an entry of its own, which a scan finds no element in, so each record the lookup reaches
  is checked against the constraint again, and `count()` reads those records rather than calling
  `count()` on the index.
- A `whereBetween` whose bounds are the wrong way round, such as `whereBetween('age', [65, 18])`,
  matches nothing, and is planned as an empty set of lookups rather than as a range.
- When a range and an order want different indexes, the range wins and the sort happens in memory.
- Any top-level `orWhere` forces a full scan.
- A nested group never drives the query, though a constraint beside it can. `whereDate` with `!=`
  or `<>` is one, so on its own it reads every record, while under any other operator it is a range
  an index on its column can serve. `whereYear`, `whereMonth`, `whereDay` and `whereTime` never
  drive the query.
- `count()` with no residual constraints uses `count()` on the store or index, reading no records,
  unless the query joins.
- A joined query reads every table it joins in full and runs the join in memory, so no index takes
  part. `explain()` on one returns `'join'`, the plan the `QueryExecuted` event reports for it, and
  `count()` counts the joined rows.
