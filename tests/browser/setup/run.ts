import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { createVitest } from 'vitest/node';
import type { TestProject, Vitest } from 'vitest/node';

const vitest: Vitest = await createVitest('test', { watch: false, project: ['browser'] });

const instances: string[] = vitest.projects.map((project: TestProject) => project.name);

await vitest.close();

const failed: string[] = instances.filter((instance: string) => {
    const run: SpawnSyncReturns<Buffer> = spawnSync('npx', ['vitest', 'run', '--project', instance, '--passWithNoTests', ...process.argv.slice(2)], { stdio: 'inherit' });

    return run.status !== 0;
});

if (failed.length) {
    console.error(`\nFailed in ${failed.join(', ')}`);

    process.exit(1);
}
