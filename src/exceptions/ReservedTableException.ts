export class ReservedTableException extends Error {
    /**
     * Create a new exception for a reserved table name.
     */
    constructor(table: string) {
        super(`Table name [${table}] is reserved by the database layer.`);

        this.name = 'ReservedTableException';
    }
}
