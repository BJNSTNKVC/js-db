export abstract class Seeder {
    /**
     * Seed the database.
     */
    abstract run(): void | Promise<void>;

    /**
     * Get the name of the seeder.
     */
    name(): string {
        return this.constructor.name;
    }
}
