import { SchemaException } from '../exceptions';
import type { Projection } from './types';

export class Columns {
    /**
     * Split a column into its table and its name.
     */
    static split(column: string): { table: string | null; name: string } {
        const separator: number = column.indexOf('.');

        if (separator === -1) {
            return { table: null, name: column };
        }

        return { table: column.slice(0, separator), name: column.slice(separator + 1) };
    }

    /**
     * Split a column into the column itself and the JSON path followed into it.
     */
    static path(column: string): { column: string; path: string[] } {
        const [name, ...path]: string[] = column.split('->');

        return { column: name as string, path };
    }

    /**
     * Read the value a record holds under a column, following its JSON path when it has one.
     */
    static read(record: Record<string, unknown>, column: string): unknown {
        let value: unknown = record;

        // Only own properties of plain objects are followed, so a segment such as __proto__ or
        // constructor never reaches a prototype, and no segment indexes into an array or a string.
        for (const segment of column.split('->')) {
            if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, segment)) {
                return undefined;
            }

            value = (value as Record<string, unknown>)[segment];
        }

        return value;
    }

    /**
     * Qualify a column with the table that owns it, or fail when that is not decidable.
     */
    static resolve(column: string, tables: Map<string, string[]>): string {
        const { column: name, path }: { column: string; path: string[] } = this.path(column);

        return [this.#owned(name, tables), ...path].join('->');
    }

    /**
     * Parse a projection, which may alias the column it selects.
     */
    static parse(expression: string): Projection {
        const alias: number = expression.toLowerCase().indexOf(' as ');

        if (alias === -1) {
            return { column: expression, alias: this.named(expression) };
        }

        return {
            column: expression.slice(0, alias).trim(),
            alias : expression.slice(alias + 4).trim(),
        };
    }

    /**
     * Get the name a column comes back under when nothing aliases it: the last step of its path, or else the column without its table.
     */
    static named(column: string): string {
        const { column: name, path }: { column: string; path: string[] } = this.path(column);

        return path.at(-1) ?? this.split(name).name;
    }

    /**
     * Determine whether a column names the table that owns it.
     */
    static qualified(column: string): boolean {
        return this.split(this.path(column).column).table !== null;
    }

    /**
     * Qualify a column that carries no JSON path with the table that owns it.
     */
    static #owned(column: string, tables: Map<string, string[]>): string {
        const { table, name }: { table: string | null; name: string } = this.split(column);

        if (table !== null) {
            if (!tables.has(table)) {
                throw new SchemaException(`Column [${column}] names table [${table}], which this query does not join.`);
            }

            return column;
        }

        const owners: string[] = [...tables]
            .filter(([, columns]: [string, string[]]): boolean => columns.includes(name))
            .map(([owner]: [string, string[]]): string => owner);

        // Left unqualified, a column shared by two joined tables would silently resolve to whichever
        // one happened to win the flat merge, so it is rejected rather than guessed at.
        if (owners.length > 1) {
            throw new SchemaException(`Column [${name}] is ambiguous across tables [${owners.join(', ')}]. Qualify it, as in [${owners[0]}.${name}].`);
        }

        if (owners.length === 0) {
            throw new SchemaException(`Column [${name}] does not exist on any table this query reads.`);
        }

        return `${owners[0]}.${name}`;
    }
}
