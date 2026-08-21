export class DatabaseBlockedException extends Error {
    /**
     * Create a new exception for a database blocked by another connection.
     */
    constructor(database: string) {
        super(`Database [${database}] is blocked by a connection in another tab holding an older version. Close the other tabs and try again.`);

        this.name = 'DatabaseBlockedException';
    }
}
