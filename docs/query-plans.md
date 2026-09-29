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
  with no value for its key path, which would silently lose rows.
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
- A `whereBetween` whose bounds are the wrong way round, such as `whereBetween('age', [65, 18])`,
  matches nothing, and is planned as an empty set of lookups rather than as a range.
- When a range and an order want different indexes, the range wins and the sort happens in memory.
- Any top-level `orWhere` forces a full scan.
- `count()` with no residual constraints uses `count()` on the store or index, reading no records.
