import type { MigrationConstructor } from '../migrations/types'

export interface ConnectionConfig {
    database: string
    migrations?: MigrationConstructor[]
    strict?: boolean
}

export interface DatabaseConfig {
    default: string
    connections: Record<string, ConnectionConfig>
}

export interface TransactionOptions {
    tables?: string[]
}

export interface QueryLogEntry {
    connection: string
    table: string
    plan: string
    duration: number
    records: number
}

export interface ListenOptions {
    once?: boolean
}
