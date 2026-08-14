export class MigrationEnded extends Event {
    /**
     * The name of the migration.
     */
    readonly #migration: string

    /**
     * Create a new Migration Ended event instance.
     */
    constructor(migration: string) {
        super('db:migration-ended')

        this.#migration = migration
    }

    /**
     * Get the name of the migration.
     */
    get migration(): string {
        return this.#migration
    }
}
