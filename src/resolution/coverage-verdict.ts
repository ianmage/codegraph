/**
 * CoverageVerdict — per-pass synthesis outcome + terminal-state verdict (O-3).
 *
 * Makes the four pass fates — `complete`, `truncated`, `skipped`, `failed` —
 * readable facts, and gives a SINGLE owner the terminal-state decision so the
 * E8 split (a thrown pass left no record; `index_state` still read `complete`)
 * can't recur.
 *
 * Projection is keyed by pass **NAME**, not dense array index, so adding or
 * removing an entry in `SYNTH_PASSES` needs no migration — a stale projection
 * for a removed pass is simply ignored, and a new pass with no recorded
 * verdict reads as absent (not `complete`). Persisted to the existing
 * `project_metadata` table via `QueryBuilder.setMetadata`; no new tables, no
 * schema migration (C10). Each synthesis run OVERWRITES the prior coverage
 * row — coverage never accumulates across runs.
 *
 * Semantics (S-2):
 *  - `skipped(gated)` — a pass whose language is absent; its result is
 *    provably empty. Does NOT degrade. (K4: a language-absent pass is
 *    behaviorally empty, not a coverage gap.)
 *  - `truncated` / `skipped(at-scale)` / `failed` — these DO degrade: the
 *    pass had work but didn't finish it.
 *  - All `complete` (incl. any `skipped(gated)`) → terminal `complete`.
 *  - `partial` (file-gap) takes PRECEDENCE over the coverage verdict — a
 *    file-short index is `partial` regardless of synthesis outcome. That
 *    precedence is applied by `src/index.ts` (the sole `index_state` writer),
 *    not here: this module only produces the coverage verdict.
 *
 * This module does NOT write `index_state`. It produces a terminal verdict
 * that `src/index.ts` reads and persists alongside the file-gap check.
 */

/** The four fates a synthesis pass can have. */
export type PassOutcome = 'complete' | 'truncated' | 'skipped' | 'failed';

/**
 * Why a pass ended in a non-`complete` state. Required for `failed`,
 * `skipped(at-scale)`, and `truncated`; absent for `complete` and
 * `skipped(gated)` (the latter is a normal, non-degrading skip).
 */
export type SkipReason = 'gated' | 'at-scale';

export interface PassVerdict {
	passName: string;
	outcome: PassOutcome;
	/** Edge count the pass produced (0 for skipped/failed-before-emit). */
	edgeCount: number;
	/** Required for `failed`, `truncated`, `skipped(at-scale)`. */
	reason?: string;
	/** Distinguishes the non-degrading `gated` skip from `at-scale`. */
	skipReason?: SkipReason;
	/** Wall-clock ms the pass took (diagnostic; K-1 attribution). */
	ms?: number;
}

/** Terminal state derived from the full pass-verdict set. */
export type CoverageTerminalState = 'complete' | 'degraded';

export interface CoverageProjection {
	terminalState: CoverageTerminalState;
	/** Keyed by pass name — survives SYNTH_PASSES reordering/addition/removal. */
	verdicts: Record<string, PassVerdict>;
	/** True if recordSynthesisFailure was called (whole-synthesis failure). */
	synthesisFailed: boolean;
	synthesisFailureReason?: string;
}

/**
 * Collects pass outcomes and derives the terminal coverage verdict.
 *
 * A single instance per synthesis run. Not thread-safe by construction —
 * synthesis runs on the indexer's main thread (workers report back to it).
 * Pure with respect to its inputs: all persistence goes through the injected
 * `setMetadata` callback, so the module is unit-testable without a DB.
 */
export class CoverageVerdict {
	private readonly verdicts = new Map<string, PassVerdict>();
	private synthesisFailed = false;
	private synthesisFailureReason: string | undefined;

	/**
	 * Record a pass's outcome.
	 */
	recordPassOutcome(
		passName: string,
		outcome: PassOutcome,
		reason?: string,
		edgeCount = 0,
		skipReason?: SkipReason,
		ms?: number
	): void {
		this.verdicts.set(passName, { passName, outcome, reason, edgeCount, skipReason, ms });
	}

	/** Record a whole-synthesis failure (e.g. the catch in resolution/index.ts). */
	recordSynthesisFailure(reason: string): void {
		this.synthesisFailed = true;
		this.synthesisFailureReason = reason;
	}

	/**
	 * Derive the terminal verdict. A non-`complete` pass (except `skipped(gated)`)
	 * degrades; a synthesis-level failure always degrades. All-`complete`
	 * (with any number of `skipped(gated)`) is `complete`.
	 */
	project(): CoverageProjection {
		const out: Record<string, PassVerdict> = {};
		let degraded = this.synthesisFailed;
		for (const v of this.verdicts.values()) {
			out[v.passName] = v;
			if (this.isDegrading(v)) degraded = true;
		}
		return {
			terminalState: degraded ? 'degraded' : 'complete',
			verdicts: out,
			synthesisFailed: this.synthesisFailed,
			synthesisFailureReason: this.synthesisFailureReason,
		};
	}

	/** A verdict degrades unless it's `complete` or a language-gated skip. */
	private isDegrading(v: PassVerdict): boolean {
		if (v.outcome === 'complete') return false;
		if (v.outcome === 'skipped' && v.skipReason === 'gated') return false;
		return true;
	}

	/**
	 * Persist the projection to `project_metadata` as a single JSON value under
	 * `synth_coverage`. Overwrites any prior row (coverage never accumulates).
	 * No new tables, no migration (C10). The injected setter keeps this pure.
	 */
	persist(setMetadata: (key: string, value: string) => void): void {
		const p = this.project();
		setMetadata('synth_coverage', JSON.stringify(p));
	}
}
