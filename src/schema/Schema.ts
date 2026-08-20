import { DatabaseManager } from '../database/DatabaseManager'
import { Request } from '../database/Request'
import { ReservedTableException, SchemaException, TableNotFoundException } from '../exceptions'
import { Migrator } from '../migrations/Migrator'
import { Repository } from '../migrations/Repository'
import { Blueprint } from './Blueprint'
import { Registry } from './Registry'
import type { Connection } from '../database/Connection'
import type { MigrationContext } from '../migrations/Migrator'
import type { BlueprintOperations, ColumnSchema, IndexSchema, RenamedColumn, TableSchema } from './types'

export class Schema {
    /**
     * Get the table names the database layer reserves for itself.
     */
    static reserved(): string[] {
        return [Repository.table, Registry.table]
    }

    /**
     * Get a connection to read schema information from.
     */
    static connection(name?: string): Connection {
        return DatabaseManager.connection(name)
    }

    /**
     * Determine whether a table exists.
     */
    static hasTable(table: string): Promise<boolean> {
        return this.connection().hasTable(table)
    }

    /**
     * Determine whether a table has a column.
     */
    static hasColumn(table: string, column: string): Promise<boolean> {
        return this.connection().hasColumn(table, column)
    }

    /**
     * Get the names of every table.
     */
    static getTables(): Promise<string[]> {
        return this.connection().tables()
    }

    /**
     * Get the columns of a table.
     */
    static getColumns(table: string): Promise<ColumnSchema[]> {
        return this.connection().getColumns(table)
    }

    /**
     * Get the indexes of a table.
     */
    static getIndexes(table: string): Promise<IndexSchema[]> {
        return this.connection().getIndexes(table)
    }

    /**
     * Create a table.
     */
    static async create(table: string, callback: (table: Blueprint) => void): Promise<void> {
        const context: MigrationContext = this.#context('create')

        this.#available(table)

        if (context.database.objectStoreNames.contains(table)) {
            throw new SchemaException(`Table [${table}] already exists.`)
        }

        const blueprint: Blueprint = new Blueprint(table)

        callback(blueprint)

        const schema: TableSchema = blueprint.toSchema()
        const store: IDBObjectStore = context.database.createObjectStore(table, this.#options(schema))

        for (const index of schema.indexes) {
            this.#createIndex(store, index)
        }

        this.#record(context, schema)

        await Promise.resolve()
    }

    /**
     * Alter a table.
     */
    static async table(table: string, callback: (table: Blueprint) => void): Promise<void> {
        const context: MigrationContext = this.#context('table')
        const existing: TableSchema = this.#existing(context, table)
        const blueprint: Blueprint = new Blueprint(table, existing)

        callback(blueprint)

        const schema: TableSchema = blueprint.toSchema()
        const operations: BlueprintOperations = blueprint.operations()

        this.#immovable(existing, operations)

        const store: IDBObjectStore = context.transaction.objectStore(table)

        for (const name of operations.unindexed) {
            store.deleteIndex(name)
        }

        for (const index of operations.indexed) {
            this.#createIndex(store, index)
        }

        await this.#rewrite(store, operations)

        this.#record(context, schema)
    }

    /**
     * Drop a table.
     */
    static async drop(table: string): Promise<void> {
        const context: MigrationContext = this.#context('drop')

        this.#existing(context, table)
        this.#delete(context, table)

        await Promise.resolve()
    }

    /**
     * Drop a table, if it exists.
     */
    static async dropIfExists(table: string): Promise<void> {
        const context: MigrationContext = this.#context('dropIfExists')

        if (context.schemas.has(table)) {
            this.#delete(context, table)
        }

        await Promise.resolve()
    }

    /**
     * Rename a table, copying every record into the new one.
     */
    static async rename(from: string, to: string): Promise<void> {
        const context: MigrationContext = this.#context('rename')
        const schema: TableSchema = this.#existing(context, from)

        this.#available(to)

        if (context.database.objectStoreNames.contains(to)) {
            throw new SchemaException(`Table [${to}] already exists.`)
        }

        const target: IDBObjectStore = context.database.createObjectStore(to, this.#options(schema))

        for (const index of schema.indexes) {
            this.#createIndex(target, index)
        }

        const source: IDBObjectStore = context.transaction.objectStore(from)

        await Request.walk(source.openCursor(), (cursor: IDBCursorWithValue): void => {
            if (schema.key === null) {
                target.add(cursor.value, cursor.primaryKey)

                return
            }

            target.add(cursor.value)
        })

        this.#delete(context, from)
        this.#record(context, { ...schema, table: to })
    }

    /**
     * Get the active migration context, or fail when there is none.
     */
    static #context(operation: string): MigrationContext {
        if (Migrator.context() === null) {
            throw new SchemaException(`Schema.${operation}() may only be called inside a migration.`)
        }

        return Migrator.alive()
    }

    /**
     * Get the schema of a table that must already exist.
     */
    static #existing(context: MigrationContext, table: string): TableSchema {
        const schema: TableSchema | undefined = context.schemas.get(table)

        if (schema === undefined) {
            throw new TableNotFoundException(table)
        }

        return schema
    }

    /**
     * Assert the table name is not reserved by the database layer.
     */
    static #available(table: string): void {
        if (this.reserved().includes(table)) {
            throw new ReservedTableException(table)
        }
    }

    /**
     * Assert the operations leave the key path of the table alone.
     */
    static #immovable(existing: TableSchema, operations: BlueprintOperations): void {
        if (existing.key === null) {
            return
        }

        const moved: boolean = operations.dropped.includes(existing.key)
            || operations.renamed.some((rename: RenamedColumn): boolean => rename.from === existing.key)

        if (moved) {
            throw new SchemaException(`Column [${existing.key}] is the key path of table [${existing.table}] and may not be dropped or renamed.`)
        }
    }

    /**
     * Get the store options describing the key of a table.
     */
    static #options(schema: TableSchema): IDBObjectStoreParameters {
        if (schema.key === null) {
            return { autoIncrement: true }
        }

        return { keyPath: schema.key, autoIncrement: schema.increments }
    }

    /**
     * Create an index on a store.
     */
    static #createIndex(store: IDBObjectStore, index: IndexSchema): void {
        const path: string | string[] = index.columns.length === 1 ? index.columns[0] as string : index.columns

        store.createIndex(index.name, path, { unique: index.unique, multiEntry: index.multiEntry })
    }

    /**
     * Rewrite every record of a store to match the applied operations.
     */
    static async #rewrite(store: IDBObjectStore, operations: BlueprintOperations): Promise<void> {
        const backfill: ColumnSchema[] = operations.added.filter((column: ColumnSchema): boolean => column.hasDefault)

        if (backfill.length === 0 && operations.dropped.length === 0 && operations.renamed.length === 0) {
            return
        }

        await Request.walk(store.openCursor(), (cursor: IDBCursorWithValue): void => {
            const record: Record<string, unknown> = { ...cursor.value as Record<string, unknown> }

            for (const column of backfill) {
                if (!Object.hasOwn(record, column.name)) {
                    record[column.name] = column.default
                }
            }

            for (const rename of operations.renamed) {
                record[rename.to] = record[rename.from]

                delete record[rename.from]
            }

            for (const column of operations.dropped) {
                delete record[column]
            }

            cursor.update(record)
        })
    }

    /**
     * Record the schema of a table, in the registry and the context cache.
     */
    static #record(context: MigrationContext, schema: TableSchema): void {
        Registry.put(context.transaction, schema)

        context.schemas.set(schema.table, schema)
    }

    /**
     * Delete a table, from the database, the registry and the context cache.
     */
    static #delete(context: MigrationContext, table: string): void {
        context.database.deleteObjectStore(table)

        Registry.forget(context.transaction, table)

        context.schemas.delete(table)
    }
}
