export class ReservedTableException extends Error {
    /**
     * Create a new exception for a table name reserved by the database layer.
     */
    constructor(table: string) {
        super(`Table name [${table}] is reserved by the database layer.`);

        this.name = 'ReservedTableException';
    }
}
