import { describe, expect, test } from 'vitest';
import { Seeder } from '../../src/seeders/Seeder';

class UserSeeder extends Seeder {
    /**
     * Seed the database.
     */
    override run(): void {
    }
}

class Renamed extends Seeder {
    /**
     * Get the name of the seeder.
     */
    override name(): string {
        return 'user_seeder';
    }

    /**
     * Seed the database.
     */
    override run(): void {
    }
}

class Asynchronous extends Seeder {
    /**
     * Seed the database.
     */
    override async run(): Promise<void> {
        // A seeder runs outside the version change transaction, so it may await anything.
        await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, 0);
        });
    }
}

describe('Seeder', (): void => {
    test('names itself after its class', (): void => {
        expect(new UserSeeder().name()).toEqual('UserSeeder');
    });

    test('honours an overridden name', (): void => {
        expect(new Renamed().name()).toEqual('user_seeder');
    });

    test('accepts a synchronous run', (): void => {
        expect(new UserSeeder().run()).toBeUndefined();
    });

    test('accepts an asynchronous run', async (): Promise<void> => {
        await expect(new Asynchronous().run()).resolves.toBeUndefined();
    });
});
