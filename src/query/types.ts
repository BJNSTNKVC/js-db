export type Key<T> = (keyof T & string) | (string & {})

export type Operator = '=' | '==' | '===' | '!=' | '<>' | '!==' | '<' | '>' | '<=' | '>=' | 'like' | 'not like'

export type Conjunction = 'and' | 'or'

export type Direction = 'asc' | 'desc'

export type Constraint =
    | { type: 'basic'; column: string; operator: Operator; value: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'in'; column: string; values: unknown[]; conjunction: Conjunction; not: boolean }
    | { type: 'null'; column: string; conjunction: Conjunction; not: boolean }
    | { type: 'between'; column: string; from: unknown; to: unknown; conjunction: Conjunction; not: boolean }
    | { type: 'nested'; constraints: Constraint[]; conjunction: Conjunction; not: boolean }

export interface Order {
    column: string
    direction: Direction
}

export interface Plan {
    source: 'key' | 'index' | 'scan'
    index: string | null
    range: IDBKeyRange | null
    values: unknown[] | null
    direction: IDBCursorDirection
    ordered: boolean
    residual: Constraint[]
}

export interface Record_ {
    [key: string]: unknown
}
