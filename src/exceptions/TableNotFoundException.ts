export class TableNotFoundException extends Error {
    /**
     * Create a new exception for a missing table.
     */
    constructor(table: string) {
        super(`Table [${table}] does not exist.`);

        this.name = 'TableNotFoundException';
    }
}
