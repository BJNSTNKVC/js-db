import { Dispatcher } from '../events/Dispatcher'
import { MigrationEnded, MigrationsEnded, MigrationsStarted, MigrationStarted, NoPendingMigrations } from '../events'
import { MigrationMismatchException, MigrationTransactionClosedException } from '../exceptions'
import { Registry } from '../schema/Registry'
import { Repository } from './Repository'
import type { TableSchema } from '../schema/types'
import type { Migration } from './Migration'
import type { MigrationConstructor, MigrationRecord } from './types'

export interface MigrationContext {
    database: IDBDatabase
    transaction: IDBTransaction
    migration: string
    schemas: Map<string, TableSchema>
    alive: boolean
}

export class Migrator {
    /**
     * The context of the migration currently running.
     */
    static #context: MigrationContext | null = null

    /**
     * Get the context of the migration currently running.
     */
    static context(): MigrationContext | null {
        return this.#context
    }

    /**
     * Get the version a database with the given migrations should be opened at.
     */
    static version(migrations: MigrationConstructor[]): number {
        return migrations.length + 1
    }

    /**
     * Get the index of the first migration still pending at the given version.
     */
    static pending(version: number): number {
        return Math.max(0, version - 1)
    }

    /**
     * Get the names of the given migrations, in order.
     */
    static names(migrations: MigrationConstructor[]): string[] {
        return migrations.map((migration: MigrationConstructor): string => new migration().name())
    }

    /**
     * Assert that the migrations already run are a prefix of those registered.
     */
    static verify(ran: MigrationRecord[], registered: string[]): void {
        const applied: string[] = ran.map((record: MigrationRecord): string => record.migration)

        const diverged: boolean = applied.length > registered.length
            || applied.some((migration: string, index: number): boolean => registered[index] !== migration)

        if (diverged) {
            throw new MigrationMismatchException(applied, registered)
        }
    }

    /**
     * Assert that the active migration still holds its transaction.
     */
    static alive(): MigrationContext {
        const context: MigrationContext | null = this.#context

        if (context === null) {
            throw new MigrationTransactionClosedException('unknown')
        }

        if (!context.alive) {
            throw new MigrationTransactionClosedException(context.migration)
        }

        return context
    }

    /**
     * Run the migrations still pending inside the version change transaction.
     */
    static async run(connection: string, database: IDBDatabase, transaction: IDBTransaction, migrations: MigrationConstructor[], from: number, at: Date): Promise<string[]> {
        Repository.create(database)
        Registry.create(database)

        const records: Promise<MigrationRecord[]> = Repository.ran(transaction)
        const registry: Promise<TableSchema[]> = Registry.all(transaction)

        const [ran, schemas]: [MigrationRecord[], TableSchema[]] = await Promise.all([records, registry])

        this.verify(ran, this.names(migrations))

        this.#context = {
            database,
            transaction,
            migration: 'unknown',
            schemas  : new Map<string, TableSchema>(schemas.map((schema: TableSchema): [string, TableSchema] => [schema.table, schema])),
            alive    : true,
        }

        transaction.addEventListener('complete', this.#close)
        transaction.addEventListener('abort', this.#close)

        try {
            return await this.#migrate(connection, migrations, from, at)
        } finally {
            this.#context = null
        }
    }

    /**
     * Run each pending migration in order, recording it as it completes.
     */
    static async #migrate(connection: string, migrations: MigrationConstructor[], from: number, at: Date): Promise<string[]> {
        const pending: MigrationConstructor[] = migrations.slice(from)

        if (pending.length === 0) {
            Dispatcher.dispatch(new NoPendingMigrations(connection))

            return []
        }

        const ran: string[] = []

        Dispatcher.dispatch(new MigrationsStarted(connection, this.names(pending)))

        for (const [offset, constructor] of pending.entries()) {
            const migration: Migration = new constructor()
            const name: string = migration.name()
            const context: MigrationContext = this.alive()

            context.migration = name

            Dispatcher.dispatch(new MigrationStarted(name))

            await migration.up()

            Repository.log(this.alive().transaction, from + offset + 1, name, at)

            Dispatcher.dispatch(new MigrationEnded(name))

            ran.push(name)
        }

        Dispatcher.dispatch(new MigrationsEnded(connection, ran))

        return ran
    }

    /**
     * Mark the active context as no longer holding its transaction.
     */
    static #close = (): void => {
        if (this.#context !== null) {
            this.#context.alive = false
        }
    }
}
