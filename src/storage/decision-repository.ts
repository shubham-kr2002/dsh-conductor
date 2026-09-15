/**
 * SQLite Decision Repository
 */

import type { ConductorDatabase } from './database.js';
import type {
  ConductorDecision,
  DecisionOption,
  DecisionStatus,
  DecisionResolution,
} from '../types/decision.js';

export interface DecisionFilter {
  status?: DecisionStatus;
  executionId?: string;
}

export interface IDecisionRepository {
  save(decision: ConductorDecision): void;
  findById(id: string): ConductorDecision | null;
  list(filter?: DecisionFilter): ConductorDecision[];
  delete(id: string): boolean;
}

interface DecisionRow {
  id: string;
  execution_id: string;
  title: string;
  question: string;
  context: string;
  impact: string;
  urgency: string;
  confidence: number;
  status: string;
  options_json: string;
  recommendation: string | null;
  resolution_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

function rowToDecision(row: DecisionRow): ConductorDecision | null {
  try {
    return {
      id: row.id,
      executionId: row.execution_id,
      title: row.title,
      question: row.question,
      context: row.context,
      impact: row.impact as ConductorDecision['impact'],
      urgency: row.urgency as ConductorDecision['urgency'],
      confidence: row.confidence,
      status: row.status as DecisionStatus,
      options: JSON.parse(row.options_json) as DecisionOption[],
      recommendation: row.recommendation ?? undefined,
      resolution: row.resolution_json
        ? (JSON.parse(row.resolution_json) as DecisionResolution)
        : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at ?? undefined,
    };
  } catch {
    return null;
  }
}

export class SqliteDecisionRepository implements IDecisionRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(decision: ConductorDecision): void {
    const stmt = this.db.raw.prepare(`
      INSERT INTO decisions (
        id, execution_id, title, question, context, impact, urgency, confidence,
        status, options_json, recommendation, resolution_json,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        question = excluded.question,
        context = excluded.context,
        impact = excluded.impact,
        urgency = excluded.urgency,
        confidence = excluded.confidence,
        status = excluded.status,
        options_json = excluded.options_json,
        recommendation = excluded.recommendation,
        resolution_json = excluded.resolution_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `);

    stmt.run(
      decision.id,
      decision.executionId,
      decision.title,
      decision.question,
      decision.context,
      decision.impact,
      decision.urgency,
      decision.confidence,
      decision.status,
      JSON.stringify(decision.options),
      decision.recommendation ?? null,
      decision.resolution ? JSON.stringify(decision.resolution) : null,
      decision.createdAt,
      decision.updatedAt,
      decision.expiresAt ?? null,
    );
  }

  public findById(id: string): ConductorDecision | null {
    const stmt = this.db.raw.prepare('SELECT * FROM decisions WHERE id = ?');
    const row = stmt.get(id) as unknown as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  public list(filter: DecisionFilter = {}): ConductorDecision[] {
    let sql = 'SELECT * FROM decisions';
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.executionId) {
      where.push('execution_id = ?');
      params.push(filter.executionId);
    }
    if (where.length > 0) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY created_at ASC';

    const stmt = this.db.raw.prepare(sql);
    const rows = (stmt.all as (...args: (string | number)[]) => unknown[])(
      ...params,
    ) as unknown as DecisionRow[];

    const results: ConductorDecision[] = [];
    for (const row of rows) {
      const d = rowToDecision(row);
      if (d) results.push(d);
    }
    return results;
  }

  public delete(id: string): boolean {
    const stmt = this.db.raw.prepare('DELETE FROM decisions WHERE id = ?');
    return stmt.run(id).changes > 0;
  }
}
