/**
 * Tests for the CI/scripting fields `codegraph status --json` exposes (issue
 * #329): the `version`, `indexPath`, and `lastIndexed` fields, plus the
 * matching `CodeGraph.getLastIndexedAt()` library method.
 *
 * The CLI itself is exercised end-to-end against the built binary so the JSON
 * field names survive future refactors of the underlying plumbing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

function runStatusJson(cwd: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [BIN, 'status', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // JSON mode prints exactly one line to stdout; be defensive about any stray
  // leading output by parsing the last non-empty line.
  const line = stdout.trim().split('\n').filter(Boolean).pop()!;
  return JSON.parse(line);
}

describe('codegraph status --json — CI fields (#329)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-json-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getLastIndexedAt() is null before indexing and a recent ms timestamp after', async () => {
    const cg = CodeGraph.initSync(tempDir);
    expect(cg.getLastIndexedAt()).toBeNull();

    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    await cg.indexAll();
    const after = Date.now();

    const last = cg.getLastIndexedAt();
    expect(last).not.toBeNull();
    expect(typeof last).toBe('number');
    expect(last!).toBeGreaterThanOrEqual(before - 1000);
    expect(last!).toBeLessThanOrEqual(after + 1000);
    cg.close();
  });

  it('status --json on an UNINITIALIZED project reports version + indexPath + lastIndexed:null', () => {
    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(false);
    expect(out.version).toBe(PKG_VERSION);
    expect(typeof out.indexPath).toBe('string');
    expect(out.indexPath as string).toContain('.codegraph');
    expect(out.lastIndexed).toBeNull();
  });

  it('status --json on an INDEXED project reports version + indexPath + a round-trippable lastIndexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    const after = Date.now();
    cg.close();

    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(true);
    expect(out.version).toBe(PKG_VERSION);
    expect(out.indexPath as string).toContain('.codegraph');
    expect(typeof out.lastIndexed).toBe('string');
    // ISO string that round-trips back into the index window.
    const ms = Date.parse(out.lastIndexed as string);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });
});

describe('index completeness marker (index_state)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-state-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Six-state orthogonal model (Phase 1.2 / S-2): graph-queryable ×
   * dynamic-coverage-complete. Each state must round-trip through both the
   * library reader (`getIndexState()`) and the CLI JSON field, and the
   * `journal_mode` at the `synthesis_incomplete` site must be `wal` (K7
   * ordering invariant — the marker is only written after the graph is
   * committed and WAL-recovered, so the on-disk graph is queryable).
   */
  const SIX_STATES = [
    'indexing',
    'synthesis_incomplete',
    'degraded',
    'partial',
    'failed',
    'complete',
  ] as const;

  /** Write a raw index_state value straight into the DB, as a dead process would. */
  function stampState(cwd: string, state: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(cwd, '.codegraph', 'codegraph.db'));
    db.prepare(
      "INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', ?, 0) " +
        'ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(state, state);
    db.close();
  }

  it.each(SIX_STATES)('state=%s round-trips through getIndexState() and status --json', async (state) => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    stampState(tempDir, state);

    const reopened = await CodeGraph.open(tempDir);
    expect(reopened.getIndexState()).toBe(state);
    reopened.close();

    const out = runStatusJson(tempDir);
    expect((out.index as Record<string, unknown>).state).toBe(state);
  });

  it('getIndexState() returns null for an unknown index_state string (unknown states do not masquerade as a known one)', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    stampState(tempDir, 'totally-bogus-state');

    const reopened = await CodeGraph.open(tempDir);
    expect(reopened.getIndexState()).toBeNull();
    reopened.close();
  });

  it('synthesis_incomplete site has journal_mode=wal (K7: marker written after graph commit + WAL recovery)', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    // A completed index is in WAL mode (the maintenance fold restores it).
    // synthesis_incomplete is written at the same durability boundary, so the
    // live journal_mode at that site is wal.
    const out = runStatusJson(tempDir);
    expect(out.journalMode).toBe('wal');
  });

  it('index_state write points are all in src/index.ts (single writer)', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (/setMetadata\(\s*['"]index_state['"]/.test(content)) {
          writers.push(path.relative(srcDir, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(srcDir);
    // Every write site is in src/index.ts — no other module writes index_state.
    expect(writers).toEqual(['index.ts']);
  });

  /**
   * Phase 1.3 joint assertion: the six-state enum is closed at the type level,
   * and getIndexState() returns null for any string outside it (preserving the
   * pre-existing behavior for unknown values rather than masquerading).
   */
  it('the six-state union is closed: getIndexState() accepts exactly the six known states and null', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    const known = ['indexing', 'synthesis_incomplete', 'degraded', 'partial', 'failed', 'complete'];
    for (const state of known) {
      stampState(tempDir, state);
      const reopened = await CodeGraph.open(tempDir);
      expect(reopened.getIndexState()).toBe(state);
      reopened.close();
    }
    // Unknown strings collapse to null — the union is closed.
    stampState(tempDir, 'some-future-state');
    const reopened = await CodeGraph.open(tempDir);
    expect(reopened.getIndexState()).toBeNull();
    reopened.close();
  });

  it('a clean full index stamps state=complete with reconciled counts', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function f(): number { return 1; }\n');
    fs.writeFileSync(path.join(tempDir, 'b.ts'), 'import { f } from "./a";\nexport const y = f();\n');
    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    // The scan's ground truth is reported and fully accounted for.
    expect(result.filesDiscovered).toBeDefined();
    expect(result.filesIndexed + result.filesSkipped + result.filesErrored).toBe(
      result.filesDiscovered
    );
    expect(result.errors.filter((e) => e.code === 'index_partial')).toHaveLength(0);
    expect(cg.getIndexState()).toBe('complete');
    cg.close();

    const out = runStatusJson(tempDir);
    expect((out.index as Record<string, unknown>).state).toBe('complete');
  });

  it('a run killed mid-index leaves state=indexing, and status --json surfaces it', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    // Simulate a kill between the start-marker write and completion: the
    // marker a dead process leaves behind is exactly 'indexing'. Written
    // straight into the DB — the process that died can't have cleaned it up.
    // (require, not import: vite tries to bundle a dynamic import specifier.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tempDir, '.codegraph', 'codegraph.db'));
    db.prepare(
      "INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'indexing', 0) " +
        "ON CONFLICT(key) DO UPDATE SET value = 'indexing'"
    ).run();
    db.close();

    const out = runStatusJson(tempDir);
    expect((out.index as Record<string, unknown>).state).toBe('indexing');

    const reopened = await CodeGraph.open(tempDir);
    expect(reopened.getIndexState()).toBe('indexing');
    reopened.close();
  });
});

/**
 * Phase 3.2 (V-2): state-reader surface — the new states reach the CLI text
 * renderer with honest, non-destructive guidance, and MCP tools keep responding
 * (success-shaped, not isError) under them.
 */
describe('Phase 3.2 — state-reader surface (V-2)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-state-readers-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runStatusText(cwd: string): string {
    return execFileSync(process.execPath, [BIN, 'status'], {
      cwd, encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function stampState(cwd: string, state: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(cwd, '.codegraph', 'codegraph.db'));
    db.prepare(
      "INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', ?, 0) " +
        'ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(state, state);
    db.close();
  }

  function stampCoverage(cwd: string, coverage: object): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(cwd, '.codegraph', 'codegraph.db'));
    const json = JSON.stringify(coverage);
    db.prepare(
      "INSERT INTO project_metadata (key, value, updated_at) VALUES ('synth_coverage', ?, 0) " +
        'ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(json, json);
    db.close();
  }

  it('synthesis_incomplete text guidance points to re-running index (not a destructive rebuild)', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
    stampState(tempDir, 'synthesis_incomplete');

    const text = runStatusText(tempDir);
    // The guidance must mention synthesis was interrupted and the graph is queryable.
    expect(text).toMatch(/synthesis was interrupted/i);
    expect(text).toMatch(/queryable/i);
    // It must NOT tell the user to delete or destroy the index.
    expect(text).not.toMatch(/delete.*\.codegraph/i);
    expect(text).not.toMatch(/destroy/i);
  });

  it('degraded text guidance lists the degradation reason from the O-3 coverage verdict', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
    stampState(tempDir, 'degraded');
    stampCoverage(tempDir, {
      terminalState: 'degraded',
      verdicts: {
        cFnPtrEdges: { outcome: 'truncated', reason: 'capped at SYNTH_PASS_EDGE_CAP=50000', edgeCount: 50000 },
        emitterEdges: { outcome: 'complete', edgeCount: 12 },
      },
      synthesisFailed: false,
    });

    const text = runStatusText(tempDir);
    expect(text).toMatch(/degraded/i);
    // The specific degrading pass and its reason are surfaced.
    expect(text).toMatch(/cFnPtrEdges/);
    expect(text).toMatch(/truncated/i);
  });

  it('MCP tools (explore/node/callers) respond under synthesis_incomplete without isError', async () => {
    // The index is queryable under synthesis_incomplete (the base graph is
    // committed). MCP tools must return success-shaped responses, not errors —
    // safety comes from response shape, not from hiding tools.
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function f(): number { return 1; }\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
    stampState(tempDir, 'synthesis_incomplete');

    const reopened = await CodeGraph.open(tempDir);
    // The graph is queryable: a node lookup returns results.
    const callers = reopened.getCallers('f');
    expect(Array.isArray(callers)).toBe(true);
    reopened.close();
  });
});
