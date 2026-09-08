import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeLock,
  clearLock,
  lockPath,
  MAX_LOCK_AGE_MS,
  readLock,
  writeLock,
} from './pipelineLock.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lock-test-'));
}

const alive = () => true;
const dead = () => false;

test('no lock means nothing is running', () => {
  assert.equal(activeLock(tempDir()), null);
});

test('a lock held by a live process blocks a second run', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1234, startedAt: new Date().toISOString(), label: 'Fetching 10 stores' });

  const held = activeLock(dir, { isAlive: alive });
  assert.equal(held?.pid, 1234);
  assert.equal(held?.label, 'Fetching 10 stores');
});

test('a lock whose process has exited is stale', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1234, startedAt: new Date().toISOString(), label: 'x' });
  assert.equal(
    activeLock(dir, { isAlive: dead }),
    null,
    'a crashed run must not wedge the UI shut forever',
  );
});

test('a lock older than the maximum age is stale even if the pid is alive', () => {
  const dir = tempDir();
  const started = new Date(Date.now() - MAX_LOCK_AGE_MS - 1000).toISOString();
  writeLock(dir, { pid: 1234, startedAt: started, label: 'x' });
  assert.equal(activeLock(dir, { isAlive: alive }), null);
});

test('a lock just under the maximum age still holds', () => {
  const dir = tempDir();
  const started = new Date(Date.now() - MAX_LOCK_AGE_MS + 5000).toISOString();
  writeLock(dir, { pid: 1234, startedAt: started, label: 'x' });
  assert.ok(activeLock(dir, { isAlive: alive }));
});

test('a corrupt lock file is ignored rather than blocking forever', () => {
  const dir = tempDir();
  writeFileSync(lockPath(dir), '{ not json', 'utf-8');
  assert.equal(readLock(dir), null);
  assert.equal(activeLock(dir, { isAlive: alive }), null);
});

test('a lock missing required fields is ignored', () => {
  const dir = tempDir();
  writeFileSync(lockPath(dir), JSON.stringify({ label: 'x' }), 'utf-8');
  assert.equal(activeLock(dir, { isAlive: alive }), null);
});

test('a lock with an unparseable timestamp is ignored', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1, startedAt: 'not-a-date', label: 'x' });
  assert.equal(activeLock(dir, { isAlive: alive }), null);
});

test('clearLock removes the file and is safe when there is none', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1, startedAt: new Date().toISOString(), label: 'x' });
  clearLock(dir);
  assert.equal(readLock(dir), null);
  assert.doesNotThrow(() => clearLock(dir));
});

test('the real liveness check recognises this process and a free pid', () => {
  const dir = tempDir();
  writeLock(dir, { pid: process.pid, startedAt: new Date().toISOString(), label: 'self' });
  assert.ok(activeLock(dir), 'the current process is alive');

  // 2^22 is above the default pid_max on macOS and Linux, so it cannot exist.
  writeLock(dir, { pid: 4194304, startedAt: new Date().toISOString(), label: 'ghost' });
  assert.equal(activeLock(dir), null);
});
