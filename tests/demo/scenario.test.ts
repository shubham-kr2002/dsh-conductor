/**
 * Part 19 — "A Day In The Life" demo scenario tests.
 *
 * Runs the FULL scripted day against a real SQLite file in a temp dir
 * under tests/.tmp-demo-* and verifies the beats, the invariants the
 * story claims (no decision for a self-healed failure, one-time approval
 * token), and that the return-to-work numbers are honest derivations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { Execution } from '../../src/domain/execution.js';
import { computeAttentionMetrics, MINUTE_EXPORT as _nope } from './_noop'; // placeholder removed below
