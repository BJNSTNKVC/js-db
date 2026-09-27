# Storage quota

A browser gives each origin a finite storage budget, and a write that exceeds it fails. This is the
likeliest failure a client-side database hits in production, and it has no equivalent in a server
database, so it is worth handling explicitly.

The platform reports it as a bare `DOMException` whose message says nothing about the fix. This
package names it instead:

```ts
try {
    await DB.table<User>('users').insert(records);
} catch (error) {
    if (error instanceof QuotaExceededException) {
        const { usage, quota } = await DB.estimate();

        console.warn(`Using ${usage} of ${quota} bytes.`);
    }
}
```

`QuotaExceededException` is raised from any operation the quota stops, including one that aborts a
transaction, so a single `catch` around a transaction covers everything inside it.

## Asking not to be evicted

Browsers evict an origin's IndexedDB under storage pressure. If that happens, your migrations replay
against an empty database on the next boot and the data is simply gone. `DB.persist()` asks the
browser to exempt this origin:

```ts
await DB.persist();     // true when the browser agreed
await DB.persisted();   // true when this origin is already exempt
```

Whether the request is granted is up to the browser and depends on things like whether the site is
installed or has engagement history. Any app storing data it cares about should ask at boot.

`DB.estimate()` wraps `navigator.storage.estimate()`, and reports `{}` where the Storage Manager is
not available rather than throwing.
