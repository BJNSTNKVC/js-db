export class QuotaExceededException extends Error {
    /**
     * Create a new exception for storage the browser refused to grant.
     */
    constructor(message: string = 'The storage quota for this origin is full. Free some space, or ask the user to, before writing again.') {
        super(message);

        this.name = 'QuotaExceededException';
    }
}
