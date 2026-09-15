/**
 * SQLite Execution Repository
 */

import type { ConductorDatabase } from './database.js';
import { Execution } from '../domain/execution.js';
import type { ExecutionState, ExecutionStatus } from '../types/execution.js';

export interface ExecutionFilter {
  status?: ExecutionStatus;
  limit?: number;
  offset?: number;
}

export interface IExecutionRepository {
  save(execution: Execution): void;
  findById(id: string): Execution | null;
  list(filter?: ExecutionFilter): Execution[];
  delete(id: string): boolean;
  count(status?: ExecutionStatus): number;
}

interface ExecutionRow {
  id: string;
  goal: string;
  status: string;
  state_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export class SqliteExecutionRepository implements IExecutionRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(execution: Execution): void {
    const state = execution.toState();
    const stateJson = JSON.stringify(state);

    const stmt = this.db.raw.prepare(`
      INSERT INTO executions (id, goal, status, state_json, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal = excluded.goal,
        status = excluded.status,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `);

    stmt.run(
      state.executionId,
      state.goal,
      state.status,
      stateJson,
      state.timestamps.createdAt,
      state.timestamps.updatedAt,
      state.timestamps.completedAt ?? null,
    );
  }

  public findById(id: string): Execution | null {
    const stmt = this.db.raw.prepare(`
      SELECT id, goal, status, state_json, created_at, updated_at, completed_at
      FROM executions
      WHERE id = ?
    `);

    const row = stmt.get(id) as unknown as ExecutionRow | undefined;
    if (!row) {
      return null;
    }

    try {
      const state = JSON.parse(row.state_json) as ExecutionState;
      return new Execution(state);
    } catch {
      return null;
    }
  }

  public list(filter: ExecutionFilter = {}): Execution[] {
    let sql = `
      SELECT id, goal, status, state_json, created_at, updated_at, completed_at
      FROM executions
    `;
    const params: (string | number)[] = [];

    if (filter.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY updated_at DESC';

    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);

      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const stmt = this.db.raw.prepare(sql);
    const rows = (stmt.all as (...args: (string | number)[]) => unknown[])(...params) as unknown as ExecutionRow[];

    const results: Execution[] = [];
    for (const row of rows) {
      try {
        const state = JSON.parse(row.state_json) as ExecutionState;
        results.push(new Execution(state));
      } catch {
        // Skip corrupted row
      }
    }
    return results;
  }

  public delete(id: string): boolean {
    const stmt = this.db.raw.prepare('DELETE FROM executions WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }

  public count(status?: ExecutionStatus): number {
    let sql = 'SELECT COUNT(*) as count FROM executions';
    const params: string[] = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    const stmt = this.db.raw.prepare(sql);
    const row = (stmt.get as (...args: string[]) => unknown)(...params) as unknown as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
