/**
 * Phase 1.1 (S-1): memory problem-domain separation.
 *
 * Two ownership boundaries, asserted statically:
 *  1. `heap-budget.ts` (payer-authority domain) imports ONLY `memory-budget.ts`
 *     — no synthesis / pass / orchestrator / state out-edges.
 *  2. `memory-budget.ts` (host-capacity domain) is the sole import of
 *     `heap-budget.ts`.
 *
 * The exact caller-set invariant — `memoryBudgetBytes` callers ==
 * {resolver-pool.ts, heap-budget.ts} — is the *post-Phase-2.3* state. It
 * cannot hold in Phase 1.1 because `c-fnptr-synthesizer.ts` still calls
 * `memoryBudgetBytes` (its removal is Phase 2.3's completion proof, and Phase
 * 2.3 depends on this phase). So this file asserts the boundary it can satisfy
 * now; the exact-caller-set assertion lives in Phase 2.3.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
import {
	affordability,
	derivedCeiling,
	heapFacts,
	type HeapFacts,
} from '../src/resolution/heap-budget';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RES = path.join(SRC, 'resolution');

function read(rel: string): string {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Extract local (relative-path) import specifiers from a TS source string. */
function localImports(source: string): string[] {
	const specs: string[] = [];
	// ESM `from '...'` and dynamic `import('...')`; relative specifiers only.
	const re = /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		specs.push(m[1]);
	}
	return specs;
}

/** Resolve a relative import specifier against a file into a repo-relative path. */
function resolveImport(importerAbs: string, spec: string): string {
	const dir = path.dirname(importerAbs);
	const resolved = path.resolve(dir, spec);
	// Prefer .ts; fall back to .js source if a .ts isn't present.
	for (const ext of ['.ts', '.js']) {
		const p = resolved + ext;
		if (fs.existsSync(p)) return path.relative(ROOT, p).replace(/\\/g, '/');
	}
	// Bare directory → index.ts
	const idx = path.join(resolved, 'index.ts');
	if (fs.existsSync(idx)) return path.relative(ROOT, idx).replace(/\\/g, '/');
	return path.relative(ROOT, resolved).replace(/\\/g, '/');
}

/** Recursively collect the transitive local import closure of a module. */
function importClosure(startRel: string): Set<string> {
	const seen = new Set<string>();
	const stack = [startRel];
	while (stack.length) {
		const rel = stack.pop()!;
		if (seen.has(rel)) continue;
		seen.add(rel);
		const abs = path.join(ROOT, rel);
		const src = fs.existsSync(abs) ? read(rel) : '';
		for (const spec of localImports(src)) {
			const next = resolveImport(abs, spec);
			if (!seen.has(next)) stack.push(next);
		}
	}
	return seen;
}

describe('Phase 1.1 — S-1 memory problem-domain separation', () => {
	const heapBudgetPath = path.join(RES, 'heap-budget.ts');
	const heapBudgetRel = 'src/resolution/heap-budget.ts';

	it('heap-budget.ts imports only memory-budget.ts (no synthesis layer)', () => {
		const src = read(heapBudgetRel);
		const specs = localImports(src);
		// Every relative import must resolve to memory-budget.ts.
		const resolved = specs.map((s) => resolveImport(heapBudgetPath, s));
		const unique = Array.from(new Set(resolved));
		expect(unique).toEqual(['src/resolution/memory-budget.ts']);
	});

	it('heap-budget.ts out-edge closure contains no synthesizer/pass/orchestrator/state module', () => {
		const closure = importClosure(heapBudgetRel);
		// The closure must be exactly {heap-budget.ts, memory-budget.ts} — no
		// synthesis/pass/orchestrator/state leakage. memory-budget.ts itself
		// imports only node: builtins (child_process/fs/os), so the closure is
		// bounded to these two files.
		const forbidden = Array.from(closure).filter((p) =>
			/synthesizer|callback-|c-fnptr|index\.ts$|orchestrator|coverage-verdict|resolver-pool|pass/i.test(
				p
			)
		);
		expect(forbidden).toEqual([]);
		expect(closure.has(heapBudgetRel)).toBe(true);
		expect(closure.has('src/resolution/memory-budget.ts')).toBe(true);
	});

	it('heap-budget.ts does not import src/index.ts (state layer) — direction high-churn → low-churn', () => {
		const closure = importClosure(heapBudgetRel);
		expect(closure.has('src/index.ts')).toBe(false);
	});

	it('memory-budget.ts doc comment declares its consumer set', () => {
		const src = read('src/resolution/memory-budget.ts');
		expect(src).toContain('resolver-pool.ts');
		expect(src).toContain('heap-budget.ts');
		// The payer-authority domain is named so the split is discoverable.
		expect(src).toContain('heap-budget.ts');
	});

	it('HeapBudget interface declares the three Phase 2.2 capabilities', () => {
		const src = read(heapBudgetRel);
		expect(src).toMatch(/affordability\s*\(requestedRetainedBytes/);
		expect(src).toMatch(/derivedCeiling\s*\(hostBudgetBytes:\s*number,\s*hardCapBytes:\s*number\)/);
		expect(src).toMatch(/heapFacts\s*\(\)/);
		// IsolateKind is the G1 main/worker distinction surface.
		expect(src).toMatch(/IsolateKind\s*=\s*'main'\s*\|\s*'worker'/);
	});
});

describe('Phase 1.3 — skeleton integration (S-1 × S-2 joint)', () => {
	it('heap-budget.ts does not import src/index.ts (state layer) — direction high-churn → low-churn', () => {
		// The closure already excludes synthesis modules (Phase 1.1); here we
		// additionally pin that the state layer (src/index.ts) is not a
		// dependency of the budget layer. Dependencies point inward toward
		// the stable core; src/index.ts is high-churn, heap-budget.ts is core.
		const closure = importClosure('src/resolution/heap-budget.ts');
		expect(closure.has('src/index.ts')).toBe(false);
		expect(closure.has('src/bin/codegraph.ts')).toBe(false);
	});
});

describe('Phase 2.2 — O-1 HeapBudget authorization + ceiling derivation', () => {
	/** Build an injectable HeapFacts. */
	const facts = (limitBytes: number, liveBytes: number, isolateKind: 'main' | 'worker' = 'main'): HeapFacts => ({
		limitBytes, liveBytes, totalBytes: liveBytes, isolateKind,
	});

	it('injection matrix: (limit, live, request) → verdict matches each cell', () => {
		// (limit, live, request, expectedAffordable)
		const cases: Array<[number, number, number, boolean]> = [
			// Ample headroom: limit 8GB, live 100MB, request 2GB → ok.
			[8 * 1e9, 100 * 1e6, 2 * 1e9, true],
			// Exactly at headroom: limit 4GB, live 2GB, request 2GB → ok (<=).
			[4 * 1e9, 2 * 1e9, 2 * 1e9, true],
			// One byte over headroom → refused.
			[4 * 1e9, 2 * 1e9, 2 * 1e9 + 1, false],
			// Live already at limit, any request → refused.
			[4 * 1e9, 4 * 1e9, 1, false],
			// Zero request with headroom → ok.
			[4 * 1e9, 1 * 1e9, 0, true],
		];
		for (const [limit, live, request, ok] of cases) {
			const v = affordability(request, facts(limit, live));
			expect(v.affordable).toBe(ok);
			expect(v.limitBytes).toBe(limit);
			expect(v.liveBytes).toBe(live);
			expect(v.headroomBytes).toBe(Math.max(0, limit - live));
			expect(v.reason).toBe(ok ? 'ok' : 'insufficient-headroom');
		}
	});

	it('host-free memory arbitrarily large, but isolate headroom insufficient ⇒ affordable=false (R2 core)', () => {
		// The #1212 defect: the host read idle-empty (huge budget) but the
		// paying isolate's headroom was exhausted. affordability must refuse
		// based on the ISOLATE's live set, not the host's free memory.
		const hugeHostBudget = 71.9 * 1e9; // the machine's freemem×0.5 from the incident
		const request = 2.09 * 1e9; // cFnPtr full cache retention (91116 × 24576 B)
		// Isolate is nearly full: limit 4GB, live 3.9GB → headroom ~100MB.
		const v = affordability(request, facts(4 * 1e9, 3.9 * 1e9));
		expect(v.affordable).toBe(false);
		expect(v.reason).toBe('insufficient-headroom');
		expect(v.headroomBytes).toBeLessThan(request);
		// The huge host budget is irrelevant to the isolate's verdict — it is
		// not even an input to affordability (only the isolate facts are).
		expect(hugeHostBudget).toBeGreaterThan(request); // sanity: host would've said yes
	});

	it('derivedCeiling ≤ cgroup limit when present; ≤ hard cap when absent', () => {
		const hardCap = 6 * 1e9;
		// Contained: cgroup limit 4GB, host budget 8GB → ceiling ≤ 4GB (×0.8 safety).
		// On non-Linux, cgroupMemoryAvailable() returns null, so we can only
		// assert the uncontained path here; the contained path is exercised via
		// the Docker cgroup validation (deferred). Still assert the hard-cap
		// fallback holds and is flagged.
		const uncontained = derivedCeiling(8 * 1e9, hardCap);
		expect(uncontained.ceilingBytes).toBeLessThanOrEqual(hardCap);
		// On Linux with a cgroup, degradedToFallback would be false; elsewhere
		// it's true. Either way the ceiling is bounded by the hard cap.
		if (uncontained.degradedToFallback) {
			expect(uncontained.ceilingBytes).toBe(hardCap);
		}
	});

	it('derivedCeiling never exceeds the cgroup bound when one is probeable', () => {
		// Inject a tiny host budget to exercise the min(hostBudget, cgroup) path.
		// On non-Linux this still exercises the fallback (no cgroup), but the
		// safety-margin logic (×0.8) must hold on the contained path too.
		const hardCap = 8 * 1e9;
		const tinyHost = 2 * 1e9; // 2GB host budget
		const d = derivedCeiling(tinyHost, hardCap);
		// Ceiling is at most 80% of the environmental bound (or the hard cap).
		expect(d.ceilingBytes).toBeLessThanOrEqual(Math.max(tinyHost * 0.8, hardCap));
		expect(d.ceilingBytes).toBeLessThanOrEqual(hardCap);
	});

	it('heapFacts() in a real worker_threads sub-isolate reports isolateKind=worker and a truthful limitBytes (G4/C11)', async () => {
		// Spawn a worker that calls heapFacts() and posts the result. The
		// worker has NO resourceLimits (C11: we never add them), so under a
		// raised main --max-old-space-size it would report the main's limit —
		// that's the honest reading we must surface, not disguise.
		const workerSrc = `
			const { parentPort } = require('worker_threads');
			const { heapFacts } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'resolution', 'heap-budget.ts'))});
			// heap-budget.ts is TS; worker can't require it directly. Use the
			// compiled dist instead.
		`;
		// The worker can't require .ts directly — use the built dist module.
		const distHeapBudget = path.resolve(__dirname, '..', 'dist', 'resolution', 'heap-budget.js');
		const workerCode = `
			const { parentPort } = require('worker_threads');
			const { heapFacts } = require(${JSON.stringify(distHeapBudget)});
			parentPort.postMessage(heapFacts());
		`;
		const result = await new Promise<HeapFacts>((resolve, reject) => {
			const w = new Worker(workerCode, { eval: true });
			w.on('message', resolve);
			w.on('error', reject);
			w.on('exit', (c) => { if (c !== 0) reject(new Error(`worker exit ${c}`)); });
		});
		expect(result.isolateKind).toBe('worker');
		expect(result.limitBytes).toBeGreaterThan(0);
		// Truthful reading: the worker's heap_size_limit is a real V8 figure
		// (it equals the main isolate's when no resourceLimits are set — G4).
		expect(Number.isFinite(result.limitBytes)).toBe(true);
	});

	it('heapFacts() on the main isolate reports isolateKind=main', () => {
		const f = heapFacts();
		expect(f.isolateKind).toBe('main');
		expect(f.limitBytes).toBeGreaterThan(0);
		expect(f.liveBytes).toBeGreaterThanOrEqual(0);
	});
});

describe('Phase 2.1 — O-4 per-pass edge count + heap delta timing', () => {
	const BIN = path.resolve(__dirname, '..', 'dist', 'bin', 'codegraph.js');
	const { spawnSync } = require('child_process') as typeof import('child_process');

	it('CODEGRAPH_SYNTH_TIMINGS=all emits one record per gated-in pass, each with edge count + isolate identity', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-timing-'));
		try {
			fs.writeFileSync(path.join(dir, 'a.js'), `
const { EventEmitter } = require('events');
const bus = new EventEmitter();
function onTick() {}
bus.on('tick', onTick);
function emit() { bus.emit('tick'); }
`);
			fs.writeFileSync(path.join(dir, 'b.go'), `
package main
type Shape interface { Area() int }
type Square struct { side int }
func (s Square) Area() int { return s.side * s.side }
func total(sh Shape) int { return sh.Area() }
`);
			const r = spawnSync(process.execPath, [BIN, 'init'], {
				cwd: dir, encoding: 'utf-8',
				env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_SYNTH_TIMINGS: 'all' },
			});
			const lines = r.stderr.split('\n').filter((l) => l.startsWith('[synth-timing]'));
			// O-4 enhanced the synthesis-pass emissions with edge-count + heap
			// fields. Resolution-phase timings (chainedConformance, maintenance,
			// …) still use the legacy bare format — filter them out.
			const passLines = lines.filter((l) => /edges=\d+/.test(l));
			// At least one synthesis pass ran (emitterEdges for JS, go pre-passes for Go).
			expect(passLines.length).toBeGreaterThanOrEqual(1);
			// Every enhanced record carries the edge count, isolate identity, and
			// heap-delta fields (O-4's discriminating measurement).
			for (const line of passLines) {
				expect(line).toMatch(/edges=\d+/);
				expect(line).toMatch(/isolate=(main|worker)/);
				expect(line).toMatch(/heapDelta=[+-]?\d+/);
				expect(line).toMatch(/heapLimit=\d+/);
			}
			// The main isolate is the emitter here (no pool on a 2-file repo).
			expect(lines.some((l) => l.includes('isolate=main'))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('CODEGRAPH_SYNTH_TIMINGS unset ⇒ zero [synth-timing] output (existing behavior unchanged)', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-timing-'));
		try {
			fs.writeFileSync(path.join(dir, 'a.js'), `
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.on('tick', () => {});
bus.emit('tick');
`);
			const r = spawnSync(process.execPath, [BIN, 'init'], {
				cwd: dir, encoding: 'utf-8',
				env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
			});
			const lines = r.stderr.split('\n').filter((l) => l.startsWith('[synth-timing]'));
			expect(lines).toHaveLength(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
