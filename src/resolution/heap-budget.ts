/**
 * Isolate-authorized memory budget — the "payer authority" problem domain.
 *
 * Two memory questions must not share one owner:
 *  - **Host capacity** (`memory-budget.ts`): how much RAM the host/cgroup has.
 *    Consumed by `resolver-pool.ts` for worker-pool sizing.
 *  - **Isolate authority** (this module): can *this* isolate afford to retain N
 *    bytes, given its own live set and derived ceiling? Consumed by admission
 *    sites (cFnPtr cache) that previously asked the host question and got a
 *    wrong answer — the host can be idle-empty while the paying isolate's
 *    headroom is exhausted (the #1212 OOM root cause).
 *
 * Dependency direction (S-1): this module imports ONLY `memory-budget.ts` (for
 * the cgroup term of ceiling derivation). It must not depend on any
 * synthesizer / pass / orchestrator / state module — those depend on it, never
 * the reverse. Verified by `__tests__/heap-budget.test.ts`.
 */

import { cgroupMemoryAvailable, memoryBudgetBytes } from './memory-budget';

export type IsolateKind = 'main' | 'worker';

/**
 * Result of an isolate-authorized affordability check. `affordable` is the
 * verdict; the rest make the reason inspectable so a refusal is attributable
 * (K-1) rather than silent.
 */
export interface AffordabilityVerdict {
	affordable: boolean;
	limitBytes: number;
	liveBytes: number;
	headroomBytes: number;
	reason: 'ok' | 'insufficient-headroom';
}

/** Live heap statistics for the *current* isolate, read from V8. */
export interface HeapFacts {
	limitBytes: number;
	liveBytes: number;
	totalBytes: number;
	isolateKind: IsolateKind;
}

/**
 * Payer-authority surface. All inputs are injectable so the three capabilities
 * are unit-testable without a live V8 isolate (Phase 2.2 / O-1).
 */
export interface HeapBudget {
	/** Can this isolate afford to retain `requestedRetainedBytes`? */
	affordability(requestedRetainedBytes: number): AffordabilityVerdict;
	/** Derived V8 heap ceiling: cgroup-aware, hard-clamped. */
	derivedCeiling(hostBudgetBytes: number, hardCapBytes: number): number;
	/** Live heap facts for the current isolate (truthful, not derived intent). */
	heapFacts(): HeapFacts;
}

/**
 * Read the current isolate's live heap facts from V8. The `heap_size_limit` is
 * the *truthful* reading — under C11, raising the main isolate's
 * `--max-old-space-size` causes worker isolates (which have no
 * `resourceLimits`) to report that raised limit too. We surface exactly what
 * V8 reports; we never disguise a worker's reading as its own private limit
 * (G1: the faulting isolate's identity stays an open, readable fact).
 */
export function heapFacts(): HeapFacts {
	// Lazy require: keeps this module importable from contexts without worker_threads.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const v8 = require('v8') as typeof import('v8');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { isMainThread } = require('worker_threads') as typeof import('worker_threads');
	const s = v8.getHeapStatistics();
	return {
		limitBytes: s.heap_size_limit,
		liveBytes: s.used_heap_size,
		totalBytes: s.total_heap_size,
		isolateKind: isMainThread ? 'main' : 'worker',
	};
}

/**
 * Can the current isolate afford to retain `requestedRetainedBytes`?
 *
 * The admission decision DEDUCTS the current live usage — it does not compare
 * the request to the limit alone. The host can be idle-empty (huge
 * `memoryBudgetBytes()`) while this isolate's headroom is nearly exhausted;
 * asking the host question is exactly the #1212 defect. Here the paying
 * isolate authorizes its own retention.
 *
 * `facts` is injectable for testing; defaults to a live `heapFacts()` read.
 */
export function affordability(
	requestedRetainedBytes: number,
	facts: HeapFacts = heapFacts()
): AffordabilityVerdict {
	const headroomBytes = Math.max(0, facts.limitBytes - facts.liveBytes);
	const affordable = requestedRetainedBytes <= headroomBytes;
	return {
		affordable,
		limitBytes: facts.limitBytes,
		liveBytes: facts.liveBytes,
		headroomBytes,
		reason: affordable ? 'ok' : 'insufficient-headroom',
	};
}

/**
 * Derive the V8 heap ceiling to inject as `--max-old-space-size`.
 *
 * cgroup-aware: when a cgroup memory limit is probeable, the ceiling never
 * exceeds it (else V8 grows past the cgroup cap and the OS SIGKILLs the
 * process with no JS diagnostic — K2/C12). Hard-clamped to `hardCapBytes` as a
 * backstop for uncontained hosts. When the environment limit can't be probed
 * (non-Linux, unreadable cgroup), the ceiling falls back to `hardCapBytes`;
 * that fallback is a RECORDED fact (the caller can observe it via the return +
 * the `degradedToFallback` flag) so K-1 attribution can distinguish "derived
 * from cgroup" from "fell back to hard cap".
 *
 * The ceiling is a derived INTENT value — the EFFECTIVE limit is the measured
 * `heapFacts().limitBytes` after the process re-execs under the injected flag.
 * K-1 records both; mismatch between the two is itself a signal.
 */
export interface DerivedCeiling {
	ceilingBytes: number;
	/** True when no cgroup limit was probeable and the hard cap was used. */
	degradedToFallback: boolean;
}

export function derivedCeiling(
	hostBudgetBytes: number,
	hardCapBytes: number
): DerivedCeiling {
	const cgroup = cgroupMemoryAvailable();
	// Take the smaller of the host budget and the cgroup headroom (when
	// contained). The host budget (memoryBudgetBytes) is already the min of
	// os.freemem and cgroup-available, but pass it explicitly so callers can
	// inject a test value independent of the live host read.
	const environmental = cgroup !== null ? Math.min(hostBudgetBytes, cgroup) : hostBudgetBytes;
	// Leave a safety margin: never derive a ceiling above 80% of the
	// environmental bound, so non-heap process memory (stacks, native, the
	// resolver pool's own RSS) doesn't get squeezed into the OS's last byte.
	const safe = Math.floor(environmental * 0.8);
	if (cgroup !== null) {
		// cgroup-bounded: clamp to the hard cap as an upper backstop only.
		return { ceilingBytes: Math.min(safe, hardCapBytes), degradedToFallback: false };
	}
	// Uncontained (no cgroup): fall back to the hard cap. Recorded as a
	// fallback so K-1 can attribute "no cgroup limit probed."
	return { ceilingBytes: hardCapBytes, degradedToFallback: true };
}

// Re-export the cgroup term so ceiling derivation draws host capacity through
// this module rather than reaching past it. This is the sole permitted
// out-edge of this module's dependency on `memory-budget.ts`.
export { cgroupMemoryAvailable, memoryBudgetBytes };

/**
 * Convenience: the derived ceiling in MiB (the unit `--max-old-space-size`
 * takes), or null when non-positive. Used by K-1 attribution to record the
 * DERIVED INTENT alongside the MEASURED effective limit.
 */
export function derivedCeilingMib(
	hostBudgetBytes: number = memoryBudgetBytes(),
	hardCapBytes: number = 8 * 1024 * 1024 * 1024
): number | null {
	const d = derivedCeiling(hostBudgetBytes, hardCapBytes);
	const mib = Math.floor(d.ceilingBytes / (1024 * 1024));
	return mib > 0 ? mib : null;
}
