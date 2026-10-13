import { TestRunner, vi } from 'vitest';
import { Engine } from './engines';
import { ZONES } from './zones';

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
     * Determine whether the device can be put in the given timezone.
     */
    static reaches(zone: string): boolean {
        if (this.isInNode()) {
            return true;
        }

        // Intl may report a zone by an older name, such as Asia/Calcutta for Asia/Kolkata,
        // so the zone asked for is compared as Intl resolves it.
        return this.zone() === new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    }

    /**
     * Get the given timezones the device can be put in, every one under Node.
     */
    static zones(zones: string[] = ZONES): string[] {
        return zones.filter((zone: string): boolean => this.reaches(zone));
    }

    /**
     * Keep the rows whose timezone at the given position the device can be put in.
     */
    static reachable<T extends unknown[]>(rows: T[], at: number = 0): T[] {
        return rows.filter((row: T): boolean => this.reaches(row[at] as string));
    }

    /**
     * Put the device in a timezone, skipping the test where a browser cannot follow.
     */
    static moveTo(zone: string): void {
        if (this.isInNode()) {
            vi.stubEnv('TZ', zone);

            return;
        }

        // A browser stays in the timezone its instance was started in,
        // so a test needing another is skipped there.
        TestRunner.getCurrentTest()?.context.skip(!this.reaches(zone), `The browser is in ${this.zone()}.`);
    }
}
