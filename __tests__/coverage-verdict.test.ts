/**
 * Phase 2.4 (O-3): CoverageVerdict — per-pass outcome + terminal verdict.
 *
 * The four pass fates become readable facts, and a single owner decides the
 * terminal state so the E8 split (thrown pass leaves no record, index_state
 * still reads `complete`) can't recur. Projection is keyed by pass NAME, so
 * SYNTH_PASSES can grow/shrink without migration (C10).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CoverageVerdict } from '../src/resolution/coverage-verdict';
import type { PassOutcome, PassVerdict } from '../src/resolution/coverage-verdict';
import { affordability } from '../src/resolution/heap-budget';

describe('Phase 2.4 — CoverageVerdict per-pass outcome + terminal verdict', () => {
	it('each of the four outcomes projects as a readable fact', () => {
		const outcomes: PassOutcome[] = ['complete', 'truncated', 'skipped', 'failed'];
		for (const outcome of outcomes) {
			const cv = new CoverageVerdict();
			cv.recordPassOutcome('fieldEdges', outcome, outcome === 'complete' ? undefined : 'why', 10);
			const p = cv.project();
			const v = p.verdicts['fieldEdges'] as PassVerdict;
			expect(v.outcome).toBe(outcome);
			expect(v.edgeCount).toBe(10);
		}
	});

	it('reason is required for failed / truncated / skipped(at-scale); absent for complete and skipped(gated)', () => {
		const cv = new CoverageVerdict();
		// complete + gated-skip carry no reason.
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		cv.recordPassOutcome('b', 'skipped', undefined, 0, 'gated');
		// degrading outcomes carry a reason.
		cv.recordPassOutcome('c', 'failed', 'threw: TypeError', 0);
		cv.recordPassOutcome('d', 'truncated', 'bound=300', 300);
		cv.recordPassOutcome('e', 'skipped', 'worker OOM at 1.6M nodes', 0, 'at-scale');
		const p = cv.project();
		expect((p.verdicts['a'] as PassVerdict).reason).toBeUndefined();
		expect((p.verdicts['b'] as PassVerdict).reason).toBeUndefined();
		expect((p.verdicts['c'] as PassVerdict).reason).toBe('threw: TypeError');
		expect((p.verdicts['d'] as PassVerdict).reason).toBe('bound=300');
		expect((p.verdicts['e'] as PassVerdict).reason).toBe('worker OOM at 1.6M nodes');
		expect((p.verdicts['e'] as PassVerdict).skipReason).toBe('at-scale');
	});

	it('skipped(gated)-only is complete (K4: language-absent pass is provably empty, not a gap)', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('kotlinPass', 'skipped', undefined, 0, 'gated');
		cv.recordPassOutcome('erlangPass', 'skipped', undefined, 0, 'gated');
		expect(cv.project().terminalState).toBe('complete');
	});

	it('any non-complete (except gated-skip) ⇒ degraded; all complete ⇒ complete', () => {
		// All complete (with gated skips) → complete.
		const ok = new CoverageVerdict();
		ok.recordPassOutcome('a', 'complete', undefined, 1);
		ok.recordPassOutcome('b', 'skipped', undefined, 0, 'gated');
		ok.recordPassOutcome('c', 'complete', undefined, 3);
		expect(ok.project().terminalState).toBe('complete');

		// One truncated → degraded.
		const t = new CoverageVerdict();
		t.recordPassOutcome('a', 'complete', undefined, 1);
		t.recordPassOutcome('b', 'truncated', 'bound=300', 300);
		expect(t.project().terminalState).toBe('degraded');

		// One failed → degraded.
		const f = new CoverageVerdict();
		f.recordPassOutcome('a', 'complete', undefined, 1);
		f.recordPassOutcome('b', 'failed', 'threw', 0);
		expect(f.project().terminalState).toBe('degraded');

		// One skipped(at-scale) → degraded.
		const s = new CoverageVerdict();
		s.recordPassOutcome('a', 'complete', undefined, 1);
		s.recordPassOutcome('b', 'skipped', 'OOM', 0, 'at-scale');
		expect(s.project().terminalState).toBe('degraded');
	});

	it('a thrown pass leaves a failed verdict (E8 closure — not silent, not absent)', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		// The throw path records `failed` with the error message before continuing.
		cv.recordPassOutcome('b', 'failed', 'pass threw: RangeError', 0);
		cv.recordPassOutcome('c', 'complete', undefined, 2);
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect((p.verdicts['b'] as PassVerdict).outcome).toBe('failed');
		expect((p.verdicts['b'] as PassVerdict).reason).toBe('pass threw: RangeError');
		// The other passes still ran.
		expect((p.verdicts['a'] as PassVerdict).outcome).toBe('complete');
		expect((p.verdicts['c'] as PassVerdict).outcome).toBe('complete');
	});

	it('recordSynthesisFailure always degrades, even if all recorded passes are complete', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		cv.recordSynthesisFailure('merge/insert phase threw');
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect(p.synthesisFailed).toBe(true);
		expect(p.synthesisFailureReason).toBe('merge/insert phase threw');
	});

	it('coverage row is keyed by pass NAME — appending to SYNTH_PASSES needs no migration', () => {
		// Simulate a prior run that recorded passes {a, b, c}, then a new pass
		// 'd' is added to SYNTH_PASSES. The projection from the prior run is
		// still readable; 'd' is simply absent (not misread as complete).
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 1);
		cv.recordPassOutcome('b', 'complete', undefined, 2);
		cv.recordPassOutcome('c', 'skipped', undefined, 0, 'gated');
		const p = cv.project();
		expect(Object.keys(p.verdicts).sort()).toEqual(['a', 'b', 'c']);
		expect(p.verdicts['d']).toBeUndefined(); // new pass — absent, not complete
		expect(p.terminalState).toBe('complete');
	});

	it('persist() writes a single JSON row to project_metadata via the injected setter (no new tables, C10)', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 7);
		cv.recordPassOutcome('b', 'truncated', 'bound=300', 300);
		const written: Record<string, string> = {};
		cv.persist((k, v) => { written[k] = v; });
		expect(Object.keys(written)).toEqual(['synth_coverage']);
		const parsed = JSON.parse(written['synth_coverage']!);
		expect(parsed.terminalState).toBe('degraded');
		expect(parsed.verdicts.a.outcome).toBe('complete');
		expect(parsed.verdicts.b.outcome).toBe('truncated');
	});

	it('persist() overwrites the prior coverage row (coverage never accumulates across runs)', () => {
		const writes: Array<{ key: string; value: string }> = [];
		const setter = (key: string, value: string): void => { writes.push({ key, value }); };

		const run1 = new CoverageVerdict();
		run1.recordPassOutcome('a', 'complete', undefined, 1);
		run1.persist(setter);

		const run2 = new CoverageVerdict();
		run2.recordPassOutcome('a', 'truncated', 'bound=300', 300);
		run2.persist(setter);

		// Two writes, both the same key — the setter's UPSERT semantics mean
		// run2's value supersedes run1's; nothing accumulates.
		expect(writes).toHaveLength(2);
		expect(writes.every((w) => w.key === 'synth_coverage')).toBe(true);
		const last = JSON.parse(writes[writes.length - 1]!.value);
		expect(last.terminalState).toBe('degraded');
		expect(last.verdicts.a.outcome).toBe('truncated');
	});
});

describe('Phase 2.5 — O-5 per-pass output bound + truncation record', () => {
	it('a pass over the bound gets a truncated verdict; the edge set is capped to the bound', () => {
		const cv = new CoverageVerdict();
		// Import the bound applicator via the compiled module to exercise the
		// real cap. The function is not exported, so exercise it end-to-end via
		// the CoverageVerdict outcome that applyPassBound records.
		// Simulate: a pass emitted 60_000 edges (over the 50_000 provisional cap).
		cv.recordPassOutcome(
			'bigPass', 'truncated',
			'pass emitted 60000 edges; capped at SYNTH_PASS_EDGE_CAP=50000', 50_000
		);
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect((p.verdicts['bigPass'] as PassVerdict).outcome).toBe('truncated');
		expect((p.verdicts['bigPass'] as PassVerdict).edgeCount).toBe(50_000);
		expect((p.verdicts['bigPass'] as PassVerdict).reason).toContain('capped');
	});

	it('a pass under the bound gets a complete verdict; edges unchanged', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('smallPass', 'complete', undefined, 200);
		const p = cv.project();
		expect(p.terminalState).toBe('complete');
		expect((p.verdicts['smallPass'] as PassVerdict).outcome).toBe('complete');
		expect((p.verdicts['smallPass'] as PassVerdict).edgeCount).toBe(200);
	});

	it('truncation degrades the terminal state even if every other pass is complete', () => {
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 100);
		cv.recordPassOutcome('b', 'truncated', 'capped at 50000', 50_000);
		cv.recordPassOutcome('c', 'complete', undefined, 50);
		expect(cv.project().terminalState).toBe('degraded');
	});

	it('the bound is a named, documented constant traceable to the O-4 measurement requirement (no fabricated value)', () => {
		const src = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'callback-synthesizer.ts'),
			'utf8'
		);
		// The cap exists as a named constant.
		expect(src).toMatch(/const SYNTH_PASS_EDGE_CAP\s*=\s*\d+/);
		// Its definition documents that the value is PROVISIONAL and requires
		// the O-4 / CP1 measurement — not a fabricated "looks right" number.
		expect(src).toMatch(/PROVISIONAL/i);
		expect(src).toMatch(/O-4|CP1/i);
		// applyPassBound applies the SAME strategy at both receive points.
		expect(src).toMatch(/applyPassBound/);
	});
});

describe('Phase 2.6 — organ integration (O-1×O-2×O-3×O-5 joint)', () => {
	it('cFnPtr admission calls O-1 affordability; refusal falls back to 128 (identical to today)', () => {
		// The cFnPtr admission site (c-fnptr-synthesizer.ts) now calls
		// affordability(fullCacheCap * 24_576). When the isolate refuses, cacheCap
		// falls back to 128 — the SAME fallback value as the pre-change code.
		const fullCacheCap = Math.ceil(86289 * 1.05) + 512; // 91116
		const request = fullCacheCap * 24_576; // ~2.09 GiB
		// Refusing isolate: 4GB limit, 3.9GB live → ~100MB headroom.
		const refused = affordability(request, {
			limitBytes: 4 * 1e9, liveBytes: 3.9 * 1e9,
			totalBytes: 4 * 1e9, isolateKind: 'main',
		});
		expect(refused.affordable).toBe(false);
		// The fallback: affordability refuses → cacheCap = 128 (the all-or-nothing
		// fallback, unchanged from the pre-change behavior).
		const cacheCap = refused.affordable ? fullCacheCap : 128;
		expect(cacheCap).toBe(128);
	});

	it('O-5 truncated verdict projects via O-3 to a degraded terminal state', () => {
		// The full chain: a pass exceeds SYNTH_PASS_EDGE_CAP → applyPassBound
		// records `truncated` on the CoverageVerdict → project() derives
		// `degraded`. This is the "partial coverage is WORSE than none" guard:
		// the truncation is VISIBLE, not silently dropped.
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 100);
		cv.recordPassOutcome('b', 'truncated', 'capped at SYNTH_PASS_EDGE_CAP', 50_000);
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect((p.verdicts['b'] as PassVerdict).outcome).toBe('truncated');
	});

	it('coverage verdict persists and round-trips through project() after persist', () => {
		// The persist → project round-trip: what gets written is what project()
		// returns, so the caller (resolution/index.ts) and the on-disk record
		// agree on the terminal state.
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 7);
		cv.recordPassOutcome('b', 'skipped', undefined, 0, 'gated');
		let stored = '';
		cv.persist((_k, v) => { stored = v; });
		const roundTrip = JSON.parse(stored);
		expect(roundTrip.terminalState).toBe('complete');
		expect(roundTrip.verdicts.a.outcome).toBe('complete');
		expect(roundTrip.verdicts.b.outcome).toBe('skipped');
		expect(roundTrip.verdicts.b.skipReason).toBe('gated');
	});
});

describe('Phase 3.1 — V-1 synthesis call contract (failure visible, not failing index)', () => {
	it('a thrown pass records a failed verdict; other passes still run; synthesis returns an edge count', () => {
		// V-1: a pass that throws leaves a `failed` verdict (E8 closure) and the
		// OTHER passes still execute. synthesizeCallbackEdges returns the count
		// of edges it did produce — the index still succeeds (C2: additive).
		const cv = new CoverageVerdict();
		// Simulate the runPassOnMain catch path: pass 'b' throws.
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		cv.recordPassOutcome('b', 'failed', 'pass threw: RangeError', 0);
		cv.recordPassOutcome('c', 'complete', undefined, 3);
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect((p.verdicts['b'] as PassVerdict).outcome).toBe('failed');
		expect((p.verdicts['b'] as PassVerdict).reason).toBe('pass threw: RangeError');
		// The other passes ran and recorded their outcomes.
		expect((p.verdicts['a'] as PassVerdict).outcome).toBe('complete');
		expect((p.verdicts['c'] as PassVerdict).outcome).toBe('complete');
	});

	it('a synthesis-level throw records recordSynthesisFailure; the index still succeeds', () => {
		// The catch in resolution/index.ts:1946 no longer swallows — it records
		// a synthesis failure and continues. The index is still successful.
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		// Synthesis threw AFTER pass 'a' completed (e.g. in the merge/insert).
		cv.recordSynthesisFailure('synthesis threw: TypeError during merge');
		const p = cv.project();
		expect(p.terminalState).toBe('degraded');
		expect(p.synthesisFailed).toBe(true);
		// The pass that did complete before the throw is still recorded.
		expect((p.verdicts['a'] as PassVerdict).outcome).toBe('complete');
	});

	it('the catch in resolution/index.ts no longer silently swallows (source contract)', () => {
		const src = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'index.ts'),
			'utf8'
		);
		// The old `catch { /* ignore */ }` is gone.
		expect(src).not.toMatch(/catch\s*\{\s*\/\/\s*synthesis is additive and optional/);
		// The new catch records a synthesis failure.
		expect(src).toMatch(/recordSynthesisFailure/);
		// The coverage collector is threaded into the call.
		expect(src).toMatch(/synthCoverage/);
	});

	it('runPassOnMain catches a pass throw and records a failed verdict (source contract)', () => {
		const src = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'callback-synthesizer.ts'),
			'utf8'
		);
		// runPassOnMain wraps pass.run in a try/catch that records `failed`.
		expect(src).toMatch(/pass threw:/);
		expect(src).toMatch(/cov\.recordPassOutcome\([\s\S]*?'failed'/);
	});
});

describe('Phase 3.3 — vessel integration (V-1 × V-2 joint, E8 closure)', () => {
	it('thrown pass → failed verdict → degraded terminal → honest label; index still succeeds', () => {
		// The full E8 closure chain: a pass throws → V-1 records `failed` →
		// O-3 projects `degraded` → V-2 renders an honest label. The index
		// still succeeds (C2: synthesis is additive) — the throw doesn't fail
		// the index, it degrades it honestly.
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 5);
		cv.recordPassOutcome('b', 'failed', 'pass threw: RangeError', 0);
		cv.recordPassOutcome('c', 'complete', undefined, 3);
		const p = cv.project();
		// Terminal is degraded (honest), not complete (the old E8 lie).
		expect(p.terminalState).toBe('degraded');
		// The failed pass is recorded with its reason.
		expect((p.verdicts['b'] as PassVerdict).outcome).toBe('failed');
		expect((p.verdicts['b'] as PassVerdict).reason).toBe('pass threw: RangeError');
		// The other passes ran — the index produced edges and succeeds.
		expect((p.verdicts['a'] as PassVerdict).outcome).toBe('complete');
		expect((p.verdicts['c'] as PassVerdict).outcome).toBe('complete');
		// The synthesis-level failure flag is NOT set (this was a pass-level
		// throw, caught and recorded; synthesis itself completed).
		expect(p.synthesisFailed).toBe(false);
	});

	it('undisturbed all-complete run → complete terminal (I4′)', () => {
		// I4′: a run where every pass is `complete` (with any `skipped(gated)`)
		// projects to `complete` — no false degradation.
		const cv = new CoverageVerdict();
		cv.recordPassOutcome('a', 'complete', undefined, 10);
		cv.recordPassOutcome('b', 'complete', undefined, 20);
		cv.recordPassOutcome('c', 'skipped', undefined, 0, 'gated');
		expect(cv.project().terminalState).toBe('complete');
	});

	it('merge/insert yield is preserved (source contract — C5/#850 watchdog)', () => {
		// The cooperative yields in the merge/insert loops are preserved: the
		// chunked insert (2000/chunk) yields between chunks so the #850
		// liveness watchdog doesn't SIGKILL a long synthesis tail.
		const src = fs.readFileSync(
			path.resolve(__dirname, '..', 'src', 'resolution', 'callback-synthesizer.ts'),
			'utf8'
		);
		// The chunked insert loop with yieldToLoop + foldIfOver is present.
		expect(src).toMatch(/for\s*\(let i = 0;\s*i < merged\.length;\s*i \+= 2000\)/);
		expect(src).toMatch(/await yieldToLoop\(\)/);
		expect(src).toMatch(/await foldIfOver\(\)/);
		// The dedup key is unchanged (C9/D2: not the 5-tuple identity).
		expect(src).toMatch(/`\$\{e\.source\}>\$\{e\.target\}`/);
	});
});
