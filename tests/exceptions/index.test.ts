import { describe, expect, test } from 'vitest';
import {
    ConnectionNotConfiguredException,
    DatabaseBlockedException,
    MigrationMismatchException,
    MigrationTransactionClosedException,
    NotNullConstraintViolationException,
    RecordsNotFoundException,
    ReservedTableException,
    SchemaException,
    TableNotFoundException,
    UniqueConstraintViolationException,
} from '../../src/exceptions';

describe('Exceptions with a default message', (): void => {
    test.each([
        [SchemaException, 'SchemaException', 'Schema operation failed.'],
        [RecordsNotFoundException, 'RecordsNotFoundException', 'No records found.'],
    ] as const)('%o carries a default message and its own name', (Exception: typeof SchemaException | typeof RecordsNotFoundException, name: string, message: string): void => {
        const exception: Error = new Exception();

        expect(exception).toBeInstanceOf(Error);
        expect(exception.name).toEqual(name);
        expect(exception.message).toEqual(message);
    });

    test.each([
        [SchemaException, 'SchemaException'],
        [RecordsNotFoundException, 'RecordsNotFoundException'],
    ] as const)('%o accepts an overridden message', (Exception: typeof SchemaException | typeof RecordsNotFoundException, name: string): void => {
        const exception: Error = new Exception('Custom.');

        expect(exception.message).toEqual('Custom.');
        expect(exception.name).toEqual(name);
    });
});

describe('ConnectionNotConfiguredException', (): void => {
    test('names the connection', (): void => {
        const exception: ConnectionNotConfiguredException = new ConnectionNotConfiguredException('reporting');

        expect(exception).toBeInstanceOf(Error);
        expect(exception.name).toEqual('ConnectionNotConfiguredException');
        expect(exception.message).toEqual('Database connection [reporting] is not configured.');
    });
});

describe('DatabaseBlockedException', (): void => {
    test('names the database and explains the cause', (): void => {
        const exception: DatabaseBlockedException = new DatabaseBlockedException('app');

        expect(exception.name).toEqual('DatabaseBlockedException');
        expect(exception.message).toEqual('Database [app] is blocked by a connection in another tab holding an older version. Close the other tabs and try again.');
    });
});

describe('TableNotFoundException', (): void => {
    test('names the table', (): void => {
        const exception: TableNotFoundException = new TableNotFoundException('users');

        expect(exception.name).toEqual('TableNotFoundException');
        expect(exception.message).toEqual('Table [users] does not exist.');
    });
});

describe('UniqueConstraintViolationException', (): void => {
    test('names the table and the index', (): void => {
        const exception: UniqueConstraintViolationException = new UniqueConstraintViolationException('users', 'users_email_unique');

        expect(exception.name).toEqual('UniqueConstraintViolationException');
        expect(exception.message).toEqual('Unique constraint violated on index [users_email_unique] of table [users].');
    });
});

describe('NotNullConstraintViolationException', (): void => {
    test('names the table and the column', (): void => {
        const exception: NotNullConstraintViolationException = new NotNullConstraintViolationException('users', 'email');

        expect(exception.name).toEqual('NotNullConstraintViolationException');
        expect(exception.message).toEqual('Column [email] of table [users] may not be null.');
    });
});

describe('ReservedTableException', (): void => {
    test('names the reserved table', (): void => {
        const exception: ReservedTableException = new ReservedTableException('migrations');

        expect(exception.name).toEqual('ReservedTableException');
        expect(exception.message).toEqual('Table name [migrations] is reserved by the database layer.');
    });
});

describe('MigrationMismatchException', (): void => {
    test('reports the recorded and registered migrations', (): void => {
        const exception: MigrationMismatchException = new MigrationMismatchException(['a', 'b'], ['a', 'x']);

        expect(exception.name).toEqual('MigrationMismatchException');
        expect(exception.message).toEqual('Registered migrations [a, x] do not match the migrations already run [a, b]. Migrations are forward-only, so they may only be appended, never reordered or removed. If your bundler mangles class names, override name() on each migration.');
    });
});

describe('MigrationTransactionClosedException', (): void => {
    test('names the migration and states the rule', (): void => {
        const exception: MigrationTransactionClosedException = new MigrationTransactionClosedException('CreateUsersTable');

        expect(exception.name).toEqual('MigrationTransactionClosedException');
        expect(exception.message).toEqual('Migration [CreateUsersTable] continued after its transaction closed. A migration may only await database operations from this package - awaiting a fetch, a timer or any other promise ends the transaction.');
    });
});
