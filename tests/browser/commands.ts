import type { Page, Route } from 'playwright';
import type { BrowserCommand, BrowserCommandContext } from 'vitest/node';

declare module 'vitest/browser' {
    interface BrowserCommands {
        openTab: () => Promise<string>;
        holdDatabase: (tab: string, database: string, version?: number) => Promise<number>;
        upgradeDatabase: (tab: string, database: string, version: number) => Promise<boolean>;
        deleteDatabase: (tab: string, database: string) => Promise<boolean>;
        closeDatabase: (tab: string, database: string) => Promise<void>;
        closeTab: (tab: string) => Promise<void>;
    }
}

interface Held {
    held?: Map<string, IDBDatabase>;
}

const pages: Map<string, Page> = new Map<string, Page>();

let sequence: number = 0;

/**
 * Get a tab opened earlier, failing when it was never opened or already closed.
 */
function page(tab: string): Page {
    const opened: Page | undefined = pages.get(tab);

    if (opened === undefined) {
        throw new Error(`No tab [${tab}] is open.`);
    }

    return opened;
}

/**
 * Open a second tab on the test server's origin, sharing the test's IndexedDB.
 */
async function openTab(context: BrowserCommandContext): Promise<string> {
    const url: string = `${new URL(context.page.url()).origin}/__tab__`;
    const opened: Page = await context.context.newPage();
    const tab: string = `tab-${++sequence}`;

    pages.set(tab, opened);

    // The route serves the page instead of the test server,
    // so it shares the origin but loads nothing of Vitest's.
    await opened.route(url, (route: Route): Promise<void> => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Tab</title>' }));
    await opened.goto(url);

    return tab;
}

/**
 * Open a database in another tab and hold it open, resolving with its version.
 */
function holdDatabase(_: BrowserCommandContext, tab: string, database: string, version?: number): Promise<number> {
    return page(tab).evaluate(([database, version]: [string, number | undefined]): Promise<number> => {
        return new Promise<number>((resolve: (version: number) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = version === undefined ? indexedDB.open(database) : indexedDB.open(database, version);
            const scope: Held = globalThis as Held;

            request.onsuccess = (): void => {
                (scope.held ??= new Map<string, IDBDatabase>()).set(database, request.result);

                resolve(request.result.version);
            };

            request.onerror = (): void => reject(new Error(`${request.error?.name}: ${request.error?.message}`));
        });
    }, [database, version] as [string, number | undefined]);
}

/**
 * Upgrade a database from another tab, resolving with whether it was blocked first.
 */
function upgradeDatabase(_: BrowserCommandContext, tab: string, database: string, version: number): Promise<boolean> {
    return page(tab).evaluate(([database, version]: [string, number]): Promise<boolean> => {
        return new Promise<boolean>((resolve: (blocked: boolean) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.open(database, version);
            let blocked: boolean = false;

            request.onblocked = (): void => {
                blocked = true;
            };

            request.onsuccess = (): void => {
                request.result.close();

                resolve(blocked);
            };

            request.onerror = (): void => reject(new Error(`${request.error?.name}: ${request.error?.message}`));
        });
    }, [database, version] as [string, number]);
}

/**
 * Delete a database from another tab, resolving with whether it was blocked first.
 */
function deleteDatabase(_: BrowserCommandContext, tab: string, database: string): Promise<boolean> {
    return page(tab).evaluate((database: string): Promise<boolean> => {
        return new Promise<boolean>((resolve: (blocked: boolean) => void, reject: (reason: unknown) => void): void => {
            const request: IDBOpenDBRequest = indexedDB.deleteDatabase(database);
            let blocked: boolean = false;

            request.onblocked = (): void => {
                blocked = true;
            };

            request.onsuccess = (): void => resolve(blocked);
            request.onerror = (): void => reject(new Error(`${request.error?.name}: ${request.error?.message}`));
        });
    }, database);
}

/**
 * Close a database another tab holds open.
 */
function closeDatabase(_: BrowserCommandContext, tab: string, database: string): Promise<void> {
    return page(tab).evaluate((database: string): void => {
        const scope: Held = globalThis as Held;

        scope.held?.get(database)?.close();
        scope.held?.delete(database);
    }, database);
}

/**
 * Close another tab, along with every database it holds open.
 */
async function closeTab(_: BrowserCommandContext, tab: string): Promise<void> {
    const opened: Page | undefined = pages.get(tab);

    pages.delete(tab);

    await opened?.close();
}

export const tabs: Record<string, BrowserCommand<never[]>> = {
    openTab,
    holdDatabase,
    upgradeDatabase,
    deleteDatabase,
    closeDatabase,
    closeTab,
} as Record<string, BrowserCommand<never[]>>;
