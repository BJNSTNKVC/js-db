export class MigrationsEnded extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string

    /**
     * The names of the migrations.
     */
    readonly #migrations: string[]

    /**
     * Create a new Migrations Ended event instance.
     */
    constructor(connection: string, migrations: string[]) {
        super('db:migrations-ended')

        this.#connection = connection
        this.#migrations = migrations
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection
    }

    /**
     * Get the names of the migrations.
     */
    get migrations(): string[] {
        return this.#migrations
    }
}
