import { Dispatcher } from '../events/Dispatcher'
import { ConnectionNotConfiguredException } from '../exceptions'
import { Connection } from './Connection'
import type {
    DatabaseBlocked,
    DatabaseEvent,
    DatabaseEventListener,
    MigrationEnded,
    MigrationsEnded,
    MigrationsStarted,
    MigrationStarted,
    NoPendingMigrations,
    QueryExecuted,
    TransactionBeginning,
    TransactionCommitted,
    TransactionRolledBack,
} from '../events'
import type { MigrationStatus } from '../migrations/types'
import type { ColumnSchema, IndexSchema } from '../schema/types'
import type { Builder } from '../query/Builder'
import type { Transaction } from './Transaction'
import type { DatabaseConfig, ListenOptions, QueryLogEntry, TransactionOptions } from './types'

export class DatabaseManager {
    /**
     * The registered configuration.
     */
    static #config: DatabaseConfig | null = null

    /**
     * The connections resolved so far, keyed by name.
     */
    static #connections: Map<string, Connection> = new Map<string, Connection>()

    /**
     * The queries recorded while the log is enabled.
     */
    static #log: QueryLogEntry[] = []

    /**
     * The listener recording queries, present only while the log is enabled.
     */
    static #logger: ((event: Event) => void) | null = null

    /**
     * Register the database configuration, replacing anything registered before.
     */
    static configure(config: DatabaseConfig): void {
        for (const connection of this.#connections.values()) {
            connection.disconnect()
        }

        this.#config = config
        this.#connections = new Map<string, Connection>()
    }

    /**
     * Resolve a connection by name, or the default one.
     */
    static connection(name?: string): Connection {
        const config: DatabaseConfig | null = this.#config

        if (config === null) {
            throw new ConnectionNotConfiguredException(name ?? 'default')
        }

        const resolved: string = name ?? config.default
        const cached: Connection | undefined = this.#connections.get(resolved)

        if (cached !== undefined) {
            return cached
        }

        const entry = config.connections[resolved]

        if (entry === undefined) {
            throw new ConnectionNotConfiguredException(resolved)
        }

        const connection: Connection = new Connection(resolved, entry)

        this.#connections.set(resolved, connection)

        return connection
    }

    /**
     * Begin a query against a table on the default connection.
     */
    static table<T = Record<string, unknown>>(table: string): Builder<T> {
        return this.connection().table<T>(table)
    }

    /**
     * Run the callback inside a transaction on the default connection.
     */
    static transaction<R>(callback: (transaction: Transaction) => R | Promise<R>, options?: TransactionOptions): Promise<R> {
        return this.connection().transaction<R>(callback, options)
    }

    /**
     * Run any pending migrations, returning the names of those this call ran.
     *
     * The connection is named rather than defaulted, so an app with several of them cannot boot
     * having silently migrated only one.
     */
    static migrate(name: string): Promise<string[]> {
        return this.connection(name).migrate()
    }

    /**
     * Delete the database and replay every migration.
     */
    static fresh(name?: string): Promise<string[]> {
        return this.connection(name).fresh()
    }

    /**
     * Get the state of every registered migration.
     */
    static status(name?: string): Promise<MigrationStatus[]> {
        return this.connection(name).status()
    }

    /**
     * Determine whether a table exists.
     */
    static hasTable(table: string, name?: string): Promise<boolean> {
        return this.connection(name).hasTable(table)
    }

    /**
     * Determine whether a table has a column.
     */
    static hasColumn(table: string, column: string, name?: string): Promise<boolean> {
        return this.connection(name).hasColumn(table, column)
    }

    /**
     * Get the names of every table.
     */
    static getTables(name?: string): Promise<string[]> {
        return this.connection(name).tables()
    }

    /**
     * Get the columns of a table.
     */
    static getColumns(table: string, name?: string): Promise<ColumnSchema[]> {
        return this.connection(name).getColumns(table)
    }

    /**
     * Get the indexes of a table.
     */
    static getIndexes(table: string, name?: string): Promise<IndexSchema[]> {
        return this.connection(name).getIndexes(table)
    }

    /**
     * Close a connection, leaving it registered so the next query reopens it.
     */
    static disconnect(name?: string): void {
        this.connection(name).disconnect()
    }

    /**
     * Close a connection and drop it, so the next resolve rebuilds it from configuration.
     */
    static purge(name?: string): void {
        const connection: Connection = this.connection(name)

        connection.disconnect()

        this.#connections.delete(connection.name)
    }

    /**
     * Register an event listener.
     *
     * Listeners are persistent unless told otherwise, which is the one deliberate departure from
     * the storage packages, where every listener fires exactly once.
     */
    static listen<K extends keyof DatabaseEvent>(event: K, listener: DatabaseEventListener<K>, options: ListenOptions = {}): void {
        Dispatcher.listen(`db:${event}`, listener as (event: Event) => void, options.once ?? false)
    }

    /**
     * Remove an event listener.
     */
    static forget<K extends keyof DatabaseEvent>(event: K, listener: DatabaseEventListener<K>): void {
        Dispatcher.forget(`db:${event}`, listener as (event: Event) => void)
    }

    /**
     * Register a listener on the "query" event.
     */
    static onQueryExecuted(listener: (event: QueryExecuted) => void, options?: ListenOptions): void {
        this.listen('query', listener, options)
    }

    /**
     * Register a listener on the "transaction-beginning" event.
     */
    static onTransactionBeginning(listener: (event: TransactionBeginning) => void, options?: ListenOptions): void {
        this.listen('transaction-beginning', listener, options)
    }

    /**
     * Register a listener on the "transaction-committed" event.
     */
    static onTransactionCommitted(listener: (event: TransactionCommitted) => void, options?: ListenOptions): void {
        this.listen('transaction-committed', listener, options)
    }

    /**
     * Register a listener on the "transaction-rolled-back" event.
     */
    static onTransactionRolledBack(listener: (event: TransactionRolledBack) => void, options?: ListenOptions): void {
        this.listen('transaction-rolled-back', listener, options)
    }

    /**
     * Register a listener on the "migrations-started" event.
     */
    static onMigrationsStarted(listener: (event: MigrationsStarted) => void, options?: ListenOptions): void {
        this.listen('migrations-started', listener, options)
    }

    /**
     * Register a listener on the "migration-started" event.
     */
    static onMigrationStarted(listener: (event: MigrationStarted) => void, options?: ListenOptions): void {
        this.listen('migration-started', listener, options)
    }

    /**
     * Register a listener on the "migration-ended" event.
     */
    static onMigrationEnded(listener: (event: MigrationEnded) => void, options?: ListenOptions): void {
        this.listen('migration-ended', listener, options)
    }

    /**
     * Register a listener on the "migrations-ended" event.
     */
    static onMigrationsEnded(listener: (event: MigrationsEnded) => void, options?: ListenOptions): void {
        this.listen('migrations-ended', listener, options)
    }

    /**
     * Register a listener on the "no-pending-migrations" event.
     */
    static onNoPendingMigrations(listener: (event: NoPendingMigrations) => void, options?: ListenOptions): void {
        this.listen('no-pending-migrations', listener, options)
    }

    /**
     * Register a listener on the "database-blocked" event.
     */
    static onDatabaseBlocked(listener: (event: DatabaseBlocked) => void, options?: ListenOptions): void {
        this.listen('database-blocked', listener, options)
    }

    /**
     * Start recording every query that runs.
     */
    static enableQueryLog(): void {
        if (this.#logger !== null) {
            return
        }

        this.#logger = (event: Event): void => {
            const query: QueryExecuted = event as QueryExecuted

            this.#log.push({
                connection: query.connection,
                table     : query.table,
                plan      : query.plan,
                duration  : query.duration,
                records   : query.records,
            })
        }

        Dispatcher.listen('db:query', this.#logger)
    }

    /**
     * Stop recording queries.
     */
    static disableQueryLog(): void {
        if (this.#logger === null) {
            return
        }

        Dispatcher.forget('db:query', this.#logger)

        this.#logger = null
    }

    /**
     * Get the recorded queries.
     */
    static getQueryLog(): QueryLogEntry[] {
        return [...this.#log]
    }

    /**
     * Discard the recorded queries.
     */
    static flushQueryLog(): void {
        this.#log = []
    }

    /**
     * Determine whether queries are being recorded.
     */
    static logging(): boolean {
        return this.#logger !== null
    }
}
