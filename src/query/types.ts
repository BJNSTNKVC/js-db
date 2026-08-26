export type Key<T> = (keyof T & string) | (string & {});

export type Operator = '=' | '==' | '===' | '!=' | '<>' | '!==' | '<' | '>' | '<=' | '>=' | 'like' | 'not like';

export type Conjunction = 'and' | 'or';

export type Direction = 'asc' | 'desc';

export type DatePart = 'year' | 'month' | 'day';

export type Constraint =
    | { type: 'basic'; column: string; operator: Operator; value: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'in'; column: string; values: unknown[]; conjunction: Conjunction; not: boolean }
    | { type: 'null'; column: string; conjunction: Conjunction; not: boolean }
    | { type: 'between'; column: string; from: unknown; to: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'column'; column: string; operator: Operator; other: string; conjunction: Conjunction; not: boolean }
    | { type: 'part'; column: string; part: DatePart; value: number; conjunction: Conjunction; not: boolean }
    | { type: 'nested'; constraints: Constraint[]; conjunction: Conjunction; not: boolean };

export interface Order {
    column: string;
    direction: Direction;
}

export interface Plan {
    source: 'key' | 'index' | 'scan';
    index: string | null;
    range: IDBKeyRange | null;
    values: unknown[] | null;
    direction: IDBCursorDirection;
    ordered: boolean;
    residual: Constraint[];
}

export type JoinType = 'inner' | 'left' | 'right' | 'cross';

export interface JoinCondition {
    first: string;
    operator: Operator;
    second: string;
    conjunction: Conjunction;
}

export interface JoinClause {
    table: string;
    type: JoinType;
    conditions: JoinCondition[];
}

export interface Projection {
    column: string;
    alias: string;
}

export interface Paginated<T> {
    data: T[];
    total: number;
    perPage: number;
    currentPage: number;
    lastPage: number;
}

export type Aggregation =
    | { count: '*' | (string & {}) }
    | { sum: string }
    | { avg: string }
    | { min: string }
    | { max: string };

export type Aggregations = Record<string, Aggregation>;

export type Aggregated<A extends Aggregation> = A extends { count: unknown } ? number : number | null;

export type Grouped<T, G extends (keyof T & string)[], A extends Aggregations> =
    { [K in G[number]]: T[K] } & { [K in keyof A]: Aggregated<A[K]> };
