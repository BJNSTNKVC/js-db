# Transactions

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    const id: IDBValidKey = await transaction.table<User>('users').insertGetId({ name: 'John' });

    await transaction.table('posts').insert({ user_id: id, title: 'Hello' });
});
```

Throwing inside the callback aborts the transaction and rethrows your error, unless the transaction
has already committed because the callback awaited something outside this package. See
[What the callback may await](#what-the-callback-may-await).

By default the transaction covers every table, since the callback's reach is unknowable up front.
Narrow it when you care:

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    await transaction.table<User>('users').insert({ name: 'John' });
}, { tables: ['users'] });
```

A nested `DB.transaction` **joins** the one already running. IndexedDB has no savepoints, so there is
no partial rollback.

Inside a migration, `DB.transaction` on the connection being migrated joins the migration's
version-change transaction the same way. It ignores `options.tables`, dispatches no transaction
events, and an error it throws fails the migration, rolling back the whole upgrade. While a migration
runs, a `DB.transaction` the rest of the app starts on that connection joins it as well. See
[What a migration may await](migrations.md#what-a-migration-may-await).

There is no `beginTransaction()` / `commit()` / `rollBack()`. A manually held IndexedDB transaction
commits behind your back the first time you await anything outside it, so offering that API would be
offering a trap. The same rule as migrations applies here: the callback may only await operations
from this package.

## What the callback may await

IndexedDB commits a transaction as soon as it has no requests left and control returns to the event
loop. Awaiting a `fetch`, a timer or any other promise from outside this package does exactly that,
so the transaction commits while the callback is still running, and **everything written before the
await stays written**. The package reports it rather than failing with a bare platform error:

- Every later query through the transaction throws `TransactionClosedException`, naming the
  connection, and so does a nested `DB.transaction` call, which joins the closed transaction. A
  `Transaction` kept after its call has settled throws it too.
- `DB.transaction` rejects with `TransactionClosedException` once the callback settles, whether the
  callback let the exception through, caught it, or made no further query. An error the callback
  throws after the close is kept as the exception's `cause`.
- `transaction-committed` is dispatched, since the work before the await did commit, and
  `transaction-rolled-back` is not.

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    await transaction.table<User>('users').insert({ name: 'John' });

    const profile: Profile = await fetch('/profile').then((response: Response): Promise<Profile> => response.json());

    // Throws TransactionClosedException, and John is already committed.
    await transaction.table('profiles').insert(profile);
});
```

Do the outside work first and pass its result in, so the callback awaits nothing else:

```ts
const profile: Profile = await fetch('/profile').then((response: Response): Promise<Profile> => response.json());

await DB.transaction(async (transaction: Transaction): Promise<void> => {
    await transaction.table<User>('users').insert({ name: 'John' });
    await transaction.table('profiles').insert(profile);
});
```

A browser commits in the background, so a query that arrives while the commit is still being written
fails with IndexedDB's own `TransactionInactiveError` instead. When the callback lets that error
through, `DB.transaction` still waits for the commit and rejects with `TransactionClosedException`,
carrying the platform's error as its `cause`. A callback that settles without an error before the
commit has landed resolves as usual, with its work committed.

> Modeled on Laravel's [Database: Transactions](https://laravel.com/docs/12.x/database#database-transactions).
> The tables have to be declared up front, because an IndexedDB transaction fixes its scope when it
> opens.
