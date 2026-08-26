export class MultipleRecordsFoundException extends Error {
    /**
     * Create a new exception for a query that matched more records than it should.
     */
    constructor(table: string) {
        super(`More than one record found in table [${table}], where exactly one was expected.`);

        this.name = 'MultipleRecordsFoundException';
    }
}
