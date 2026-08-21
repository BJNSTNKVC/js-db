import type { Constraint, Order } from '../query/types';

export class QueryExecuted extends Event {
    /**
     * The name of the connection the query ran on.
     */
    readonly #connection: string;

    /**
     * The name of the table the query ran against.
     */
    readonly #table: string;

    /**
     * The description of the plan the query ran under.
     */
    readonly #plan: string;

    /**
     * The constraints the query was compiled from.
     */
    readonly #constraints: Constraint[];

    /**
     * The orders the query was compiled from.
     */
    readonly #orders: Order[];

    /**
     * The maximum number of records the query was allowed to return.
     */
    readonly #limit: number | null;

    /**
     * The time the query took in milliseconds.
     */
    readonly #duration: number;

    /**
     * The number of records the query returned or affected.
     */
    readonly #records: number;

    /**
     * Create a new Query Executed event instance.
     */
    constructor(connection: string, table: string, plan: string, constraints: Constraint[], orders: Order[], limit: number | null, duration: number, records: number) {
        super('db:query');

        this.#connection = connection;
        this.#table = table;
        this.#plan = plan;
        this.#constraints = constraints;
        this.#orders = orders;
        this.#limit = limit;
        this.#duration = duration;
        this.#records = records;
    }

    /**
     * Get the name of the connection the query ran on.
     */
    get connection(): string {
        return this.#connection;
    }

    /**
     * Get the name of the table the query ran against.
     */
    get table(): string {
        return this.#table;
    }

    /**
     * Get the description of the plan the query ran under.
     */
    get plan(): string {
        return this.#plan;
    }

    /**
     * Get the constraints the query was compiled from.
     */
    get constraints(): Constraint[] {
        return this.#constraints;
    }

    /**
     * Get the orders the query was compiled from.
     */
    get orders(): Order[] {
        return this.#orders;
    }

    /**
     * Get the maximum number of records the query was allowed to return.
     */
    get limit(): number | null {
        return this.#limit;
    }

    /**
     * Get the time the query took in milliseconds.
     */
    get duration(): number {
        return this.#duration;
    }

    /**
     * Get the number of records the query returned or affected.
     */
    get records(): number {
        return this.#records;
    }
}
