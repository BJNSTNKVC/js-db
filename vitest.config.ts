import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { tabs } from './tests/browser/commands';
import { Engine } from './tests/engines';
import { ZONES } from './tests/zones';

const ENGINES: Engine[] = Object.values(Engine);

const ZONED: string[] = [
    'tests/database/Connection.test.ts',
    'tests/query/Builder.extras.test.ts',
    'tests/query/Builder.writes.test.ts',
    'tests/query/Predicate.test.ts',
    'tests/schema/Calendar.test.ts',
    'tests/schema/Enforcer.test.ts',
];

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
                            ...ENGINES.map((browser: Engine) => ({ browser })),
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
