export class DatabaseVersionChanged extends Event {
    /**
     * The name of the database.
     */
    readonly #database: string;

    /**
     * The version the other tab is opening, or null when it is deleting the database.
     */
    readonly #version: number | null;

    /**
     * Create a new Database Version Changed event instance.
     */
    constructor(database: string, version: number | null) {
        super('db:database-version-changed');

        this.#database = database;
        this.#version = version;
    }

    /**
     * Get the name of the database.
     */
    get database(): string {
        return this.#database;
    }

    /**
     * Get the version the other tab is opening, or null when it is deleting the database.
     */
    get version(): number | null {
        return this.#version;
    }
}
