# Multiple tabs

IndexedDB is shared across tabs, and the browser can close it under a page, which produces three
situations worth handling:

- Another tab holds an older version open, blocking an upgrade. The connection emits
  `database-blocked` and rejects with `DatabaseBlockedException`, so you can ask the user to close
  the other tabs. Once they do, the browser still carries out the blocked upgrade, and the
  connection aborts it, so no migration runs and the database stays as it was. The next `open()`,
  or the next query, runs the pending migrations and holds the only handle.
- Another tab upgrades or deletes the database. The connection closes its own handle so it does not
  block that tab, then emits `database-version-changed`. Its `version` is the version the other tab
  is opening, or `null` when it is deleting the database.
- The browser closes the connection's handle itself, when the user clears the site's data or its
  storage fails. The connection drops the handle, and the next query opens the database again,
  running the migrations if the data was cleared. A query or `DB.transaction` the close aborted
  rejects with its own error and is not run again.

Before 18.0.2 a tab could report itself as the one blocking. Safari did it on every upgrade, and other
browsers now and then under load: the open emitted `database-blocked` and rejected with
`DatabaseBlockedException` with no other tab open, while the upgrade carried on behind it. A tab
whose open failed, such as with `MigrationMismatchException`, or that disconnected or ran `fresh()`
straight after opening, could likewise be reported as blocking an upgrade or delete for a moment.
Before 18.0.3 Safari did the same to a `fresh()` made straight after a query outside
`DB.transaction`.

Before 18.0.6 the blocked upgrade ran the migrations once the other tab closed, after its open had
rejected, and an open made meanwhile got a handle of its own. The connection could then keep a
second handle that nothing closed, not even `disconnect()`, and that blocked every later upgrade or
delete from another tab until the page was reloaded.

Before 18.0.16 the connection kept a handle the browser had closed, and every query threw
`InvalidStateError` until the page was reloaded.

The other tab is usually running newer code with more migrations, after a deploy. This tab can no
longer open the database, and its next query would reject with `MigrationMismatchException`. Reload
the page when the event arrives, rather than querying again:

```ts
DB.onDatabaseVersionChanged((event: DatabaseVersionChanged): void => {
    if (confirm('A new version is available. Reload now?')) {
        location.reload();
    }
});
```

An open that fails, for instance with `MigrationMismatchException`, closes the handle it was given,
so a tab running old code never blocks another tab's upgrade, and `fresh()` can still run in it.
