export type Enumerable = readonly string[] | Record<string, string | number>;

export type ColumnType = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'json' | 'decimal' | 'enum';

export interface ColumnSchema {
    name: string;
    type: ColumnType;
    nullable: boolean;
    default: unknown;
    hasDefault: boolean;
    primary: boolean;
    increments: boolean;
    places: number | null;
    values: string[] | null;
}

export interface IndexSchema {
    name: string;
    columns: string[];
    unique: boolean;
    multiEntry: boolean;
}

export interface TableSchema {
    table: string;
    key: string | null;
    increments: boolean;
    timestamps: boolean;
    columns: ColumnSchema[];
    indexes: IndexSchema[];
}

export interface RenamedColumn {
    from: string;
    to: string;
}

export interface BlueprintOperations {
    added: ColumnSchema[];
    dropped: string[];
    renamed: RenamedColumn[];
    indexed: IndexSchema[];
    unindexed: string[];
}

export interface RequestedIndex {
    name: string | null;
    unique: boolean;
    multiEntry: boolean;
}
