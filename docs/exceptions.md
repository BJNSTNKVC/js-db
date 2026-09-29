# Exceptions

Every exception extends `Error` and sets its own `name`, so `instanceof` and the stack both read
true. All of them are exported from the package root.

| Exception                             | Thrown when                                                                                                 |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `CheckConstraintViolationException`   | A write gives an enumerated column a value it does not accept                                               |
| `ConnectionNotConfiguredException`    | A connection is resolved under a name `DB.configure` never declared                                         |
| `DatabaseBlockedException`            | Another tab holds the database open at an older version, so the upgrade cannot start                        |
| `MigrationMismatchException`          | The recorded migration list is not a prefix of the registered one, so one was removed, renamed or reordered |
| `MigrationTransactionClosedException` | A migration awaited something outside this package, letting the versionchange transaction commit early      |
| `MultipleRecordsFoundException`       | `sole()` matched more than one record                                                                       |
| `NotNullConstraintViolationException` | A non-nullable column is written as null, or is absent with no default                                      |
| `QuotaExceededException`              | The origin's storage quota stopped the operation                                                            |
| `RecordsNotFoundException`            | `firstOrFail()`, `sole()` or `findOrFail()` matched nothing                                                 |
| `ReservedTableException`              | A migration tries to create `migrations` or `schema`                                                        |
| `SchemaException`                     | A schema or query call the shape of the database cannot support                                             |
| `TableNotFoundException`              | A query or schema read names a table the database does not have                                             |
| `UniqueConstraintViolationException`  | A write collides with a unique index, named in the message                                                  |

`SchemaException` is the broad one, so here is every case that raises it:

- `Schema.create`, `table`, `drop`, `dropIfExists` or `rename` called outside a migration
- `Schema.create` on a table that already exists, or `Schema.rename` onto a name already taken
- dropping or renaming the key path, which IndexedDB fixes when the store is created
- declaring the same column, or the same index name, twice on one blueprint, or adding a column
  that the table already has
- declaring more than one primary column, including `.primary()` alongside `table.id()`
- dropping or renaming a column, or dropping an index, that does not exist on the table
- dropping a column that a compound index still covers, until the index is dropped
- declaring an enumerated column over an empty list of values
- `upsert` whose conflict target is neither the key path nor a unique index
- `update`, `upsert`, `increment` or `decrement` touching the key path
- a qualified column naming a table the query does not join
- an unqualified column that is ambiguous across the tables a join reads
- a column that exists on none of the tables the query reads
- reading a table inside `DB.transaction` that the transaction did not declare
- `chunk` or `lazy` with a size, or `paginate` with a page size, that is not a whole number of at
  least 1
