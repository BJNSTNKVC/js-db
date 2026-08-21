export class SchemaException extends Error {
    /**
     * Create a new exception for a failed schema operation.
     */
    constructor(message: string = 'Schema operation failed.') {
        super(message);

        this.name = 'SchemaException';
    }
}
