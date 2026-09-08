import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupStamp, listBackups } from './backup.js';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'storelead-backup-'));
}

test('the stamp sorts as a string and is legal as a directory name', () => {
  assert.equal(backupStamp(new Date('2026-09-08T13:51:04.123Z')), '20260908T135104');
  assert.ok(
    backupStamp(new Date('2026-01-02T03:04:05Z')) < backupStamp(new Date('2026-01-02T03:04:06Z')),
  );
  assert.doesNotMatch(backupStamp(new Date()), /[:.\\/]/);
});

test('the stamp is the shape the pruner looks for', () => {
  // Get this wrong and pruning silently keeps everything: it finds no
  // directories to count, and never removes one.
  const dir = tempDir();
  try {
    const stamp = backupStamp(new Date('2026-09-08T13:51:04Z'));
    mkdirSync(path.join(dir, stamp));
    assert.deepEqual(listBackups(dir), [stamp]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only timestamped directories count as backups', () => {
  const dir = tempDir();
  try {
    for (const name of ['20260908T135104', '20260101T000000']) mkdirSync(path.join(dir, name));
    mkdirSync(path.join(dir, 'notes'));
    mkdirSync(path.join(dir, '2026-09-08T135104'));
    writeFileSync(path.join(dir, '20260908T999999'), 'a file, not a directory');

    assert.deepEqual(listBackups(dir), ['20260101T000000', '20260908T135104']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that does not exist yet has no backups in it', () => {
  const dir = path.join(tempDir(), 'never-created');
  assert.equal(existsSync(dir), false);
  assert.deepEqual(listBackups(dir), []);
});
