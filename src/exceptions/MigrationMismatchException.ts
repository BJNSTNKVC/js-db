export class MigrationMismatchException extends Error {
    /**
     * Create a new exception for migrations that diverged from those run.
     */
    constructor(ran: string[], registered: string[]) {
        super(`Registered migrations [${registered.join(', ')}] do not match the migrations already run [${ran.join(', ')}]. Migrations are forward-only, so they may only be appended, never reordered or removed. If your bundler mangles class names, override name() on each migration.`);

        this.name = 'MigrationMismatchException';
    }
}
