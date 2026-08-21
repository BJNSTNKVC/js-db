export class ConnectionNotConfiguredException extends Error {
    /**
     * Create a new exception for an unconfigured connection.
     */
    constructor(connection: string) {
        super(`Database connection [${connection}] is not configured.`);

        this.name = 'ConnectionNotConfiguredException';
    }
}
