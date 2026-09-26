import { SchemaException, UniqueConstraintViolationException } from '../exceptions';
import { Request } from '../database/Request';
import { Enforcer } from '../schema/Enforcer';
import type { IndexSchema, TableSchema } from '../schema/types';

export class Writer {
    /**
     * Add a record to the store, reporting a violated constraint by its index.
     */
    static async add(store: IDBObjectStore, schema: TableSchema, strict: boolean, record: Record<string, unknown>): Promise<IDBValidKey> {
        const prepared: Record<string, unknown> = Enforcer.insertable(record, schema, strict, new Date());

        try {
            return await Request.settle(store.add(prepared), true);
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'ConstraintError') {
                const index: string | null = await this.#violated(store, schema, prepared);

                if (index !== null) {
                    throw new UniqueConstraintViolationException(schema.table, index);
                }
            }

            throw error;
        }
    }

    /**
     * Prepare the changes an update writes, refusing any that touch the key path.
     */
    static changes(values: Record<string, unknown>, schema: TableSchema, strict: boolean): Record<string, unknown> {
        const prepared: Record<string, unknown> = Enforcer.updatable(values, schema, strict, new Date());

        if (schema.key !== null && Object.hasOwn(prepared, schema.key)) {
            throw new SchemaException(`Column [${schema.key}] is the key path of table [${schema.table}] and may not be updated.`);
        }

        return prepared;
    }

    /**
     * Resolve the conflict target of an upsert, or fail when it cannot be enforced.
     */
    static conflict(schema: TableSchema, columns: string[]): IndexSchema | null {
        if (columns.length === 1 && columns[0] === schema.key) {
            return null;
        }

        const index: IndexSchema | undefined = schema.indexes.find((candidate: IndexSchema): boolean => candidate.unique
            && candidate.columns.length === columns.length
            && candidate.columns.every((column: string, position: number): boolean => column === columns[position]));

        if (index === undefined) {
            throw new SchemaException(`Upsert on table [${schema.table}] requires [${columns.join(', ')}] to be the key path or a unique index.`);
        }

        return index;
    }

    /**
     * Insert a record, or merge it into the one already holding its conflict key.
     */
    static async merge(store: IDBObjectStore, schema: TableSchema, strict: boolean, columns: string[], target: IndexSchema | null, value: Record<string, unknown>, update?: string[]): Promise<void> {
        if (target === null) {
            await Request.settle(store.put(Enforcer.insertable(value, schema, strict, new Date())));

            return;
        }

        const key: IDBValidKey = this.#keyOf(columns, value);
        const existing: Record<string, unknown> | undefined = await Request.settle(store.index(target.name).get(IDBKeyRange.only(key)) as IDBRequest<Record<string, unknown> | undefined>);

        if (existing === undefined) {
            await this.add(store, schema, strict, value);

            return;
        }

        const changes: Record<string, unknown> = update === undefined
            ? value
            : Object.fromEntries(update.map((column: string): [string, unknown] => [column, value[column]]));

        await Request.settle(store.put({ ...existing, ...this.changes(changes, schema, strict) }));
    }

    /**
     * Find the unique index the record collides with, or null when it cannot be attributed.
     */
    static async #violated(store: IDBObjectStore, schema: TableSchema, record: Record<string, unknown>): Promise<string | null> {
        // A generated key is absent from the record, and an absent value is not a valid range.
        if (schema.key !== null && this.#keyable(record[schema.key])) {
            if (await Request.settle(store.count(IDBKeyRange.only(record[schema.key] as IDBValidKey))) > 0) {
                return schema.key;
            }
        }

        for (const index of schema.indexes.filter((candidate: IndexSchema): boolean => candidate.unique)) {
            if (!index.columns.every((column: string): boolean => this.#keyable(record[column]))) {
                continue;
            }

            const key: IDBValidKey = this.#keyOf(index.columns, record);

            if (await Request.settle(store.index(index.name).count(IDBKeyRange.only(key))) > 0) {
                return index.name;
            }
        }

        return null;
    }

    /**
     * Determine whether the value may be used as an IndexedDB key.
     */
    static #keyable(value: unknown): boolean {
        return value !== null && value !== undefined;
    }

    /**
     * Build the index key the given columns of a record form.
     */
    static #keyOf(columns: string[], record: Record<string, unknown>): IDBValidKey {
        if (columns.length === 1) {
            return record[columns[0] as string] as IDBValidKey;
        }

        return columns.map((column: string): unknown => record[column]) as IDBValidKey;
    }
}
