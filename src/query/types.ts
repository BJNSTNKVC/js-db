export type Key<T> = (keyof T & string) | (string & {});

export type Held<T, K> = K extends keyof T ? T[K] : unknown;

export type Operator = '=' | '==' | '===' | '!=' | '<>' | '!==' | '<' | '>' | '<=' | '>=' | 'like' | 'not like';

export type DateOperator = '=' | '!=' | '<>' | '<' | '>' | '<=' | '>=';

export type Conjunction = 'and' | 'or';

export type Direction = 'asc' | 'desc';

export type DatePart = 'year' | 'month' | 'day';

export type Constraint =
    | { type: 'basic'; column: string; operator: Operator; value: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'in'; column: string; values: unknown[]; conjunction: Conjunction; not: boolean }
    | { type: 'null'; column: string; conjunction: Conjunction; not: boolean }
    | { type: 'between'; column: string; from: unknown; to: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'column'; column: string; operator: Operator; other: string; conjunction: Conjunction; not: boolean }
    | { type: 'part'; column: string; part: DatePart; operator: DateOperator; value: number; timezone: string; conjunction: Conjunction; not: boolean }
    | { type: 'time'; column: string; operator: DateOperator; value: string; timezone: string; conjunction: Conjunction; not: boolean }
    | { type: 'json-contains'; column: string; value: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'json-length'; column: string; operator: Operator; value: number; conjunction: Conjunction; not: boolean }
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

export interface Query {
    readonly table: string;
    readonly transaction: IDBTransaction | null;
    readonly constraints: readonly Constraint[];
    readonly orders: readonly Order[];
    readonly random: boolean;
    readonly limit: number | null;
    readonly offset: number;
    readonly columns: readonly string[] | null;
    readonly distinct: boolean;
    readonly joins: readonly JoinClause[];
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

export type Aggregated<A extends Aggregation, T = Record<string, unknown>> = A extends { count: unknown }
    ? number
    : A extends { min: infer C } | { max: infer C } ? Held<T, C> | null : number | null;

type Stepped<K extends string> = K extends `${string}->${infer S}` ? Stepped<S> : K;

type Named<K extends string> = K extends `${string}->${string}` ? Stepped<K> : K extends `${string}.${infer N}` ? N : K;

export type Grouped<T, G extends (keyof T & string)[], A extends Aggregations> =
    { [K in G[number] as Named<K>]: T[K] } & { [K in keyof A]: Aggregated<A[K], T> };
