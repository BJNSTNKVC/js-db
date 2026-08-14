export class MigrationStarted extends Event {
    /**
     * The name of the migration.
     */
    readonly #migration: string

    /**
     * Create a new Migration Started event instance.
     */
    constructor(migration: string) {
        super('db:migration-started')

        this.#migration = migration
    }

    /**
     * Get the name of the migration.
     */
    get migration(): string {
        return this.#migration
    }
}
