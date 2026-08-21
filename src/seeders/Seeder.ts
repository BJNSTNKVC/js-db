import type { Connection } from '../database/Connection'

export abstract class Seeder {
    /**
     * Seed the database.
     */
    abstract run(connection: Connection): void | Promise<void>

    /**
     * Get the name of the seeder.
     */
    name(): string {
        return this.constructor.name
    }
}
