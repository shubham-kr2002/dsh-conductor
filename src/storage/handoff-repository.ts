/**
 * Handoff Repository
 *
 * Persists structured handoff state so one agent can resume an execution
 * with the other agent's full, transcript-free context.
 */

import type { ConductorDatabase } from './database.js';
import type { StructuredHandoffState } from '../types/handoff.js';

export interface IHandoffRepository {
  save(handoff: StructuredHandoffState): void;
  findById(id: string): StructuredHandoffState | null;
  listByExecution(executionId: string): StructuredHandoffState[];
  latestForExecution(executionId: string): StructuredHandoffState | null;
}

interface HandoffRow {
  id: string;
  execution_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  state_json: string;
  timestamp: number;
}

export class SqliteHandoffRepository implements IHandoffRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(handoff: StructuredHandoffState): void {
    this.db.raw
      .prepare(
        `INSERT INTO handoffs (id, execution_id, from_agent_id, to_agent_id, state_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           to_agent_id = excluded.to_agent_id,
           state_json = excluded.state_json,
           timestamp = excluded.timestamp`,
      )
      .run(
        handoff.handoffId,
        handoff.executionId,
        handoff.fromAgentId,
        handoff.toAgentId ?? null,
        JSON.stringify(handoff),
        handoff.timestamp,
      );
  }

  public findById(id: string): StructuredHandoffState | null {
    const stmt = this.db.raw.prepare('SELECT * FROM handoffs WHERE id = ?');
    const row = (stmt.get as (id: string) => unknown)(id) as HandoffRow | undefined;
    return row ? (JSON.parse(row.state_json) as StructuredHandoffState) : null;
  }

  public listByExecution(executionId: string): StructuredHandoffState[] {
    const stmt = this.db.raw.prepare(
      'SELECT * FROM handoffs WHERE execution_id = ? ORDER BY timestamp DESC',
    );
    const rows = (stmt.all as (id: string) => unknown[])(executionId) as HandoffRow[];
    return rows.map((r) => JSON.parse(r.state_json) as StructuredHandoffState);
  }

  public latestForExecution(executionId: string): StructuredHandoffState | null {
    const stmt = this.db.raw.prepare(
      'SELECT * FROM handoffs WHERE execution_id = ? ORDER BY timestamp DESC LIMIT 1',
    );
    const row = (stmt.get as (id: string) => unknown)(executionId) as HandoffRow | undefined;
    return row ? (JSON.parse(row.state_json) as StructuredHandoffState) : null;
  }
}
