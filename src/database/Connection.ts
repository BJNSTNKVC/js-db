import { DatabaseBlocked } from '../events'
import { Dispatcher } from '../events/Dispatcher'
import { DatabaseBlockedException, MigrationMismatchException, TableNotFoundException } from '../exceptions'
import { Migrator } from '../migrations/Migrator'
import { Repository } from '../migrations/Repository'
import { Registry } from '../schema/Registry'
import { Builder } from '../query/Builder'
import type { MigrationConstructor, MigrationRecord, MigrationStatus } from '../migrations/types'
import type { TableSchema } from '../schema/types'
import type { ConnectionConfig } from './types'

export class Connection {
    /**
     * The name of the connection.
     */
    readonly #name: string

    /**
     * The configuration of the connection.
     */
    readonly #config: ConnectionConfig

    /**
     * The open database handle.
     */
    #database: IDBDatabase | null = null

    /**
     * The open in flight, so concurrent callers share one handle.
     */
    #opening: Promise<IDBDatabase> | null = null

    /**
     * The table schemas, read once per open and held in memory.
     */
    #schemas: Map<string, TableSchema> = new Map<string, TableSchema>()

    /**
     * The names of the migrations run by the last open.
     */
    #migrated: string[] = []

    /**
     * Create a new connection.
     */
    constructor(name: string, config: ConnectionConfig) {
        this.#name = name
        this.#config = config
    }

    /**
     * Get the name of the connection.
     */
    get name(): string {
        return this.#name
    }

    /**
     * Get the name of the underlying database.
     */
    get database(): string {
        return this.#config.database
    }

    /**
     * Determine whether the connection enforces its column declarations.
     */
    get strict(): boolean {
        return this.#config.strict !== false
    }

    /**
     * Get the migrations registered on the connection.
     */
    get migrations(): MigrationConstructor[] {
        return this.#config.migrations ?? []
    }

    /**
     * Open the underlying database, running any pending migrations.
     */
    async open(): Promise<IDBDatabase> {
        if (this.#database !== null) {
            return this.#database
        }

        if (this.#opening === null) {
            this.#opening = this.#connect()
        }

        try {
            return await this.#opening
        } finally {
            this.#opening = null
        }
    }

    /**
     * Run any pending migrations, returning the names of those that ran.
     */
    async migrate(): Promise<string[]> {
        await this.open()

        return this.#migrated
    }

    /**
     * Delete the database and replay every migration.
     */
    async fresh(): Promise<string[]> {
        this.disconnect()

        await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.deleteDatabase(this.#config.database)

            request.onsuccess = (): void => resolve()
            request.onerror = (): void => reject(request.error)

            request.onblocked = (): void => {
                Dispatcher.dispatch(new DatabaseBlocked(this.#config.database))

                reject(new DatabaseBlockedException(this.#config.database))
            }
        })

        return this.migrate()
    }

    /**
     * Get the state of every registered migration, without running any of them.
     */
    async status(): Promise<MigrationStatus[]> {
        const applied: Map<string, string> = new Map<string, string>(
            (await this.#recorded()).map((record: MigrationRecord): [string, string] => [record.migration, record.at]),
        )

        return Migrator.names(this.migrations).map((migration: string): MigrationStatus => ({
            migration,
            ran: applied.has(migration),
            at : applied.get(migration) ?? null,
        }))
    }

    /**
     * Begin a query against a table.
     */
    table<T = Record<string, unknown>>(table: string, transaction: IDBTransaction | null = null): Builder<T> {
        return new Builder<T>(this, table, transaction)
    }

    /**
     * Get the schema of a table.
     */
    async schema(table: string): Promise<TableSchema> {
        await this.open()

        const schema: TableSchema | undefined = this.#schemas.get(table)

        if (schema === undefined) {
            throw new TableNotFoundException(table)
        }

        return schema
    }

    /**
     * Get the names of every table.
     */
    async tables(): Promise<string[]> {
        await this.open()

        return [...this.#schemas.keys()]
    }

    /**
     * Close the underlying database.
     */
    disconnect(): void {
        this.#database?.close()

        this.#database = null
        this.#schemas = new Map<string, TableSchema>()
    }

    /**
     * Open the database at the version the registered migrations ask for.
     */
    #connect(): Promise<IDBDatabase> {
        const migrations: MigrationConstructor[] = this.migrations
        const version: number = Migrator.version(migrations)

        return new Promise<IDBDatabase>((resolve: (database: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(this.#config.database, version)
            let runner: Promise<string[]> | null = null
            let failure: unknown = null

            request.onupgradeneeded = (event: IDBVersionChangeEvent): void => {
                runner = Migrator.run(
                    this.#name,
                    request.result,
                    request.transaction as IDBTransaction,
                    migrations,
                    Migrator.pending(event.oldVersion),
                    new Date(),
                )

                // The transaction is nulled once it finishes, so it is only ever aborted while live.
                runner.catch((error: unknown): void => {
                    failure = error

                    request.transaction?.abort()
                })
            }

            request.onblocked = (): void => {
                Dispatcher.dispatch(new DatabaseBlocked(this.#config.database))

                reject(new DatabaseBlockedException(this.#config.database))
            }

            request.onerror = (): void => {
                if (failure !== null) {
                    reject(failure)

                    return
                }

                // A stored version above the one the registered migrations ask for can only mean
                // migrations were removed, so report that rather than the raw platform error.
                if (request.error?.name === 'VersionError') {
                    this.#recorded().then(
                        (ran: MigrationRecord[]): void => reject(new MigrationMismatchException(ran.map((record: MigrationRecord): string => record.migration), Migrator.names(migrations))),
                        reject,
                    )

                    return
                }

                reject(request.error)
            }

            request.onsuccess = (): void => {
                this.#ready(request.result, runner).then(resolve, reject)
            }
        })
    }

    /**
     * Get the recorded migrations, opening at whatever version is already stored.
     */
    async #recorded(): Promise<MigrationRecord[]> {
        const database: IDBDatabase = await new Promise<IDBDatabase>((resolve: (database: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(this.#config.database)

            request.onsuccess = (): void => resolve(request.result)
            request.onerror = (): void => reject(request.error)
        })

        try {
            if (!database.objectStoreNames.contains(Repository.table)) {
                return []
            }

            return await Repository.ran(database.transaction(Repository.table, 'readonly'))
        } finally {
            database.close()
        }
    }

    /**
     * Finish opening: await the migrations, verify them and cache the schemas.
     */
    async #ready(database: IDBDatabase, runner: Promise<string[]> | null): Promise<IDBDatabase> {
        this.#migrated = runner === null ? [] : await runner

        const transaction: IDBTransaction = database.transaction([Repository.table, Registry.table], 'readonly')
        const records: Promise<MigrationRecord[]> = Repository.ran(transaction)
        const schemas: Promise<TableSchema[]> = Registry.all(transaction)

        const [ran, registry]: [MigrationRecord[], TableSchema[]] = await Promise.all([records, schemas])

        Migrator.verify(ran, Migrator.names(this.migrations))

        this.#schemas = new Map<string, TableSchema>(registry.map((schema: TableSchema): [string, TableSchema] => [schema.table, schema]))
        this.#database = database

        database.onversionchange = (): void => this.disconnect()

        return database
    }
}
