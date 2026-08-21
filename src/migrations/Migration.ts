export abstract class Migration {
    /**
     * Run the migration.
     */
    abstract up(): void | Promise<void>;

    /**
     * Get the name of the migration.
     */
    name(): string {
        return this.constructor.name;
    }
}
