export class NoPendingMigrations extends Event {
    /**
     * The name of the connection.
     */
    readonly #connection: string;

    /**
     * Create a new No Pending Migrations event instance.
     */
    constructor(connection: string) {
        super('db:no-pending-migrations');

        this.#connection = connection;
    }

    /**
     * Get the name of the connection.
     */
    get connection(): string {
        return this.#connection;
    }
}
