/**
 * Delegation Repository
 *
 * Persistence for explicit human delegations. Rows are immutable facts of
 * trust: granting creates, revoking stamps (revoked_at/by) rather than
 * deleting, so the audit trail survives every change of mind.
 */

import type { ConductorDatabase } from './database.js';
import type { Delegation, DelegationOrigin, DelegationScope } from '../types/delegation.js';
import type { PolicyCategory } from '../types/policy.js';

export interface IDelegationRepository {
  save(delegation: Delegation): void;
  findById(id: string): Delegation | null;
  /** Active (not revoked, not expired at `now`), optionally per execution. */
  listActive(now: number, executionId?: string): Delegation[];
  listAll(): Delegation[];
}

interface DelegationRow {
  id: string;
  execution_id: string | null;
  scope: string;
  category: string;
  resource_pattern: string | null;
  authority: string;
  origin: string;
  granted_by: string;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  note: string | null;
}

function rowToDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    scope: row.scope as DelegationScope,
    executionId: row.execution_id,
    category: row.category as PolicyCategory | 'any',
    resourcePattern: row.resource_pattern,
    authority: row.authority as Delegation['authority'],
    origin: row.origin as DelegationOrigin,
    grantedBy: row.granted_by,
    grantedAt: Number(row.granted_at),
    expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
    revokedAt: row.revoked_at != null ? Number(row.revoked_at) : null,
    revokedBy: row.revoked_by,
    ...(row.note != null ? { note: row.note } : {}),
  };
}

export class SqliteDelegationRepository implements IDelegationRepository {
  constructor(private readonly db: ConductorDatabase) {}

  public save(d: Delegation): void {
    const stmt = this.db.raw.prepare(`
      INSERT INTO delegations (
        id, execution_id, scope, category, resource_pattern, authority, origin,
        granted_by, granted_at, expires_at, revoked_at, revoked_by, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        revoked_by = excluded.revoked_by,
        note = excluded.note
    `);
    stmt.run(
      d.id,
      d.executionId,
      d.scope,
      d.category,
      d.resourcePattern,
      d.authority,
      d.origin,
      d.grantedBy,
      d.grantedAt,
      d.expiresAt,
      d.revokedAt,
      d.revokedBy,
      d.note ?? null,
    );
  }

  public findById(id: string): Delegation | null {
    const row = this.db.raw.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as
      | DelegationRow
      | undefined;
    return row ? rowToDelegation(row) : null;
  }

  public listActive(now: number, executionId?: string): Delegation[] {
    let sql = `
      SELECT * FROM delegations
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (scope = 'workspace' OR execution_id = ?)
    `;
    const params: (string | number)[] = [now, executionId ?? ''];
    if (executionId === undefined) {
      sql = `
        SELECT * FROM delegations
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `;
      params.length = 1;
    }
    sql += ' ORDER BY granted_at ASC';
    const rows = (this.db.raw.prepare(sql).all as (...a: (string | number)[]) => unknown[])(
      ...params,
    ) as unknown as DelegationRow[];
    return rows.map(rowToDelegation);
  }

  public listAll(): Delegation[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM delegations ORDER BY granted_at ASC')
      .all() as unknown as DelegationRow[];
    return rows.map(rowToDelegation);
  }
}
