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
