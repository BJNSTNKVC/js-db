export class CheckConstraintViolationException extends Error {
    /**
     * Create a new exception for a value the column does not accept.
     */
    constructor(table: string, column: string, value: unknown, accepted: string[]) {
        super(`Column [${column}] of table [${table}] does not accept [${String(value)}]. It accepts [${accepted.join(', ')}].`);

        this.name = 'CheckConstraintViolationException';
    }
}
