# Documentation

- [Configuration](configuration.md): declaring connections, migrating at boot, and resolving,
  disconnecting and purging connections
- [Migrations](migrations.md): forward-only migrations, what a migration may await, and migration
  status
- [Seeding](seeding.md): seeders, which connection they write to, running them safely on every boot,
  and rebuilding from scratch
- [Defining a schema](schema.md): column types and modifiers, altering and changing columns,
  decimals, enums, and reserved tables
- [Querying](querying.md): constraints, JSON columns, shaping, terminals and writes
- [Joins](joins.md): inner, left, right and cross joins, and what they cost
- [Grouping](grouping.md): `groupBy`, typed aggregates and `having`
- [Query plans](query-plans.md): how constraints become an index range, and `explain()`
- [Transactions](transactions.md): transaction scope, nesting and what the callback may await
- [Events](events.md): listening for query, transaction, migration and seeding events, and the
  query log
- [Multiple tabs](multiple-tabs.md): blocked upgrades and databases changed by another tab
- [Storage quota](storage.md): quota errors, usage estimates and asking not to be evicted
- [Exceptions](exceptions.md): every exception the package throws, and when
