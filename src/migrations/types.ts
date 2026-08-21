import type { Migration } from './Migration';

export type MigrationConstructor = new () => Migration;

export interface MigrationRecord {
    order: number;
    migration: string;
    at: string;
}

export interface MigrationStatus {
    migration: string;
    ran: boolean;
    at: string | null;
}
