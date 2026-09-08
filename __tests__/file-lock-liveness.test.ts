/**
 * Phase 4.3 (M-4): liveness-first writer exclusion.
 *
 * The lock's stale-timeout (2 min) is shorter than a single cFnPtr synthesis
 * pass (354s measured). The old age-AND-liveness check short-circuited
 * `isProcessAlive` once the lock was over-age, so a second writer could steal
 * a live synthesis's lock. The fix: liveness is the PRIMARY check — an alive
 * PID rejects regardless of age; a dead PID reclaims regardless of age.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock } from '../src/utils';

describe('Phase 4.3 — file lock liveness-first exclusion', () => {
	let dir: string;
	let lockPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-'));
		lockPath = path.join(dir, 'codegraph.lock');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Write a lock file with the given PID and an mtime `ageMs` in the past. */
	function plantLock(pid: string | number, ageMs: number): void {
		fs.writeFileSync(lockPath, String(pid), { flag: 'wx' });
		const past = new Date(Date.now() - ageMs);
		fs.utimesSync(lockPath, past, past);
	}

	it('lock age > STALE_TIMEOUT_MS but PID alive ⇒ second writer is REJECTED (the M-4 fix)', () => {
		// A 354s-old lock held by THIS process (alive). The old code would have
		// treated it as stale (age > 2min) and stolen it; liveness-first rejects.
		plantLock(process.pid, 354_000);
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).toThrow(/locked by another process \(PID \d+\)/);
	});

	it('PID dead ⇒ lock is reclaimable regardless of age (even if over-age)', () => {
		// A dead PID (a process that doesn't exist). Over-age too. Reclaim.
		plantLock(999_999, 10 * 60_000); // 10 min old, dead PID
		expect(() => fs.readFileSync(lockPath, 'utf8')).not.toThrow(); // lock exists
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).not.toThrow();
		expect(lock['held']).toBe(true);
	});

	it('PID dead and lock young ⇒ also reclaimable (liveness is primary, age irrelevant)', () => {
		plantLock(999_999, 5_000); // 5s old, dead PID
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).not.toThrow();
	});

	it('PID alive and lock young ⇒ rejected (existing behavior preserved)', () => {
		plantLock(process.pid, 1_000); // 1s old, alive
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).toThrow(/locked by another process/);
	});

	it('unparsable PID and lock young ⇒ rejected (do not steal a young unidentifiable lock)', () => {
		fs.writeFileSync(lockPath, 'not-a-pid', { flag: 'wx' });
		const past = new Date(Date.now() - 1_000);
		fs.utimesSync(lockPath, past, past);
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).toThrow(/unidentifiable process/);
	});

	it('unparsable PID and lock over-age ⇒ reclaimable (age fallback for unidentifiable)', () => {
		fs.writeFileSync(lockPath, 'not-a-pid', { flag: 'wx' });
		const past = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(lockPath, past, past);
		const lock = new FileLock(lockPath);
		expect(() => lock.acquire()).not.toThrow();
	});
});
