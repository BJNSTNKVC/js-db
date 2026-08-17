export class Request {
    /**
     * Resolve when the request succeeds, reject when it fails.
     */
    static settle<T>(request: IDBRequest<T>): Promise<T> {
        return new Promise<T>((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
            request.onsuccess = (): void => resolve(request.result)
            request.onerror = (): void => reject(request.error)
        })
    }

    /**
     * Walk a cursor, invoking the callback for each record until it asks to stop.
     */
    static walk<T extends IDBCursor>(request: IDBRequest<T | null>, callback: (cursor: T) => boolean | void): Promise<void> {
        return new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
            request.onsuccess = (): void => {
                const cursor: T | null = request.result

                if (cursor === null) {
                    resolve()

                    return
                }

                if (callback(cursor) === false) {
                    resolve()

                    return
                }

                cursor.continue()
            }

            request.onerror = (): void => reject(request.error)
        })
    }
}
