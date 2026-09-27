# Multiple tabs

IndexedDB is shared across tabs, which produces two situations worth handling:

- Another tab holds an older version open, blocking an upgrade. The connection emits
  `database-blocked` and rejects with `DatabaseBlockedException`, so you can ask the user to close
  the other tabs.
- Another tab upgrades or deletes the database. The connection closes its own handle so it does not
  block that tab, then emits `database-version-changed`. Its `version` is the version the other tab
  is opening, or `null` when it is deleting the database.

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
