export class SeederStarted extends Event {
    /**
     * The name of the seeder.
     */
    readonly #seeder: string

    /**
     * Create a new Seeder Started event instance.
     */
    constructor(seeder: string) {
        super('db:seeder-started')

        this.#seeder = seeder
    }

    /**
     * Get the name of the seeder.
     */
    get seeder(): string {
        return this.#seeder
    }
}
