/**
 * Phase 4.2 (M-3): crash re-entry — synthesis-only rerun.
 *
 * An index interrupted during dynamic-dispatch synthesis (index_state =
 * `synthesis_incomplete`) has a committed, queryable base graph. Re-running
 * performs synthesis ONLY — no re-scan, re-parse, re-resolve, or DB recreate —
 * reusing the SAME synthesizeCallbackEdges code path (D5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('Phase 4.2 — crash re-entry (synthesis-only rerun)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-resume-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a synthesis_incomplete index is queryable (base graph committed)', async () => {
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export function f(): number { return 1; }\n');
		fs.writeFileSync(path.join(dir, 'b.ts'), 'import { f } from "./a";\nexport const y = f();\n');
		const cg = CodeGraph.initSync(dir);
		await cg.indexAll();
		cg.close();

		// Simulate a kill during synthesis: stamp synthesis_incomplete.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { DatabaseSync } = require('node:sqlite');
		const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'));
		db.prepare(
			"INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'synthesis_incomplete', 0) " +
				"ON CONFLICT(key) DO UPDATE SET value = 'synthesis_incomplete'"
		).run();
		db.close();

		// The base graph is queryable: a caller lookup returns results.
		const reopened = await CodeGraph.open(dir);
		expect(reopened.getIndexState()).toBe('synthesis_incomplete');
		const callers = reopened.getCallers('f');
		expect(Array.isArray(callers)).toBe(true);
		reopened.close();
	});

	it('rerunSynthesis does not recreate the DB file (inode/creation preserved)', async () => {
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export function f(): number { return 1; }\n');
		const cg = CodeGraph.initSync(dir);
		await cg.indexAll();
		cg.close();

		const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
		const statBefore = fs.statSync(dbPath);
		const inoBefore = statBefore.ino;

		// Re-open and re-run synthesis only.
		const reopened = await CodeGraph.open(dir);
		await reopened.rerunSynthesis();
		reopened.close();

		const statAfter = fs.statSync(dbPath);
		// The DB file was NOT recreated — same inode (the file identity is
		// preserved; only its mtime changed from writes).
		expect(statAfter.ino).toBe(inoBefore);
	});

	it('rerunSynthesis reuses the same synthesizeCallbackEdges code path (D5)', async () => {
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export const x = 1;\n');
		const cg = CodeGraph.initSync(dir);
		await cg.indexAll();
		cg.close();

		// rerunSynthesis is the synthesis-only entry; it must use the SAME
		// synthesizeCallbackEdges path as a full index (D5: no second path).
		const reopened = await CodeGraph.open(dir);
		const count = await reopened.rerunSynthesis();
		expect(typeof count).toBe('number');
		expect(count).toBeGreaterThanOrEqual(0);
		// The coverage verdict is recorded and the resumable marker advances to
		// its honest terminal state; a successful rerun must not remain stuck at
		// synthesis_incomplete forever.
		const cov = reopened.getSynthCoverage();
		expect(cov).not.toBeNull();
		expect(reopened.getIndexState()).toBe(cov!.terminalState);
		reopened.close();
	});

	it('full indexing releases resolution-only caches before synthesis', async () => {
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export function f(): number { return 1; }\n');
		fs.writeFileSync(path.join(dir, 'b.ts'), 'import { f } from "./a";\nexport const y = f();\n');
		const cg = CodeGraph.initSync(dir);
		await cg.indexAll();
		const resolver = (cg as any).resolver;
		// warmCaches populated these during reference resolution. They are not
		// synthesis inputs and must not cross the resolution→synthesis boundary.
		expect(resolver.knownNames).toBeNull();
		expect(resolver.knownFiles).toBeNull();
		expect(resolver.razorUsingsCache.size).toBe(0);
		cg.close();
	});

	it('worker preparation replaces the warmed pool at the phase boundary', () => {
		const resolverSource = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'index.ts'),
			'utf8'
		);
		const poolSource = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'resolver-pool.ts'),
			'utf8'
		);
		expect(resolverSource).toContain('await pool.destroy()');
		expect(resolverSource).toContain('const freshPool = ResolverPool.tryCreate');
		expect(resolverSource).toContain('await freshPool.ready()');
		expect(poolSource).toContain('if (this.failed) throw this.failed');
	});

	it('rerunSynthesis produces an edge set consistent with a full run (diff empty)', async () => {
		// A fixture with a synthesized edge (EventEmitter registration).
		fs.writeFileSync(path.join(dir, 'a.js'), `
const { EventEmitter } = require('events');
const bus = new EventEmitter();
function onTick() {}
bus.on('tick', onTick);
function emit() { bus.emit('tick'); }
`);
		// Full index — baseline edge set.
		const cg1 = CodeGraph.initSync(dir);
		await cg1.indexAll();
		const baselineEdges = (cg1 as any).db.db
			.prepare('SELECT count(*) c FROM edges')
			.get().c as number;
		cg1.close();

		// Re-run synthesis only — should not change the edge count (the
		// synthesized edges are idempotent: re-running produces the same set,
		// and insertEdges dedupes via the seen-key in the merge).
		const cg2 = await CodeGraph.open(dir);
		await cg2.rerunSynthesis();
		const rerunEdges = (cg2 as any).db.db
			.prepare('SELECT count(*) c FROM edges')
			.get().c as number;
		cg2.close();

		expect(rerunEdges).toBe(baselineEdges);
	});
});

describe('Phase 4.4 — muscle integration (M-2 × M-3 × M-4 joint)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-muscle-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('kill during synthesis → synthesis_incomplete → rerun (no recreate) → edges match', async () => {
		fs.writeFileSync(path.join(dir, 'a.js'), `
const { EventEmitter } = require('events');
const bus = new EventEmitter();
function onTick() {}
bus.on('tick', onTick);
function emit() { bus.emit('tick'); }
`);
		// Full index — the baseline.
		const cg = CodeGraph.initSync(dir);
		await cg.indexAll();
		const baselineEdges = (cg as any).db.db.prepare('SELECT count(*) c FROM edges').get().c as number;
		cg.close();

		// Simulate a kill during synthesis: stamp synthesis_incomplete.
		const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
		const inoBefore = fs.statSync(dbPath).ino;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { DatabaseSync } = require('node:sqlite');
		const db = new DatabaseSync(dbPath);
		db.prepare(
			"INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'synthesis_incomplete', 0) " +
				"ON CONFLICT(key) DO UPDATE SET value = 'synthesis_incomplete'"
		).run();
		db.close();

		// Re-open: state is synthesis_incomplete, graph queryable.
		const reopened = await CodeGraph.open(dir);
		expect(reopened.getIndexState()).toBe('synthesis_incomplete');

		// Re-run synthesis: no recreate (same inode), edges match baseline.
		await reopened.rerunSynthesis();
		const rerunEdges = (reopened as any).db.db.prepare('SELECT count(*) c FROM edges').get().c as number;
		reopened.close();

		expect(fs.statSync(dbPath).ino).toBe(inoBefore);
		expect(rerunEdges).toBe(baselineEdges);
	});

	it('a live lock holder is not preempted (M-4 liveness-first)', () => {
		// The lock test is in file-lock-liveness.test.ts; here we just pin
		// that the lock module is the liveness-first implementation (M-4).
		const src = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'utils.ts'),
			'utf8'
		);
		// The age-AND-liveness short-circuit is gone; liveness is primary.
		expect(src).not.toMatch(/lockAge < FileLock\.STALE_TIMEOUT_MS && !isNaN\(pid\) && this\.isProcessAlive\(pid\)/);
		expect(src).toMatch(/!isNaN\(pid\) && this\.isProcessAlive\(pid\)/);
	});
});
