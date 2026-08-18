export class Dispatcher {
    /**
     * The target every database event is dispatched through.
     */
    static readonly #target: EventTarget = new EventTarget()

    /**
     * Dispatch an event to the registered listeners.
     */
    static dispatch(event: Event): void {
        this.#target.dispatchEvent(event)
    }

    /**
     * Register a listener for an event type.
     */
    static listen(type: string, listener: (event: Event) => void, once: boolean = false): void {
        this.#target.addEventListener(type, listener as EventListener, { once })
    }

    /**
     * Remove a listener for an event type.
     */
    static forget(type: string, listener: (event: Event) => void): void {
        this.#target.removeEventListener(type, listener as EventListener)
    }
}
