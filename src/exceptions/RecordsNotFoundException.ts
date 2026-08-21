export class RecordsNotFoundException extends Error {
    /**
     * Create a new exception for a query that matched no records.
     */
    constructor(message: string = 'No records found.') {
        super(message);

        this.name = 'RecordsNotFoundException';
    }
}
