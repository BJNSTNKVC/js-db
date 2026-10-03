import { DatabaseManager } from '../database/DatabaseManager';
import { Request } from '../database/Request';
import { ReservedTableException, SchemaException, TableNotFoundException } from '../exceptions';
import { Migrator } from '../migrations/Migrator';
import { Repository } from '../migrations/Repository';
import { Blueprint } from './Blueprint';
import { Registry } from './Registry';
import type { Connection } from '../database/Connection';
import type { MigrationContext } from '../migrations/Migrator';
import type { BlueprintOperations, ChangedColumn, ColumnSchema, IndexSchema, RenamedColumn, TableSchema } from './types';

type Tally = { change: ChangedColumn; count: number };

type KeyedRow = { key: IDBValidKey; row: number };

export class Schema {
    /**
     * Get the table names the database layer reserves for itself.
     */
    static reserved(): string[] {
        return [Repository.table, Registry.table];
    }

    /**
     * Get a connection to read schema information from.
     */
    static connection(name?: string): Connection {
        return DatabaseManager.connection(name);
    }

    /**
     * Determine whether a table exists.
     */
    static hasTable(table: string): Promise<boolean> {
        return this.connection().hasTable(table);
    }

    /**
     * Determine whether a table has a column.
     */
    static hasColumn(table: string, column: string): Promise<boolean> {
        return this.connection().hasColumn(table, column);
    }

    /**
     * Get the names of every table.
     */
    static getTables(): Promise<string[]> {
        return this.connection().tables();
    }

    /**
     * Get the columns of a table.
     */
    static getColumns(table: string): Promise<ColumnSchema[]> {
        return this.connection().getColumns(table);
    }

    /**
     * Get the indexes of a table.
     */
    static getIndexes(table: string): Promise<IndexSchema[]> {
        return this.connection().getIndexes(table);
    }

    /**
     * Create a table.
     */
    static async create(table: string, callback: (table: Blueprint) => void): Promise<void> {
        const context: MigrationContext = this.#context('create');

        this.#available(table);

        if (context.database.objectStoreNames.contains(table)) {
            throw new SchemaException(`Table [${table}] already exists.`);
        }

        const blueprint: Blueprint = new Blueprint(table);

        callback(blueprint);

        const schema: TableSchema = blueprint.toSchema();
        const store: IDBObjectStore = context.database.createObjectStore(table, this.#options(schema));

        for (const index of schema.indexes) {
            this.#createIndex(store, index);
        }

        this.#record(context, schema);

        await Promise.resolve();
    }

    /**
     * Alter a table.
     */
    static async table(table: string, callback: (table: Blueprint) => void): Promise<void> {
        const context: MigrationContext = this.#context('table');
        const existing: TableSchema = this.#existing(context, table);
        const blueprint: Blueprint = new Blueprint(table, existing);

        callback(blueprint);

        const schema: TableSchema = blueprint.toSchema();
        const operations: BlueprintOperations = blueprint.operations();

        this.#immovable(existing, operations);

        const store: IDBObjectStore = context.transaction.objectStore(table);

        await this.#check(store, schema, operations);

        // Indexes are removed before the rewrite and created after it, so neither an index on its
        // way out nor one still to be built can reject a row the rewrite writes.
        for (const name of operations.unindexed) {
            store.deleteIndex(name);
        }

        await this.#rewrite(store, operations);

        for (const index of operations.indexed) {
            this.#createIndex(store, index);
        }

        this.#record(context, schema);
    }

    /**
     * Drop a table.
     */
    static async drop(table: string): Promise<void> {
        const context: MigrationContext = this.#context('drop');

        this.#existing(context, table);
        this.#delete(context, table);

        await Promise.resolve();
    }

    /**
     * Drop a table, if it exists.
     */
    static async dropIfExists(table: string): Promise<void> {
        const context: MigrationContext = this.#context('dropIfExists');

        if (context.schemas.has(table)) {
            this.#delete(context, table);
        }

        await Promise.resolve();
    }

    /**
     * Rename a table, copying every record into the new one.
     */
    static async rename(from: string, to: string): Promise<void> {
        const context: MigrationContext = this.#context('rename');
        const schema: TableSchema = this.#existing(context, from);

        this.#available(to);

        if (context.database.objectStoreNames.contains(to)) {
            throw new SchemaException(`Table [${to}] already exists.`);
        }

        const target: IDBObjectStore = context.database.createObjectStore(to, this.#options(schema));

        for (const index of schema.indexes) {
            this.#createIndex(target, index);
        }

        const source: IDBObjectStore = context.transaction.objectStore(from);

        await Request.walk(source.openCursor(), (cursor: IDBCursorWithValue): void => {
            if (schema.key === null) {
                target.add(cursor.value, cursor.primaryKey);

                return;
            }

            target.add(cursor.value);
        });

        this.#delete(context, from);
        this.#record(context, { ...schema, table: to });
    }

    /**
     * Get the active migration context, or fail when there is none.
     */
    static #context(operation: string): MigrationContext {
        if (Migrator.context() === null) {
            throw new SchemaException(`Schema.${operation}() may only be called inside a migration.`);
        }

        return Migrator.alive();
    }

    /**
     * Get the schema of a table that must already exist.
     */
    static #existing(context: MigrationContext, table: string): TableSchema {
        const schema: TableSchema | undefined = context.schemas.get(table);

        if (schema === undefined) {
            throw new TableNotFoundException(table);
        }

        return schema;
    }

    /**
     * Assert the table name is not reserved by the database layer.
     */
    static #available(table: string): void {
        if (this.reserved().includes(table)) {
            throw new ReservedTableException(table);
        }
    }

    /**
     * Assert the operations leave the key path of the table alone.
     */
    static #immovable(existing: TableSchema, operations: BlueprintOperations): void {
        if (existing.key === null) {
            return;
        }

        const moved: boolean = operations.dropped.includes(existing.key)
            || operations.renamed.some((rename: RenamedColumn): boolean => rename.from === existing.key);

        if (moved) {
            throw new SchemaException(`Column [${existing.key}] is the key path of table [${existing.table}] and may not be dropped or renamed.`);
        }

        if (operations.changed.some((change: ChangedColumn): boolean => change.from.name === existing.key)) {
            throw new SchemaException(`Column [${existing.key}] is the key path of table [${existing.table}] and may not be changed.`);
        }
    }

    /**
     * Get the store options describing the key of a table.
     */
    static #options(schema: TableSchema): IDBObjectStoreParameters {
        if (schema.key === null) {
            return { autoIncrement: true };
        }

        return { keyPath: schema.key, autoIncrement: schema.increments };
    }

    /**
     * Create an index on a store.
     */
    static #createIndex(store: IDBObjectStore, index: IndexSchema): void {
        const path: string | string[] = index.columns.length === 1 ? index.columns[0] as string : index.columns;

        store.createIndex(index.name, path, { unique: index.unique, multiEntry: index.multiEntry });
    }

    /**
     * Refuse the operations when a record, once rewritten, would break an added column, a changed column or a unique index.
     */
    static async #check(store: IDBObjectStore, schema: TableSchema, operations: BlueprintOperations): Promise<void> {
        const filled: string[] = operations.changed
            .filter((change: ChangedColumn): boolean => change.to.hasDefault)
            .map((change: ChangedColumn): string => change.to.name);

        const added: ColumnSchema[] = operations.added.filter((column: ColumnSchema): boolean => !column.nullable && !column.hasDefault);
        const unfilled: Set<string> = new Set<string>();
        let lacking: number = 0;

        const required: Tally[] = operations.changed
            .filter((change: ChangedColumn): boolean => change.from.nullable && !change.to.nullable && !change.to.hasDefault)
            .map((change: ChangedColumn): Tally => ({ change, count: 0 }));

        const narrowed: Tally[] = operations.changed
            .filter((change: ChangedColumn): boolean => this.#lost(change).length > 0)
            .map((change: ChangedColumn): Tally => ({ change, count: 0 }));

        // A new unique index has never seen the records, and one kept over a changed column may be
        // handed defaults it has not seen either.
        const unique: IndexSchema[] = schema.indexes.filter((index: IndexSchema): boolean => index.unique
            && (operations.indexed.some((created: IndexSchema): boolean => created.name === index.name)
                || index.columns.some((column: string): boolean => filled.includes(column))));

        if (added.length === 0 && required.length === 0 && narrowed.length === 0 && unique.length === 0) {
            return;
        }

        const keys: KeyedRow[][] = unique.map((): KeyedRow[] => []);
        let row: number = 0;

        await Request.walk(store.openCursor(), (cursor: IDBCursorWithValue): void => {
            const record: Record<string, unknown> = this.#rewritten(cursor.value, operations);
            const empty: ColumnSchema[] = added.filter((column: ColumnSchema): boolean => this.#empty(record[column.name]));

            for (const column of empty) {
                unfilled.add(column.name);
            }

            if (empty.length > 0) {
                lacking++;
            }

            for (const tally of required) {
                if (this.#empty(record[tally.change.to.name])) {
                    tally.count++;
                }
            }

            for (const tally of narrowed) {
                if ((this.#lost(tally.change) as unknown[]).includes(record[tally.change.to.name])) {
                    tally.count++;
                }
            }

            unique.forEach((index: IndexSchema, position: number): void => {
                for (const key of this.#keysOf(index, record)) {
                    (keys[position] as KeyedRow[]).push({ key, row });
                }
            });

            row++;
        });

        if (lacking > 0) {
            const columns: string[] = added
                .map((column: ColumnSchema): string => column.name)
                .filter((column: string): boolean => unfilled.has(column));

            const named: string = columns.length === 1 ? `Column [${columns[0]}]` : `Columns [${columns.join(', ')}]`;

            throw new SchemaException(`${named} of table [${schema.table}] cannot be added as required without a default, because ${columns.length === 1 ? 'it' : 'they'} would hold no value in ${this.#rows(lacking)}.`);
        }

        for (const tally of required) {
            if (tally.count > 0) {
                throw new SchemaException(`Column [${tally.change.to.name}] of table [${schema.table}] cannot be made required without a default, because it holds no value in ${this.#rows(tally.count)}.`);
            }
        }

        for (const tally of narrowed) {
            if (tally.count > 0) {
                throw new SchemaException(`Column [${tally.change.to.name}] of table [${schema.table}] cannot stop accepting [${this.#lost(tally.change).join(', ')}], which it still holds in ${this.#rows(tally.count)}.`);
            }
        }

        unique.forEach((index: IndexSchema, position: number): void => {
            const repeated: number = this.#repeated(keys[position] as KeyedRow[]);

            if (repeated > 0) {
                throw new SchemaException(`Index [${index.name}] of table [${schema.table}] cannot be unique, because ${this.#rows(repeated)} repeat a value of [${index.columns.join(', ')}].`);
            }
        });
    }

    /**
     * Get the values an enumerated column stops accepting.
     */
    static #lost(change: ChangedColumn): string[] {
        const kept: string[] = change.to.values ?? [];

        return (change.from.values ?? []).filter((value: string): boolean => !kept.includes(value));
    }

    /**
     * Determine whether a column holds no value.
     */
    static #empty(value: unknown): boolean {
        return value === null || value === undefined;
    }

    /**
     * Get the keys a record holds in an index, leaving out any IndexedDB would not index.
     */
    static #keysOf(index: IndexSchema, record: Record<string, unknown>): IDBValidKey[] {
        const value: unknown = index.columns.length === 1
            ? record[index.columns[0] as string]
            : index.columns.map((column: string): unknown => record[column]);

        const candidates: unknown[] = index.multiEntry && Array.isArray(value) ? value : [value];

        return candidates.filter((candidate: unknown): candidate is IDBValidKey => this.#keyable(candidate));
    }

    /**
     * Determine whether IndexedDB accepts the value as a key.
     */
    static #keyable(value: unknown): boolean {
        try {
            indexedDB.cmp(value, value);

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Count the rows holding a key some other row holds too.
     */
    static #repeated(entries: KeyedRow[]): number {
        const sorted: KeyedRow[] = [...entries].sort((first: KeyedRow, second: KeyedRow): number => indexedDB.cmp(first.key, second.key));
        const runs: Set<number>[] = [];
        let run: Set<number> = new Set<number>();
        let previous: IDBValidKey | null = null;

        for (const entry of sorted) {
            if (previous === null || indexedDB.cmp(entry.key, previous) !== 0) {
                run = new Set<number>();

                runs.push(run);
            }

            run.add(entry.row);
            previous = entry.key;
        }

        // A multi entry index may list one row twice under the same key, which is no conflict, so
        // a run of equal keys counts only when it spans more than one row.
        const repeated: Set<number> = new Set<number>();

        for (const rows of runs.filter((candidate: Set<number>): boolean => candidate.size > 1)) {
            rows.forEach((row: number): void => {
                repeated.add(row);
            });
        }

        return repeated.size;
    }

    /**
     * Describe a number of rows.
     */
    static #rows(count: number): string {
        return count === 1 ? '1 row' : `${count} rows`;
    }

    /**
     * Rewrite every record of a store to match the applied operations.
     */
    static async #rewrite(store: IDBObjectStore, operations: BlueprintOperations): Promise<void> {
        const rewrites: boolean = operations.added.some((column: ColumnSchema): boolean => column.hasDefault)
            || operations.dropped.length > 0
            || operations.renamed.length > 0
            || operations.changed.some((change: ChangedColumn): boolean => change.to.hasDefault);

        if (!rewrites) {
            return;
        }

        await Request.walk(store.openCursor(), (cursor: IDBCursorWithValue): void => {
            cursor.update(this.#rewritten(cursor.value, operations));
        });
    }

    /**
     * Apply the operations to a copy of a record.
     */
    static #rewritten(value: unknown, operations: BlueprintOperations): Record<string, unknown> {
        const record: Record<string, unknown> = { ...value as Record<string, unknown> };

        for (const rename of operations.renamed) {
            record[rename.to] = record[rename.from];

            delete record[rename.from];
        }

        for (const column of operations.dropped) {
            delete record[column];
        }

        for (const column of operations.added) {
            if (column.hasDefault && (!Object.hasOwn(record, column.name) || (!column.nullable && this.#empty(record[column.name])))) {
                record[column.name] = column.default;
            }
        }

        for (const change of operations.changed) {
            if (!change.to.hasDefault) {
                continue;
            }

            // A missing value takes the default, as it would for an added column. Null is a value
            // in its own right and is kept, unless the column is becoming required.
            const required: boolean = change.from.nullable && !change.to.nullable;

            if (!Object.hasOwn(record, change.to.name) || (required && this.#empty(record[change.to.name]))) {
                record[change.to.name] = change.to.default;
            }
        }

        return record;
    }

    /**
     * Record the schema of a table, in the registry and the context cache.
     */
    static #record(context: MigrationContext, schema: TableSchema): void {
        Registry.put(context.transaction, schema);

        context.schemas.set(schema.table, schema);
    }

    /**
     * Delete a table, from the database, the registry and the context cache.
     */
    static #delete(context: MigrationContext, table: string): void {
        context.database.deleteObjectStore(table);

        Registry.forget(context.transaction, table);

        context.schemas.delete(table);
    }
}
