/**
 * WASM runtime flags — the workaround for the V8 turboshaft WASM Zone OOM
 * (`Fatal process out of memory: Zone`) that crashed `codegraph index` on large
 * polyglot repos under Node >= 22. See issues #293 and #298.
 *
 * The crash was reproduced with the real indexer on the bundled Node 24 runtime;
 * empirically only `--liftoff-only` prevents it (`--no-wasm-tier-up` /
 * `--no-wasm-dynamic-tiering` do not), and the flag must be on node's command
 * line — `setFlagsFromString`, worker `execArgv`, and `NODE_OPTIONS` all fail.
 * These tests pin that contract so it can't silently regress.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WASM_RUNTIME_FLAGS,
  NODE_RUNTIME_FLAGS,
  nodeRuntimeFlagsFor,
  processHasWasmRuntimeFlags,
  buildRelaunchArgv,
  derivedHeapCeilingMib,
  heapCeilingFlag,
} from '../src/extraction/wasm-runtime-flags';

describe('WASM_RUNTIME_FLAGS', () => {
  it('pins --liftoff-only (the only flag shown to stop the turboshaft Zone OOM)', () => {
    // On Node 24, --no-wasm-tier-up and --no-wasm-dynamic-tiering both still
    // crash; only --liftoff-only forces grammars onto the Liftoff baseline and
    // off the optimizing tier. Pin it so it can't be swapped for an ineffective
    // flag.
    expect(WASM_RUNTIME_FLAGS).toContain('--liftoff-only');
  });

  it('every flag is a real, accepted flag on the running Node/V8 runtime', () => {
    // node rejects unknown CLI flags at startup, so a renamed/removed flag would
    // break the bundled launcher and make the relaunch guard a silent no-op.
    // Prove each flag actually launches node here.
    const res = spawnSync(
      process.execPath,
      [...WASM_RUNTIME_FLAGS, '-e', 'process.exit(0)'],
      { encoding: 'utf8' }
    );
    expect(res.status, `node rejected ${WASM_RUNTIME_FLAGS.join(' ')}:\n${res.stderr}`).toBe(0);
  });
});

describe('NODE_RUNTIME_FLAGS', () => {
  it('suppresses the node:sqlite ExperimentalWarning on this runtime', () => {
    // The warning is emitted once per THREAD (main + every parse worker), so
    // during indexing it repeatedly interleaves with the progress UI. Prove
    // the flag both launches node and actually silences the warning.
    expect(NODE_RUNTIME_FLAGS).toContain('--disable-warning=ExperimentalWarning');
    const res = spawnSync(
      process.execPath,
      [...NODE_RUNTIME_FLAGS, '-e', "require('node:sqlite'); process.exit(0)"],
      { encoding: 'utf8' }
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toMatch(/ExperimentalWarning/);
  });

  it('is empty on nodes too old for --disable-warning (fatal "bad option" there)', () => {
    expect(nodeRuntimeFlagsFor('20.10.0')).toEqual([]);
    expect(nodeRuntimeFlagsFor('21.2.0')).toEqual([]);
    expect(nodeRuntimeFlagsFor('20.11.0')).toContain('--disable-warning=ExperimentalWarning');
    expect(nodeRuntimeFlagsFor('21.3.0')).toContain('--disable-warning=ExperimentalWarning');
    expect(nodeRuntimeFlagsFor('22.5.0')).toContain('--disable-warning=ExperimentalWarning');
  });

  it('is NOT required by the re-exec gate (old-launcher compat)', () => {
    // An installed bundle launcher that passes only the WASM flags must not
    // trigger a pointless re-exec over a cosmetic warning flag.
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
  });
});

describe('processHasWasmRuntimeFlags', () => {
  it('is true only when every required flag is present', () => {
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
    expect(processHasWasmRuntimeFlags(['--liftoff-only', '--enable-source-maps'])).toBe(true);
  });

  it('is false when the flags are absent', () => {
    expect(processHasWasmRuntimeFlags([])).toBe(false);
    expect(processHasWasmRuntimeFlags(['--max-old-space-size=4096'])).toBe(false);
  });
});

describe('buildRelaunchArgv', () => {
  it('places our flags first (incl. derived ceiling), then the script and its args', () => {
    const ceiling = heapCeilingFlag();
    const expected = [
      ...NODE_RUNTIME_FLAGS,
      '--liftoff-only',
      ...(ceiling ? [ceiling] : []),
      '/x/codegraph.js',
      'index',
      '/repo',
    ];
    expect(buildRelaunchArgv('/x/codegraph.js', ['index', '/repo'], [])).toEqual(expected);
  });

  it('preserves other existing node flags without duplicating ours, and replaces any prior ceiling', () => {
    const ceiling = heapCeilingFlag();
    expect(
      buildRelaunchArgv('/x/codegraph.js', ['status'], [
        '--liftoff-only',
        ...NODE_RUNTIME_FLAGS,
        '--enable-source-maps',
        '--max-old-space-size=2048', // a prior/stale ceiling — must be replaced, not duplicated
      ])
    ).toEqual([
      ...NODE_RUNTIME_FLAGS,
      '--liftoff-only',
      ...(ceiling ? [ceiling] : []),
      '--enable-source-maps',
      '/x/codegraph.js',
      'status',
    ]);
  });

  it('produces an argv that actually launches node WITH the flag applied', () => {
    // End-to-end proof of the delivery mechanism without needing the crash:
    // run the constructed argv and confirm the child sees the flag in execArgv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relaunch-'));
    try {
      const harness = path.join(dir, 'harness.cjs');
      fs.writeFileSync(harness, 'process.stdout.write(JSON.stringify(process.execArgv));');
      const res = spawnSync(process.execPath, buildRelaunchArgv(harness, []), { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toContain('--liftoff-only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Phase 4.1 — M-2 derived heap ceiling', () => {
  it('derivedHeapCeilingMib returns a positive MiB value (cgroup-aware, hard-clamped)', () => {
    const mib = derivedHeapCeilingMib();
    expect(mib).not.toBeNull();
    expect(mib!).toBeGreaterThan(0);
    // Hard cap is 8 GiB → 8192 MiB. On an uncontained host the ceiling is the
    // hard cap; in a cgroup it's ≤ the cgroup limit. Either way ≤ 8192.
    expect(mib!).toBeLessThanOrEqual(8192);
  });

  it('heapCeilingFlag returns the --max-old-space-size=N form', () => {
    const flag = heapCeilingFlag();
    expect(flag).not.toBeNull();
    expect(flag).toMatch(/^--max-old-space-size=\d+$/);
  });

  it('the ceiling flag is a real, accepted node CLI flag', () => {
    const flag = heapCeilingFlag();
    expect(flag).not.toBeNull();
    const res = spawnSync(process.execPath, [flag!, '-e', 'process.exit(0)'], { encoding: 'utf8' });
    expect(res.status, `node rejected ${flag}:\n${res.stderr}`).toBe(0);
  });

  it('the re-exec gate does NOT require the ceiling flag (avoids infinite re-exec on a derived value)', () => {
    // The gate stays on --liftoff-only; the ceiling rides along on the re-exec
    // the gate already triggers. Gating on the ceiling (a derived value that
    // varies) would re-exec forever.
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
    expect(processHasWasmRuntimeFlags(['--liftoff-only', '--max-old-space-size=8192'])).toBe(true);
  });

  it('no new Worker site gains resourceLimits (C11 — scan the source)', () => {
    // C11: raising the main isolate's --max-old-space-size covers all workers
    // (they have no resourceLimits). This module must not add resourceLimits
    // to any `new Worker` site. Scan for the property-usage pattern
    // (`resourceLimits:`), which excludes doc-comment mentions.
    const scan = (dir: string): string[] => {
      const hits: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { hits.push(...scan(full)); continue; }
        if (!/\.ts$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        // Match `resourceLimits` as a property key (followed by `:`), not a
        // doc-comment mention (followed by `)` or backtick).
        if (/resourceLimits\s*:/.test(content)) hits.push(path.relative(path.resolve(__dirname, '..'), full).replace(/\\/g, '/'));
      }
      return hits;
    };
    const src = path.resolve(__dirname, '..', 'src');
    const hits = scan(src);
    expect(hits).toEqual([]);
  });
});
