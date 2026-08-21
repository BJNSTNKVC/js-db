export class SeederEnded extends Event {
    /**
     * The name of the seeder.
     */
    readonly #seeder: string;

    /**
     * Create a new Seeder Ended event instance.
     */
    constructor(seeder: string) {
        super('db:seeder-ended');

        this.#seeder = seeder;
    }

    /**
     * Get the name of the seeder.
     */
    get seeder(): string {
        return this.#seeder;
    }
}
