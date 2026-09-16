/**
 * Conductor — DSH bundle entry
 *
 * The official Cordis plugin module installed via the bundle mechanism
 * (`package.json#dsh.bundle.patch` → `cordis.patch.yml` → profile layer →
 * this module). It is deliberately thin: the profile patch row carries
 * configuration, `mountConductor` owns the composition, and everything
 * below remains the DSH-free control plane.
 *
 * Install path:  dsh plugin --profile <p> add <dsh-conductor>
 * Do NOT also hand-add a conductor loader row to the profile patch — one
 * mounting path only (duplicate mounts are refused below regardless).
 */

import { mountConductor } from './mount.js';
import type { CordisCtx } from './cordis-plugin.js';

export const name = 'dsh-conductor';

/** In-process duplicate-mount guard (defense beyond documenting one path). */
let mountedExecutionId: string | null = null;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function apply(ctx: CordisCtx, config: Record<string, unknown> | undefined): void {
  if (mountedExecutionId !== null) {
    console.warn(
      `[conductor] already mounted in this process (execution ${mountedExecutionId}) — ` +
        'skipping duplicate registration; remove the extra loader row',
    );
    return;
  }

  const workspaceRoot = str(config?.workspaceRoot);
  const dbPath = str(config?.dbPath);
  const mount = mountConductor({
    goal: str(config?.goal) ?? 'Mounted DSH session',
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(dbPath ? { dbPath } : {}),
    autoAnswerRoutine: config?.autoAnswerRoutine === true,
    completeOnIdle: config?.completeOnIdle !== false,
    constraints: Array.isArray(config?.constraints)
      ? (config.constraints as unknown[]).map(String)
      : undefined,
  });
  mountedExecutionId = mount.executionId;

  // Reuse the exact plugin object mount produced — same listeners, same
  // bridge, no second wiring.
  mount.plugin.apply(ctx);
  ctx.effect(() => {
    mountedExecutionId = null;
    return () => mount.close();
  });

  console.log(
    `[conductor] mounted execution ${mount.executionId} · control plane ` +
      `${mount.dbPath}`,
  );
}

/** Default export mirrors the named plugin for loaders that prefer it. */
export default { name, apply };
