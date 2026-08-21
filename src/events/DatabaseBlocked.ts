export class DatabaseBlocked extends Event {
    /**
     * The name of the database.
     */
    readonly #database: string;

    /**
     * Create a new Database Blocked event instance.
     */
    constructor(database: string) {
        super('db:database-blocked');

        this.#database = database;
    }

    /**
     * Get the name of the database.
     */
    get database(): string {
        return this.#database;
    }
}
