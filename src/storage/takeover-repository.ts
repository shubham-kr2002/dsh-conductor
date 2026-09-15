/**
 * Takeover Repository
 *
 * Persistence for take-over episodes: the frozen workspace snapshot, the
 * continuation context generated at freeze time, and (on return) the human
 * modifications detected at continue time.
 */

import type { ConductorDatabase } from './database.js';
import type { WorkspaceSnapshot, WorkspaceDiff } from '../takeover/workspace-snapshot.js';
import type { ContinuationContext } from '../takeover/continuation-context.js';

export interface TakeoverRecord {
  id: string;
  executionId: string;
  actor: string;
  status: 'active' | 'returned';
  snapshot: WorkspaceSnapshot;
  continuation: ContinuationContext;
  humanModifications?: WorkspaceDiff;
  notes?: string;
  startedAt: number;
  returnedAt?: number;
}

export interface ITakeoverRepository {
  save(record: TakeoverRecord): void;
  findById(id: string): TakeoverRecord | null;
  findActive(executionId: string): TakeoverRecord | null;
  listByExecution(executionId: string): TakeoverRecord[];
}

interface TakeoverRow {
  id: string;
  execution_id: string;
  actor: string;
  status: string;
  snapshot_json: string;
  continuation_json: string;
  human_modifications_json: string | null;
  notes: string | null;
  started_at: number;
  returned_at: number | null;
}

function rowToRecord(row: TakeoverRow): TakeoverRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    actor: row.actor,
    status: row.status === 'returned' ? 'returned' : 'active',
    snapshot: JSON.parse(row.snapshot_json) as WorkspaceSnapshot,
    continuation: JSON.parse(row.continuation_json) as ContinuationContext,
    humanModifications:
      row.human_modifications_json != null
        ? (JSON.parse(row.human_modifications_json) as WorkspaceDiff)
        : undefined,
    notes: row.notes ?? undefined,
    startedAt: Number(row.started_at),
    returnedAt: row.returned_at != null ? Number(row.returned_at) : undefined,
  };
}

export class SqliteTakeoverRepository implements ITakeoverRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(record: TakeoverRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO takeovers (
           id, execution_id, actor, status, snapshot_json, continuation_json,
           human_modifications_json, notes, started_at, returned_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           snapshot_json = excluded.snapshot_json,
           continuation_json = excluded.continuation_json,
           human_modifications_json = excluded.human_modifications_json,
           notes = excluded.notes,
           returned_at = excluded.returned_at`,
      )
      .run(
        record.id,
        record.executionId,
        record.actor,
        record.status,
        JSON.stringify(record.snapshot),
        JSON.stringify(record.continuation),
        record.humanModifications ? JSON.stringify(record.humanModifications) : null,
        record.notes ?? null,
        record.startedAt,
        record.returnedAt ?? null,
      );
  }

  public findById(id: string): TakeoverRecord | null {
    const stmt = this.db.raw.prepare('SELECT * FROM takeovers WHERE id = ?');
    const row = (stmt.get as (id: string) => unknown)(id);
    return row ? rowToRecord(row as TakeoverRow) : null;
  }

  public findActive(executionId: string): TakeoverRecord | null {
    const stmt = this.db.raw.prepare(
      `SELECT * FROM takeovers WHERE execution_id = ? AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
    );
    const row = (stmt.get as (id: string) => unknown)(executionId);
    return row ? rowToRecord(row as TakeoverRow) : null;
  }

  public listByExecution(executionId: string): TakeoverRecord[] {
    const stmt = this.db.raw.prepare(
      'SELECT * FROM takeovers WHERE execution_id = ? ORDER BY started_at DESC',
    );
    const rows = (stmt.all as (id: string) => unknown[])(executionId);
    return rows.map((r) => rowToRecord(r as TakeoverRow));
  }
}
