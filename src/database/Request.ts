export class Request {
    /**
     * Resolve when the request succeeds, reject when it fails.
     */
    static settle<T>(request: IDBRequest<T>, tolerate: boolean = false): Promise<T> {
        return new Promise<T>((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
            request.onsuccess = (): void => resolve(request.result);

            request.onerror = (event: Event): void => {
                // A tolerated failure keeps the surrounding transaction alive, so the caller may go
                // on reading from it. That is how a violated constraint is traced back to the index
                // that raised it. Preventing the default stops the abort, and stopping propagation
                // keeps the error from reaching the transaction at all.
                if (tolerate) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                reject(request.error);
            };
        });
    }

    /**
     * Walk a cursor, invoking the callback for each record until it asks to stop.
     */
    static walk<T extends IDBCursor>(request: IDBRequest<T | null>, callback: (cursor: T) => boolean | void): Promise<void> {
        return new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            request.onsuccess = (): void => {
                const cursor: T | null = request.result;

                if (cursor === null) {
                    resolve();

                    return;
                }

                if (callback(cursor) === false) {
                    resolve();

                    return;
                }

                cursor.continue();
            };

            request.onerror = (): void => reject(request.error);
        });
    }
}
