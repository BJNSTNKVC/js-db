export class UniqueConstraintViolationException extends Error {
    /**
     * Create a new exception for a violated unique index.
     */
    constructor(table: string, index: string) {
        super(`Unique constraint violated on index [${index}] of table [${table}].`);

        this.name = 'UniqueConstraintViolationException';
    }
}
