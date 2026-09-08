import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCsv,
  csvCell,
  csvRow,
  CSV_COLUMNS,
  exportFileName,
  type ApprovedLetter,
} from './csvExport.js';

function letter(overrides: Partial<ApprovedLetter> = {}): ApprovedLetter {
  return {
    domain: 'sklep.pl',
    contact_name: 'Anna Kowalska',
    contact_role: 'Founder',
    contact_email: 'anna@sklep.pl',
    subject: 'koszyk nie działa',
    body: 'Anna,\n\nprzycisk nie działa.',
    category: 'TECHNICAL_PROBLEMS',
    lead_score: 90,
    word_count: 100,
    version: 2,
    created_at: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

test('every cell is quoted, whatever is in it', () => {
  // Deciding per value when to quote is how a CSV writer gets its first bug.
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test('quotes inside a value are doubled, not dropped', () => {
  assert.equal(csvCell('powiedział "nie"'), '"powiedział ""nie"""');
});

test('commas and newlines survive, because the body always has them', () => {
  const cell = csvCell('Anna,\n\nprzycisk nie działa.');
  assert.equal(cell, '"Anna,\n\nprzycisk nie działa."');
});

test('a cell that would run as a formula is defused', () => {
  // Every string here came off somebody else's website, and the file is opened
  // on the machine of whoever exports it.
  for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd']) {
    assert.equal(csvCell(dangerous), `"'${dangerous.replace(/"/g, '""')}"`, dangerous);
  }
  // A minus that is part of a real value is still escaped: being unable to
  // subtract in a spreadsheet is cheaper than executing a scraped string.
  assert.equal(csvCell('-5'), `"'-5"`);
});

test('a value that merely contains a formula character is left alone', () => {
  assert.equal(csvCell('a=b'), '"a=b"');
  assert.equal(csvCell('anna@sklep.pl'), '"anna@sklep.pl"');
});

test('the header names every column, in order', () => {
  const csv = buildCsv([]);
  assert.equal(csv, `${csvRow(CSV_COLUMNS)}\r\n`);
  assert.match(csv, /^"domain","contact_name"/);
});

test('a letter becomes one row with its contact and its facts', () => {
  const rows = buildCsv([letter()]).trimEnd().split('\r\n');

  assert.equal(rows.length, 2);
  assert.match(rows[1]!, /^"sklep\.pl","Anna Kowalska","Founder","anna@sklep\.pl"/);
  assert.match(rows[1]!, /"TECHNICAL_PROBLEMS","90","100","2"/);
});

test('a shop with no contact still exports, with empty cells', () => {
  const row = buildCsv([
    letter({ contact_name: null, contact_role: null, contact_email: null }),
  ])
    .trimEnd()
    .split('\r\n')[1]!;

  assert.match(row, /^"sklep\.pl","","",""/);
});

test('lines end the way every spreadsheet expects', () => {
  const csv = buildCsv([letter(), letter({ domain: 'inny.pl' })]);
  assert.equal(csv.split('\r\n').length, 4, 'header, two rows, trailing break');
  assert.ok(csv.endsWith('\r\n'));
});

test('the file name sorts and says what it holds', () => {
  assert.equal(
    exportFileName(new Date('2026-09-08T22:15:00Z')),
    'storelead-approved-2026-09-08.csv',
  );
});
