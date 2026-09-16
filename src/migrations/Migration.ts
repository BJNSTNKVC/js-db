export abstract class Migration {
    /**
     * Run the migration.
     */
    abstract up(): void | Promise<void>;

    /**
     * Get the name of the migration.
     */
    name(): string {
        return this.constructor.name
            .replace(/([a-z\d])([A-Z])/g, '$1_$2')
            .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
            .toLowerCase();
    }
}
