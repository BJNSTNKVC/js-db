import { SchemaException, UniqueConstraintViolationException } from '../exceptions';
import { Request } from '../database/Request';
import { Enforcer } from '../schema/Enforcer';
import { Planner } from './Planner';
import { Signature } from './Signature';
import type { IndexSchema, TableSchema } from '../schema/types';

export type Target = {
    store: IDBObjectStore;
    schema: TableSchema;
    strict: boolean;
    timezone: string;
};

export class Writer {
    /**
     * Add a record to the store, naming any unique index it violates.
     */
    static async add(target: Target, record: Record<string, unknown>): Promise<IDBValidKey> {
        const { store, schema, strict, timezone }: Target = target;
        const prepared: Record<string, unknown> = Enforcer.insertable(record, schema, strict, timezone, new Date());

        try {
            return await Request.settle(store.add(prepared), true);
        } catch (error: unknown) {
            throw await this.attributed(store, schema, prepared, null, error);
        }
    }

    /**
     * Add the records one at a time, skipping collisions when told to.
     */
    static async addEach(target: Target, records: Record<string, unknown>[], ignore: boolean): Promise<number> {
        let added: number = 0;

        for (const record of records) {
            try {
                await this.add(target, record);

                added++;
            } catch (error: unknown) {
                if (ignore && error instanceof UniqueConstraintViolationException) {
                    continue;
                }

                throw error;
            }
        }

        return added;
    }

    /**
     * Add the records together, rolling back the transaction when one fails.
     */
    static async addAll(target: Target, records: Record<string, unknown>[], ignore: boolean): Promise<number> {
        const { store, schema, strict, timezone }: Target = target;
        const prepared: Record<string, unknown>[] = records.map((record: Record<string, unknown>): Record<string, unknown> => Enforcer.insertable(record, schema, strict, timezone, new Date()));
        const requests: Promise<IDBValidKey>[] = [];

        let failure: { error: unknown } | null = null;

        for (const record of prepared) {
            try {
                requests.push(Request.settle(store.add(record), true));
            } catch (error: unknown) {
                failure = { error };

                break;
            }
        }

        const outcomes: PromiseSettledResult<IDBValidKey>[] = await Promise.allSettled(requests);

        let written: Map<string, number> | null = null;
        let added: number = 0;

        for (const [position, outcome] of outcomes.entries()) {
            if (outcome.status === 'fulfilled') {
                added++;

                continue;
            }

            // The rows sent after a failed one have landed by the time it is traced,
            // so a key one of them holds is not the one it collided with.
            const positions: Map<string, number> = written ??= this.#written(outcomes);
            const later: (key: IDBValidKey) => boolean = (key: IDBValidKey): boolean => (positions.get(Signature.value(key)) ?? -1) > position;
            const error: unknown = await this.attributed(store, schema, prepared[position] as Record<string, unknown>, null, outcome.reason, later);

            if (ignore && error instanceof UniqueConstraintViolationException) {
                continue;
            }

            failure = { error };

            break;
        }

        if (failure !== null) {
            this.rollback(store);

            throw failure.error;
        }

        return added;
    }

    /**
     * Roll back the store's transaction, unless it has already finished.
     */
    static rollback(store: IDBObjectStore): void {
        try {
            store.transaction.abort();
        } catch {
            // A transaction that has already finished throws on abort,
            // which would take the place of the failure being reported.
        }
    }

    /**
     * Get the error a failed write reports, naming the violated unique index.
     */
    static async attributed(store: IDBObjectStore, schema: TableSchema, record: Record<string, unknown>, previous: Record<string, unknown> | null, error: unknown, later: (key: IDBValidKey) => boolean = (): boolean => false, replaced: Record<string, unknown>[] = []): Promise<unknown> {
        if (error instanceof DOMException && error.name === 'ConstraintError') {
            const index: string | null = await this.#violated(store, schema, record, previous, later, replaced);

            if (index !== null) {
                return new UniqueConstraintViolationException(schema.table, index);
            }
        }

        return error;
    }

    /**
     * Get the error a failed write reports, rolling back when told to.
     */
    static async failed(store: IDBObjectStore, schema: TableSchema, record: Record<string, unknown>, previous: Record<string, unknown> | null, error: unknown, rollback: boolean, overwritten: { key: IDBValidKey; previous: Record<string, unknown> }[]): Promise<unknown> {
        const keys: Set<string> = new Set<string>(overwritten.map((write: { key: IDBValidKey }): string => Signature.value(write.key)));
        const later: (key: IDBValidKey) => boolean = (key: IDBValidKey): boolean => keys.has(Signature.value(key));

        try {
            return await this.attributed(store, schema, record, previous, error, later, overwritten.map((write: { previous: Record<string, unknown> }): Record<string, unknown> => write.previous));
        } finally {
            if (rollback) {
                store.transaction.abort();
            }
        }
    }

    /**
     * Prepare the changes an update writes, refusing any to the key path.
     */
    static changes(values: Record<string, unknown>, schema: TableSchema, strict: boolean, timezone: string): Record<string, unknown> {
        const prepared: Record<string, unknown> = Enforcer.updatable(values, schema, strict, timezone, new Date());

        if (schema.key !== null && Object.hasOwn(prepared, schema.key)) {
            throw new SchemaException(`Column [${schema.key}] is the key path of table [${schema.table}] and may not be updated.`);
        }

        return prepared;
    }

    /**
     * Resolve the conflict target of an upsert, or fail.
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
     * Insert a record, or merge it into the one it conflicts with.
     */
    static async merge(target: Target, columns: string[], index: IndexSchema | null, value: Record<string, unknown>, update: string[] | undefined): Promise<void> {
        const { store, schema, strict, timezone }: Target = target;

        const existing: Record<string, unknown> | undefined = index === null
            ? await this.#stored(target, value)
            : await this.#conflicting(target, columns, index, value);

        if (existing === undefined) {
            await this.add(target, value);

            return;
        }

        const changes: Record<string, unknown> = update === undefined
            ? { ...value }
            : Object.fromEntries(update.map((column: string): [string, unknown] => [column, value[column]]));

        if (index === null) {
            delete changes[schema.key as string];
        }

        const record: Record<string, unknown> = { ...existing, ...this.changes(changes, schema, strict, timezone) };

        try {
            await Request.settle(store.put(record), true);
        } catch (error: unknown) {
            throw await this.attributed(store, schema, record, existing, error);
        }
    }

    /**
     * Get the record stored under the key the row gives, if any.
     */
    static async #stored(target: Target, value: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        const { store, schema, strict, timezone }: Target = target;
        const column: string = schema.key as string;

        // A row leaving out a key the database generates has none to coerce,
        // where a strict connection would refuse the absence as null.
        const key: unknown = Object.hasOwn(value, column) ? Enforcer.field(value[column], column, schema, strict, timezone) : undefined;

        return Planner.keyable(key) ? Request.settle(store.get(key as IDBValidKey) as IDBRequest<Record<string, unknown> | undefined>) : undefined;
    }

    /**
     * Get the one record holding the row's values in the unique index, if any.
     */
    static async #conflicting(target: Target, columns: string[], index: IndexSchema, value: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        const { store, schema, strict, timezone }: Target = target;
        const prepared: Record<string, unknown> = Enforcer.updatable(
            Object.fromEntries(columns.map((column: string): [string, unknown] => [column, value[column]])),
            schema,
            strict,
            timezone,
            new Date(),
        );

        const entries: IDBValidKey[] = index.multiEntry
            ? this.#entries(prepared[columns[0] as string])
            : [this.#keyOf(columns, prepared)].filter((key: IDBValidKey): boolean => Planner.keyable(key));

        if (entries.length === 0) {
            return undefined;
        }

        return index.multiEntry
            ? this.#holder(store, schema, index, entries)
            : Request.settle(store.index(index.name).get(IDBKeyRange.only(entries[0] as IDBValidKey)) as IDBRequest<Record<string, unknown> | undefined>);
    }

    /**
     * Get the one record holding any of the multi-entry index entries.
     */
    static async #holder(store: IDBObjectStore, schema: TableSchema, index: IndexSchema, entries: IDBValidKey[]): Promise<Record<string, unknown> | undefined> {
        const keys: IDBValidKey[] = [];

        for (const entry of entries) {
            const key: IDBValidKey | undefined = await Request.settle(store.index(index.name).getKey(IDBKeyRange.only(entry)));

            if (key !== undefined && !keys.some((held: IDBValidKey): boolean => indexedDB.cmp(held, key) === 0)) {
                keys.push(key);
            }
        }

        if (keys.length > 1) {
            throw new UniqueConstraintViolationException(schema.table, index.name);
        }

        return keys.length === 0 ? undefined : Request.settle(store.get(keys[0] as IDBValidKey) as IDBRequest<Record<string, unknown> | undefined>);
    }

    /**
     * Find the unique index the record collides with, if any.
     */
    static async #violated(store: IDBObjectStore, schema: TableSchema, record: Record<string, unknown>, previous: Record<string, unknown> | null, later: (key: IDBValidKey) => boolean, replaced: Record<string, unknown>[]): Promise<string | null> {
        // A generated key is absent from the record,
        // and an absent value is not a valid range.
        if (previous === null && schema.key !== null && Planner.keyable(record[schema.key])) {
            const key: IDBValidKey = record[schema.key] as IDBValidKey;

            if (!later(key) && await Request.settle(store.count(IDBKeyRange.only(key))) > 0) {
                return schema.key;
            }
        }

        for (const index of schema.indexes.filter((candidate: IndexSchema): boolean => candidate.unique)) {
            if (index.multiEntry) {
                if (await this.#collides(store, index, record, previous, later, replaced)) {
                    return index.name;
                }

                continue;
            }

            if (!index.columns.every((column: string): boolean => Planner.keyable(record[column]))) {
                continue;
            }

            // The record a failed write would have replaced
            // still holds its own entry in the index.
            if (previous !== null && this.#unchanged(index.columns, record, previous)) {
                continue;
            }

            if (await this.#held(store, index, this.#keyOf(index.columns, record), later, replaced)) {
                return index.name;
            }
        }

        return null;
    }

    /**
     * Determine whether another record holds an entry this record adds.
     */
    static async #collides(store: IDBObjectStore, index: IndexSchema, record: Record<string, unknown>, previous: Record<string, unknown> | null, later: (key: IDBValidKey) => boolean, replaced: Record<string, unknown>[]): Promise<boolean> {
        const column: string = index.columns[0] as string;
        const held: IDBValidKey[] = previous === null ? [] : this.#entries(previous[column]);

        for (const entry of this.#entries(record[column])) {
            if (held.some((own: IDBValidKey): boolean => indexedDB.cmp(own, entry) === 0)) {
                continue;
            }

            if (await this.#held(store, index, entry, later, replaced)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Determine whether a record held the index key when the failed write ran.
     */
    static async #held(store: IDBObjectStore, index: IndexSchema, key: IDBValidKey, later: (key: IDBValidKey) => boolean, replaced: Record<string, unknown>[]): Promise<boolean> {
        const holder: IDBValidKey | undefined = await Request.settle(store.index(index.name).getKey(IDBKeyRange.only(key)));

        if (holder !== undefined && !later(holder)) {
            return true;
        }

        // A record rewritten after the failed write still held,
        // when that write ran, what it held before its own.
        return replaced.some((record: Record<string, unknown>): boolean => this.#holds(index, record, key));
    }

    /**
     * Determine whether a record adds the key to the index.
     */
    static #holds(index: IndexSchema, record: Record<string, unknown>, key: IDBValidKey): boolean {
        const entries: IDBValidKey[] = index.multiEntry
            ? this.#entries(record[index.columns[0] as string])
            : [this.#keyOf(index.columns, record)].filter((entry: IDBValidKey): boolean => Planner.keyable(entry));

        return entries.some((entry: IDBValidKey): boolean => indexedDB.cmp(entry, key) === 0);
    }

    /**
     * Map each key the writes stored to the position of the record holding it.
     */
    static #written(outcomes: PromiseSettledResult<IDBValidKey>[]): Map<string, number> {
        return new Map<string, number>(outcomes.flatMap(
            (outcome: PromiseSettledResult<IDBValidKey>, position: number): [string, number][] => outcome.status === 'fulfilled' ? [[Signature.value(outcome.value), position]] : [],
        ));
    }

    /**
     * Get the distinct entries a value adds to a multi-entry index.
     */
    static #entries(value: unknown): IDBValidKey[] {
        const entries: IDBValidKey[] = [];

        for (const candidate of Array.isArray(value) ? value : [value]) {
            if (Planner.keyable(candidate) && !entries.some((entry: IDBValidKey): boolean => indexedDB.cmp(entry, candidate) === 0)) {
                entries.push(candidate as IDBValidKey);
            }
        }

        return entries;
    }

    /**
     * Determine whether the record keeps the previous values in the columns.
     */
    static #unchanged(columns: string[], record: Record<string, unknown>, previous: Record<string, unknown>): boolean {
        return Signature.ofValues(columns.map((column: string): unknown => record[column]))
            === Signature.ofValues(columns.map((column: string): unknown => previous[column]));
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
