export class SeedingEnded extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string

    /**
     * The names of the seeders.
     */
    readonly #seeders: string[]

    /**
     * Create a new Seeding Ended event instance.
     */
    constructor(connection: string, seeders: string[]) {
        super('db:seeding-ended')

        this.#connection = connection
        this.#seeders = seeders
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection
    }

    /**
     * Get the names of the seeders.
     */
    get seeders(): string[] {
        return this.#seeders
    }
}
