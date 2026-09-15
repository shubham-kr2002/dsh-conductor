/**
 * SQLite Database Connection & Management
 *
 * Uses Node.js native `node:sqlite` (DatabaseSync).
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SCHEMA_V1 } from './schema.js';

export interface DatabaseOptions {
  path?: string; // ':memory:' or file path
  enableWal?: boolean;
}

export class ConductorDatabase {
  private _db: DatabaseSync | null = null;
  public readonly path: string;

  constructor(options: DatabaseOptions = {}) {
    this.path = options.path ?? ':memory:';
    this.init(options.enableWal ?? true);
  }

  private init(enableWal: boolean): void {
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this._db = new DatabaseSync(this.path);

    // Pragmas
    this._db.exec('PRAGMA foreign_keys = ON;');
    if (this.path !== ':memory:' && enableWal) {
      this._db.exec('PRAGMA journal_mode = WAL;');
    }

    // Apply schema
    this._db.exec(SCHEMA_V1);
  }

  public get raw(): DatabaseSync {
    if (!this._db) {
      throw new Error('Database is closed');
    }
    return this._db;
  }

  public exec(sql: string): void {
    this.raw.exec(sql);
  }

  public close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  public isOpen(): boolean {
    return this._db !== null;
  }
}
