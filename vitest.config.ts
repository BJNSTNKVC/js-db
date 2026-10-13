import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { tabs } from './tests/browser/commands.ts';
import { Engine } from './tests/engines.ts';
import { ZONES } from './tests/zones.ts';

const ENGINES: Engine[] = Object.values(Engine);

const ZONED: string[] = ['tests/**/*.zoned.test.ts'];

export default defineConfig({
    test: {
        coverage: {
            provider  : 'v8',
            include   : ['src/**/*.ts'],
            thresholds: {
                lines     : 100,
                functions : 100,
                branches  : 100,
                statements: 100,
            },
        },
        projects: [
            {
                extends: true,
                test   : {
                    name      : 'node',
                    include   : ['tests/**/*.test.ts'],
                    exclude   : ['tests/browser/**'],
                    setupFiles: ['./tests/setup.ts'],
                },
            },
            {
                extends: true,
                test   : {
                    name      : 'browser',
                    include   : ['tests/**/*.test.ts'],
                    maxWorkers: 2,
                    browser   : {
                        enabled           : true,
                        provider          : playwright(),
                        headless          : true,
                        screenshotFailures: false,
                        instances         : [
                            ...ENGINES.map((browser: Engine) => ({
                                browser,
                                provider: playwright({ contextOptions: { timezoneId: 'UTC' } }),
                            })),
                            ...ENGINES.flatMap((browser: Engine) => ZONES.map((timezoneId: string) => ({
                                browser,
                                name    : `browser (${browser}, ${timezoneId})`,
                                include : ZONED,
                                provider: playwright({ contextOptions: { timezoneId } }),
                            }))),
                        ],
                        commands: tabs,
                    },
                },
            },
        ],
    },
});
