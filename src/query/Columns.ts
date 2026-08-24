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
     * Qualify a column with the table that owns it, or fail when that is not decidable.
     */
    static resolve(column: string, tables: Map<string, string[]>): string {
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

    /**
     * Parse a projection, which may alias the column it selects.
     */
    static parse(expression: string): Projection {
        const alias: number = expression.toLowerCase().indexOf(' as ');

        if (alias === -1) {
            return { column: expression, alias: this.split(expression).name };
        }

        return {
            column: expression.slice(0, alias).trim(),
            alias : expression.slice(alias + 4).trim(),
        };
    }
}
