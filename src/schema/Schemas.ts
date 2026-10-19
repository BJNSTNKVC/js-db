import type { Connection } from '../database/Connection';
import type { ColumnSchema, ColumnType, TableSchema } from './types';

export class Schemas {
    /**
     * Get the schema of each of the given tables, in the order given.
     */
    static async of(connection: Connection, tables: string[]): Promise<TableSchema[]> {
        const schemas: TableSchema[] = [];

        for (const table of tables) {
            schemas.push(await connection.schema(table));
        }

        return schemas;
    }

    /**
     * Get the column a table declares under the given name, if any.
     */
    static column(schema: TableSchema, name: string | null | undefined): ColumnSchema | undefined {
        return schema.columns.find((candidate: ColumnSchema): boolean => candidate.name === name);
    }

    /**
     * Get the type a table declares for the given column, if any.
     */
    static type(schema: TableSchema, name: string | null | undefined): ColumnType | undefined {
        return this.column(schema, name)?.type;
    }
}
