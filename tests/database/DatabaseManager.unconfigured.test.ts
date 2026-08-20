import { describe, expect, test } from 'vitest';
import { DB } from '../../src/main';
import { ConnectionNotConfiguredException } from '../../src/exceptions';
import type { Connection } from '../../src/database/Connection';

// This file deliberately never calls DB.configure, so it covers the state the manager starts in.
describe('DatabaseManager before it is configured', (): void => {
    test('fails to resolve the default connection', (): void => {
        expect((): Connection => DB.connection()).toThrow(new ConnectionNotConfiguredException('default'));
    });

    test('fails to resolve a named connection', (): void => {
        expect((): Connection => DB.connection('reporting')).toThrow(new ConnectionNotConfiguredException('reporting'));
    });

    test('fails to begin a query', (): void => {
        expect((): unknown => DB.table('users')).toThrow(ConnectionNotConfiguredException);
    });

    test('reports that it is not logging', (): void => {
        expect(DB.logging()).toEqual(false);
        expect(DB.getQueryLog()).toEqual([]);
    });
});
