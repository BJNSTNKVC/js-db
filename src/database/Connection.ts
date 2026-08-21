import { DatabaseBlocked, SeederEnded, SeederStarted, SeedingEnded, SeedingStarted, TransactionBeginning, TransactionCommitted, TransactionRolledBack } from '../events'
import { Dispatcher } from '../events/Dispatcher'
import { DatabaseBlockedException, MigrationMismatchException, TableNotFoundException } from '../exceptions'
import { Migrator } from '../migrations/Migrator'
import { Repository } from '../migrations/Repository'
import { Registry } from '../schema/Registry'
import { Builder } from '../query/Builder'
import { Transaction } from './Transaction'
import type { MigrationConstructor, MigrationRecord, MigrationStatus } from '../migrations/types'
import type { ColumnSchema, IndexSchema, TableSchema } from '../schema/types'
import type { Seeder } from '../seeders/Seeder'
import type { SeederConstructor } from '../seeders/types'
import type { ConnectionConfig, FreshOptions, TransactionOptions } from './types'

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
     * The transaction currently running, so a nested call joins it.
     */
    #active: Transaction | null = null

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
     * Get the seeders registered on the connection.
     */
    get seeders(): SeederConstructor[] {
        return this.#config.seeders ?? []
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
     * Run any pending migrations, returning the names of those this call ran.
     */
    async migrate(): Promise<string[]> {
        await this.open()

        // Consumed, so a second call on a live connection reports nothing rather than repeating
        // what the first one ran.
        const migrated: string[] = this.#migrated

        this.#migrated = []

        return migrated
    }

    /**
     * Run every registered seeder, returning their names.
     */
    async seed(): Promise<string[]> {
        await this.open()

        const seeders: SeederConstructor[] = this.seeders

        if (seeders.length === 0) {
            return []
        }

        const names: string[] = seeders.map((seeder: SeederConstructor): string => new seeder().name())

        Dispatcher.dispatch(new SeedingStarted(this.#name, names))

        for (const constructor of seeders) {
            const seeder: Seeder = new constructor()
            const name: string = seeder.name()

            Dispatcher.dispatch(new SeederStarted(name))

            // Seeders run one after another outside the version change transaction, and are
            // deliberately not wrapped in a transaction of their own. That is what lets them await
            // a fetch, and it leaves each one free to open a transaction if it wants atomicity.
            // Nothing records that a seeder ran, so one meant to survive repeated boots has to be
            // written idempotently.
            await seeder.run(this)

            Dispatcher.dispatch(new SeederEnded(name))
        }

        Dispatcher.dispatch(new SeedingEnded(this.#name, names))

        return names
    }

    /**
     * Delete the database and replay every migration.
     */
    async fresh(options: FreshOptions = {}): Promise<string[]> {
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

        const migrated: string[] = await this.migrate()

        if (options.seed === true) {
            await this.seed()
        }

        return migrated
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
     * Run the callback inside a transaction, committing when it resolves.
     */
    async transaction<R>(callback: (transaction: Transaction) => R | Promise<R>, options: TransactionOptions = {}): Promise<R> {
        // A nested call joins the transaction already running rather than opening a second one.
        // IndexedDB has no savepoints, so there is no way to roll back only part of one, and two
        // overlapping transactions over the same stores would deadlock.
        if (this.#active !== null) {
            return callback(this.#active)
        }

        const database: IDBDatabase = await this.open()
        const tables: string[] = options.tables ?? Array.from(database.objectStoreNames)
        const handle: IDBTransaction = database.transaction(tables, 'readwrite')
        const transaction: Transaction = new Transaction(this, handle)

        let finished: boolean = false
        let aborting: boolean = false

        // An untolerated request failure bubbles here and takes the transaction down with it, which
        // happens before our own catch runs. Aborting again would then throw.
        handle.onerror = (): void => {
            aborting = true
        }

        const settled: Promise<void> = new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            handle.oncomplete = (): void => {
                finished = true

                resolve()
            }

            handle.onabort = (): void => {
                finished = true

                reject(handle.error ?? new DOMException('The transaction was aborted.', 'AbortError'))
            }
        })

        settled.catch((): void => {
            // A deliberate abort rejects this too, and the original failure is the one worth throwing.
        })

        this.#active = transaction

        Dispatcher.dispatch(new TransactionBeginning(this.#name))

        try {
            // IndexedDB commits a transaction the moment its request queue drains, so the callback
            // may only await operations from this package.
            const result: R = await callback(transaction)

            await settled

            this.#active = null

            Dispatcher.dispatch(new TransactionCommitted(this.#name))

            return result
        } catch (error: unknown) {
            this.#active = null

            // A transaction that already committed cannot be rolled back, so saying it was would be
            // a lie. That only happens when the callback outlived its request queue.
            if (!finished) {
                if (!aborting) {
                    handle.abort()
                }

                Dispatcher.dispatch(new TransactionRolledBack(this.#name, error))
            }

            throw error
        }
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
     * Determine whether a table exists.
     */
    async hasTable(table: string): Promise<boolean> {
        return (await this.tables()).includes(table)
    }

    /**
     * Determine whether a table has a column.
     */
    async hasColumn(table: string, column: string): Promise<boolean> {
        return (await this.getColumns(table)).some((candidate: ColumnSchema): boolean => candidate.name === column)
    }

    /**
     * Get the columns of a table.
     */
    async getColumns(table: string): Promise<ColumnSchema[]> {
        return (await this.schema(table)).columns
    }

    /**
     * Get the indexes of a table.
     */
    async getIndexes(table: string): Promise<IndexSchema[]> {
        return (await this.schema(table)).indexes
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
