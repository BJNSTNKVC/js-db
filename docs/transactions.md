# Transactions

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    const id: IDBValidKey = await transaction.table<User>('users').insertGetId({ name: 'John' });

    await transaction.table('posts').insert({ user_id: id, title: 'Hello' });
});
```

Throwing inside the callback aborts the transaction and rethrows your error.

By default the transaction covers every table, since the callback's reach is unknowable up front.
Narrow it when you care:

```ts
await DB.transaction(async (transaction: Transaction): Promise<void> => {
    await transaction.table<User>('users').insert({ name: 'John' });
}, { tables: ['users'] });
```

A nested `DB.transaction` **joins** the one already running. IndexedDB has no savepoints, so there is
no partial rollback.

There is no `beginTransaction()` / `commit()` / `rollBack()`. A manually held IndexedDB transaction
commits behind your back the first time you await anything outside it, so offering that API would be
offering a trap. The same rule as migrations applies here: the callback may only await operations
from this package.

> Modeled on Laravel's [Database: Transactions](https://laravel.com/docs/12.x/database#database-transactions).
> The tables have to be declared up front, because an IndexedDB transaction fixes its scope when it
> opens.
