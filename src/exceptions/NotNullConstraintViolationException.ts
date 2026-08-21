export class NotNullConstraintViolationException extends Error {
    /**
     * Create a new exception for a null value in a non-nullable column.
     */
    constructor(table: string, column: string) {
        super(`Column [${column}] of table [${table}] may not be null.`);

        this.name = 'NotNullConstraintViolationException';
    }
}
