import { SchemaException } from '../exceptions';
import { ColumnDefinition } from './ColumnDefinition';
import type { BlueprintOperations, ChangedColumn, ColumnSchema, ColumnType, Enumerable, IndexSchema, RenamedColumn, RequestedIndex, TableSchema } from './types';

type IndexChanges = { indexes: IndexSchema[]; created: IndexSchema[]; removed: string[] };

export class Blueprint {
    /**
     * The name of the table.
     */
    readonly #table: string;

    /**
     * The schema of the table as it already exists, when altering.
     */
    readonly #existing: TableSchema | null;

    /**
     * The columns declared on the blueprint.
     */
    readonly #columns: ColumnDefinition[] = [];

    /**
     * The indexes declared at table level on the blueprint.
     */
    readonly #indexes: IndexSchema[] = [];

    /**
     * The names of the columns to drop.
     */
    readonly #dropped: string[] = [];

    /**
     * The columns to rename.
     */
    readonly #renamed: RenamedColumn[] = [];

    /**
     * The names of the indexes to drop.
     */
    readonly #unindexed: string[] = [];

    /**
     * Whether the table manages timestamps.
     */
    #timestamps: boolean;

    /**
     * Create a new blueprint for a table.
     */
    constructor(table: string, existing: TableSchema | null = null) {
        this.#table = table;
        this.#existing = existing;
        this.#timestamps = existing !== null && existing.timestamps;
    }

    /**
     * Get the name of the table.
     */
    get table(): string {
        return this.#table;
    }

    /**
     * Add an auto incrementing primary key column.
     */
    id(column: string = 'id'): ColumnDefinition {
        return this.integer(column).primary().increments();
    }

    /**
     * Add a string column holding a universally unique identifier.
     */
    uuid(column: string): ColumnDefinition {
        return this.string(column);
    }

    /**
     * Add a string column.
     */
    string(column: string): ColumnDefinition {
        return this.#add(column, 'string');
    }

    /**
     * Add an integer column.
     */
    integer(column: string): ColumnDefinition {
        return this.#add(column, 'integer');
    }

    /**
     * Add a floating point column.
     */
    float(column: string): ColumnDefinition {
        return this.#add(column, 'float');
    }

    /**
     * Add a boolean column.
     */
    boolean(column: string): ColumnDefinition {
        return this.#add(column, 'boolean');
    }

    /**
     * Add a date column.
     */
    date(column: string): ColumnDefinition {
        return this.#add(column, 'date');
    }

    /**
     * Add a date and time column.
     */
    datetime(column: string): ColumnDefinition {
        return this.#add(column, 'datetime');
    }

    /**
     * Add a column holding an arbitrary structure.
     */
    json(column: string): ColumnDefinition {
        return this.#add(column, 'json');
    }

    /**
     * Add a fixed point column, stored as an integer number of its smallest unit.
     */
    decimal(column: string, places: number = 2): ColumnDefinition {
        return this.#add(column, 'decimal').scaled(places);
    }

    /**
     * Add a column accepting only one of the given values.
     */
    enum(column: string, values: Enumerable): ColumnDefinition {
        const accepted: string[] = this.#enumerated(column, values);

        if (accepted.length === 0) {
            throw new SchemaException(`Column [${column}] of table [${this.#table}] is enumerated over no values, so nothing could ever be written to it.`);
        }

        return this.#add(column, 'enum').accepts(accepted);
    }

    /**
     * Add nullable creation and update timestamp columns.
     */
    timestamps(): void {
        this.#timestamps = true;

        this.datetime('created_at').nullable();
        this.datetime('updated_at').nullable();
    }

    /**
     * Add an index over the given columns.
     */
    index(columns: string | string[], name: string | null = null): IndexSchema {
        return this.#indexed(columns, name, false);
    }

    /**
     * Add a unique index over the given columns.
     */
    unique(columns: string | string[], name: string | null = null): IndexSchema {
        return this.#indexed(columns, name, true);
    }

    /**
     * Drop the given columns from the table.
     */
    dropColumn(...columns: string[]): void {
        for (const column of columns) {
            if (!this.#has(column)) {
                throw new SchemaException(`Column [${column}] does not exist on table [${this.#table}].`);
            }

            this.#dropped.push(column);
        }
    }

    /**
     * Rename a column of the table.
     */
    renameColumn(from: string, to: string): void {
        if (!this.#has(from)) {
            throw new SchemaException(`Column [${from}] does not exist on table [${this.#table}].`);
        }

        this.#renamed.push({ from, to });
    }

    /**
     * Drop an index from the table.
     */
    dropIndex(name: string): void {
        const exists: boolean = this.#indexesOf().some((index: IndexSchema): boolean => index.name === name);

        if (!exists) {
            throw new SchemaException(`Index [${name}] does not exist on table [${this.#table}].`);
        }

        this.#unindexed.push(name);
    }

    /**
     * Get the schema describing the table once the blueprint is applied.
     */
    toSchema(): TableSchema {
        const columns: ColumnSchema[] = this.#resolved();
        const indexes: IndexSchema[] = this.#resolvedIndexes();
        const primary: ColumnSchema[] = columns.filter((column: ColumnSchema): boolean => column.primary);

        if (primary.length > 1) {
            throw new SchemaException(`Table [${this.#table}] declares more than one primary column [${primary.map((column: ColumnSchema): string => column.name).join(', ')}].`);
        }

        const key: ColumnSchema | undefined = primary[0];

        return {
            table     : this.#table,
            key       : key === undefined ? null : key.name,
            increments: key === undefined ? true : key.increments,
            timestamps: this.#timestamps,
            columns,
            indexes,
        };
    }

    /**
     * Get the operations the blueprint performs against the existing table.
     */
    operations(): BlueprintOperations {
        const indexes: IndexChanges = this.#indexChanges();

        return {
            added    : this.#added().map((column: ColumnDefinition): ColumnSchema => column.toSchema()),
            dropped  : this.#dropped,
            renamed  : this.#renamed,
            changed  : this.#changes(),
            indexed  : indexes.created,
            unindexed: indexes.removed,
        };
    }

    /**
     * Add a column of the given type to the blueprint.
     */
    #add(column: string, type: ColumnType): ColumnDefinition {
        const definition: ColumnDefinition = new ColumnDefinition(column, type);

        this.#columns.push(definition);

        return definition;
    }

    /**
     * Reduce a list, an enum or a constant object to the values a column accepts.
     */
    #enumerated(column: string, values: Enumerable): string[] {
        // A TypeScript string enum and an `as const` object are both plain objects at runtime, so
        // their values are what the column stores and their keys are only source-level names.
        const listed: (string | number)[] = Array.isArray(values) ? [...values] : Object.values(values);

        // A numeric enum also carries a reverse mapping, so its values hold both the names and the
        // numbers. There is no string form of it worth storing, and picking one would be a guess.
        if (listed.some((value: string | number): boolean => typeof value !== 'string')) {
            throw new SchemaException(`Column [${column}] of table [${this.#table}] is enumerated over a numeric enum, which has no string form to store. Give the enum string values, or use integer() instead.`);
        }

        return [...new Set(listed as string[])];
    }

    /**
     * Record an index over the given columns.
     */
    #indexed(columns: string | string[], name: string | null, unique: boolean): IndexSchema {
        const over: string[] = Array.isArray(columns) ? columns : [columns];

        const index: IndexSchema = {
            name      : name ?? this.#generated(over, unique),
            columns   : over,
            unique    : unique,
            multiEntry: false,
        };

        this.#indexes.push(index);

        return index;
    }

    /**
     * Get the name generated for an index over the given columns.
     */
    #generated(columns: string[], unique: boolean): string {
        return `${this.#table}_${columns.join('_')}_${unique ? 'unique' : 'index'}`;
    }

    /**
     * Get the columns the table already has.
     */
    #columnsOf(): ColumnSchema[] {
        return this.#existing === null ? [] : this.#existing.columns;
    }

    /**
     * Get the indexes the table already has.
     */
    #indexesOf(): IndexSchema[] {
        return this.#existing === null ? [] : this.#existing.indexes;
    }

    /**
     * Determine whether the column exists on the table, declared or already present.
     */
    #has(column: string): boolean {
        return this.#columnsOf().some((existing: ColumnSchema): boolean => existing.name === column)
            || this.#columns.some((declared: ColumnDefinition): boolean => declared.name === column);
    }

    /**
     * Get the columns of the table once the blueprint is applied.
     */
    #resolved(): ColumnSchema[] {
        const changed: Map<string, ColumnSchema> = new Map(this.#changes().map((change: ChangedColumn): [string, ColumnSchema] => [change.to.name, change.to]));

        const kept: ColumnSchema[] = this.#kept().map((column: ColumnSchema): ColumnSchema => changed.get(column.name) ?? column);
        const added: ColumnSchema[] = this.#added().map((column: ColumnDefinition): ColumnSchema => column.toSchema());
        const columns: ColumnSchema[] = [...kept, ...added];
        const seen: Set<string> = new Set<string>();

        for (const column of columns) {
            if (seen.has(column.name)) {
                throw new SchemaException(`Column [${column.name}] is declared more than once on table [${this.#table}].`);
            }

            seen.add(column.name);
        }

        return columns;
    }

    /**
     * Get the existing columns the blueprint keeps, under the names it gives them.
     */
    #kept(): ColumnSchema[] {
        const renamed: Map<string, string> = new Map(this.#renamed.map((rename: RenamedColumn): [string, string] => [rename.from, rename.to]));

        return this.#columnsOf()
            .filter((column: ColumnSchema): boolean => !this.#dropped.includes(column.name))
            .map((column: ColumnSchema): ColumnSchema => {
                const to: string | undefined = renamed.get(column.name);

                return to === undefined ? column : { ...column, name: to };
            });
    }

    /**
     * Get the columns the blueprint adds.
     */
    #added(): ColumnDefinition[] {
        return this.#columns.filter((column: ColumnDefinition): boolean => !column.changed);
    }

    /**
     * Get each column the blueprint changes, before and after, refusing a change it cannot apply.
     */
    #changes(): ChangedColumn[] {
        const kept: ColumnSchema[] = this.#kept();
        const changes: ChangedColumn[] = [];

        for (const definition of this.#columns.filter((column: ColumnDefinition): boolean => column.changed)) {
            const from: ColumnSchema | undefined = kept.find((column: ColumnSchema): boolean => column.name === definition.name);
            const to: ColumnSchema = definition.toSchema();

            if (from === undefined) {
                throw new SchemaException(`Column [${to.name}] does not exist on table [${this.#table}].`);
            }

            if (changes.some((change: ChangedColumn): boolean => change.to.name === to.name)) {
                throw new SchemaException(`Column [${to.name}] is declared more than once on table [${this.#table}].`);
            }

            this.#changeable(from, to);

            changes.push({ from, to });
        }

        return changes;
    }

    /**
     * Assert a column can be changed from one declaration to the other.
     */
    #changeable(from: ColumnSchema, to: ColumnSchema): void {
        const column: string = `Column [${to.name}] of table [${this.#table}]`;

        // Every pair of types would need its own conversion rules. Until they exist, a new column
        // with the values copied across does the same job without guessing.
        if (from.type !== to.type) {
            throw new SchemaException(`${column} may not change type from [${from.type}] to [${to.type}]. Add a new column, copy the values across and drop the old one.`);
        }

        // A decimal holds a whole number of its smallest unit, so 1999 at two places would read
        // as 1.999 at three. Nothing would fail, and every stored value would be wrong.
        if (from.places !== to.places) {
            throw new SchemaException(`${column} may not change scale from [${from.places}] to [${to.places}], because every stored value would be read at the wrong scale.`);
        }

        if (to.primary && !from.primary) {
            throw new SchemaException(`${column} may not become the key path, because IndexedDB fixes it when the store is created.`);
        }
    }

    /**
     * Get the indexes declared by this blueprint, at table level and on columns.
     */
    #declaredIndexes(): IndexSchema[] {
        const indexes: IndexSchema[] = [...this.#indexes];

        for (const column of this.#columns) {
            for (const requested of column.requested()) {
                indexes.push(this.#requested(column.name, requested));
            }
        }

        return indexes;
    }

    /**
     * Build the index schema for a column level request.
     */
    #requested(column: string, requested: RequestedIndex): IndexSchema {
        return {
            name      : requested.name ?? this.#generated([column], requested.unique),
            columns   : [column],
            unique    : requested.unique,
            multiEntry: requested.multiEntry,
        };
    }

    /**
     * Get the indexes of the table once the blueprint is applied.
     */
    #resolvedIndexes(): IndexSchema[] {
        const indexes: IndexSchema[] = this.#indexChanges().indexes;
        const seen: Set<string> = new Set<string>();

        for (const index of indexes) {
            if (seen.has(index.name)) {
                throw new SchemaException(`Index [${index.name}] is declared more than once on table [${this.#table}].`);
            }

            seen.add(index.name);
        }

        return indexes;
    }

    /**
     * Work out the indexes of the table once the blueprint is applied, those to create and the names of those to delete.
     */
    #indexChanges(): IndexChanges {
        const renamed: Map<string, string> = new Map(this.#renamed.map((rename: RenamedColumn): [string, string] => [rename.from, rename.to]));

        const changed: string[] = this.#columns
            .filter((column: ColumnDefinition): boolean => column.changed)
            .map((column: ColumnDefinition): string => column.name);

        const declared: IndexSchema[] = this.#declaredIndexes();
        const kept: IndexSchema[] = [];
        const moved: IndexSchema[] = [];
        const removed: string[] = [...this.#unindexed];

        for (const index of this.#indexesOf().filter((existing: IndexSchema): boolean => !this.#unindexed.includes(existing.name))) {
            const dropped: string[] = index.columns.filter((column: string): boolean => this.#dropped.includes(column));

            if (dropped.length === index.columns.length) {
                removed.push(index.name);

                continue;
            }

            if (dropped.length > 0) {
                throw new SchemaException(`Column [${dropped[0]}] of table [${this.#table}] may not be dropped while index [${index.name}] covers it. Drop the index first.`);
            }

            const columns: string[] = index.columns.map((column: string): string => renamed.get(column) ?? column);
            const name: string = index.name === this.#generated(index.columns, index.unique) ? this.#generated(columns, index.unique) : index.name;
            const carried: IndexSchema = { ...index, name, columns };

            if (carried.columns.length === 1 && changed.includes(carried.columns[0] as string)) {
                const position: number = declared.findIndex((candidate: IndexSchema): boolean => this.#same(carried, candidate));

                if (position === -1) {
                    removed.push(index.name);

                    continue;
                }

                // Each carried index stands in for one declaration only, so declaring it twice is
                // still reported as a duplicate rather than quietly collapsing.
                declared.splice(position, 1);
            }

            kept.push(carried);

            if (!this.#same(index, carried)) {
                removed.push(index.name);
                moved.push(carried);
            }
        }

        return { indexes: [...kept, ...declared], created: [...moved, ...declared], removed };
    }

    /**
     * Determine whether two indexes are declared identically.
     */
    #same(first: IndexSchema, second: IndexSchema): boolean {
        return first.name === second.name
            && first.unique === second.unique
            && first.multiEntry === second.multiEntry
            && first.columns.length === second.columns.length
            && first.columns.every((column: string, position: number): boolean => column === second.columns[position]);
    }
}
