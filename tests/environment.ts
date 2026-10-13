import { TestRunner, vi } from 'vitest';
import { Engine } from './engines';

export class Env {
    /**
     * Determine whether the suite runs in a browser rather than in Node.
     */
    static isInBrowser(): boolean {
        return typeof document !== 'undefined';
    }

    /**
     * Determine whether the suite runs in Node.
     */
    static isInNode(): boolean {
        return !this.isInBrowser();
    }

    /**
     * Get the browser engine the suite runs in, or null under Node.
     */
    static engine(): Engine | null {
        if (this.isInNode()) {
            return null;
        }

        const agent: string = navigator.userAgent;

        if (agent.includes('Firefox/')) {
            return Engine.Firefox;
        }

        return agent.includes('Chrome/') ? Engine.Chromium : Engine.WebKit;
    }

    /**
     * Determine whether the suite runs in one of the given browser engines.
     */
    static isEngine(...engines: Engine[]): boolean {
        const engine: Engine | null = this.engine();

        return engine !== null && engines.includes(engine);
    }

    /**
     * Get the timezone the device running the suite is in.
     */
    static zone(): string {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    /**
     * Put the device in a timezone, skipping the test where a browser cannot follow.
     */
    static moveTo(zone: string): void {
        if (this.isInNode()) {
            vi.stubEnv('TZ', zone);

            return;
        }

        // Intl may report a zone by an older name, such as Asia/Calcutta for Asia/Kolkata,
        // so the zone asked for is compared as Intl resolves it.
        const wanted: string = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;

        // A browser stays in the timezone its instance was started in,
        // so a test needing another is skipped there.
        TestRunner.getCurrentTest()?.context.skip(this.zone() !== wanted, `The browser is in ${this.zone()}.`);
    }
}
