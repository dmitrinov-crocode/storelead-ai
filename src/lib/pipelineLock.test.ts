import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeLock,
  clearLock,
  lockPath,
  MAX_LOCK_AGE_MS,
  processAlive,
  readLock,
  writeLock,
} from './pipelineLock.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'lock-'));
const alive = () => true;
const dead = () => false;

test('no lock file means nothing is running', () => {
  assert.equal(activeLock(tempDir()), null);
});

test('writeLock creates the directory if it does not exist', () => {
  const dir = path.join(tempDir(), 'nested', 'data');
  writeLock(dir, { pid: 1, startedAt: new Date().toISOString(), label: 'x' });
  assert.ok(existsSync(lockPath(dir)));
});

test('a lock held by a live process blocks a second run', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1234, startedAt: new Date().toISOString(), label: 'Run #7' });
  assert.equal(activeLock(dir, { isAlive: alive })?.label, 'Run #7');
});

test('a lock whose process has exited is stale', () => {
  const dir = tempDir();
  writeLock(dir, { pid: 1234, startedAt: new Date().toISOString(), label: 'x' });
  assert.equal(activeLock(dir, { isAlive: dead }), null, 'a killed run must not wedge the UI');
});

test('a lock past the maximum age is stale even with a live pid', () => {
  const dir = tempDir();
  writeLock(dir, {
    pid: 1234,
    startedAt: new Date(Date.now() - MAX_LOCK_AGE_MS - 1000).toISOString(),
    label: 'x',
  });
  assert.equal(activeLock(dir, { isAlive: alive }), null);
});

test('a corrupt or incomplete lock is ignored rather than blocking forever', () => {
  const dir = tempDir();
  writeFileSync(lockPath(dir), '{ not json', 'utf-8');
  assert.equal(activeLock(dir, { isAlive: alive }), null);

  writeFileSync(lockPath(dir), JSON.stringify({ label: 'x' }), 'utf-8');
  assert.equal(activeLock(dir, { isAlive: alive }), null);

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

test('processAlive recognises this process and rejects an impossible pid', () => {
  assert.equal(processAlive(process.pid), true);
  // Above the default pid_max on macOS and Linux, so it cannot exist.
  assert.equal(processAlive(4194304), false);
});
