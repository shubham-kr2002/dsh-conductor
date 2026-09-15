/**
 * SQLite Event Repository
 */

import type { ConductorDatabase } from './database.js';
import type { ConductorEvent, ConductorEventType, EventSource } from '../types/event.js';

export interface EventFilter {
  type?: ConductorEventType;
  limit?: number;
  offset?: number;
}

export interface IEventRepository {
  save(event: ConductorEvent): void;
  listByExecution(executionId: string, filter?: EventFilter): ConductorEvent[];
  countByExecution(executionId: string): number;
}

interface EventRow {
  id: string;
  execution_id: string;
  type: string;
  source: string;
  timestamp: number;
  payload_json: string;
  metadata_json: string | null;
}

export class SqliteEventRepository implements IEventRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(event: ConductorEvent): void {
    const stmt = this.db.raw.prepare(`
      INSERT INTO execution_events (id, execution_id, type, source, timestamp, payload_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);

    stmt.run(
      event.id,
      event.executionId,
      event.type,
      event.source,
      event.timestamp,
      JSON.stringify(event.payload),
      event.metadata ? JSON.stringify(event.metadata) : null,
    );
  }

  public listByExecution(executionId: string, filter: EventFilter = {}): ConductorEvent[] {
    let sql = `
      SELECT id, execution_id, type, source, timestamp, payload_json, metadata_json
      FROM execution_events
      WHERE execution_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (filter.type) {
      sql += ' AND type = ?';
      params.push(filter.type);
    }

    sql += ' ORDER BY timestamp ASC';

    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);

      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const stmt = this.db.raw.prepare(sql);
    const rows = (stmt.all as (...args: (string | number)[]) => unknown[])(...params) as unknown as EventRow[];

    const events: ConductorEvent[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json);
        const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : undefined;
        events.push({
          id: row.id,
          executionId: row.execution_id,
          type: row.type as ConductorEventType,
          source: row.source as EventSource,
          timestamp: row.timestamp,
          payload,
          metadata,
        });
      } catch {
        // Skip corrupted row
      }
    }
    return events;
  }

  public countByExecution(executionId: string): number {
    const stmt = this.db.raw.prepare(`
      SELECT COUNT(*) as count FROM execution_events WHERE execution_id = ?
    `);
    const row = stmt.get(executionId) as unknown as { count: number };
    return row?.count ?? 0;
  }
}
