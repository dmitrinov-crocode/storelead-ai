/**
 * CSV for the approved letters (task 6-09).
 *
 * Kept free of Next imports so the root test suite can exercise it, and separate
 * from the route that serves it: everything that decides what a cell contains is
 * here, and two of those decisions are not cosmetic.
 *
 * **Formulas.** A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is
 * executed as a formula when the file is opened in Excel or Sheets. Every string
 * in this export came off somebody else's website — shop names, About-page text,
 * addresses — so a crafted one would run on the machine of whoever opens the
 * file. Prefixing an apostrophe is the standard defence and costs nothing to
 * read back.
 *
 * **Encoding.** The letters are Polish. Excel reads a UTF-8 file as the local
 * codepage unless it finds a byte-order mark, which turns every `ł` and `ż` into
 * mojibake in the one place the text has to be correct — it is about to be
 * pasted into a real email. The BOM is three bytes and fixes it.
 */

export const CSV_COLUMNS = [
  'domain',
  'contact_name',
  'contact_role',
  'contact_email',
  'subject',
  'body',
  'category',
  'lead_score',
  'words',
  'version',
  'approved_at',
] as const;

export interface ApprovedLetter {
  domain: string;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  subject: string;
  body: string;
  category: string | null;
  lead_score: number | null;
  word_count: number | null;
  version: number;
  created_at: string;
}

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell: formula-guarded, then quoted.
 *
 * Quoting is unconditional. A letter body contains commas and newlines almost by
 * definition, and deciding per value when to quote is how a CSV writer acquires
 * its first bug.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';

  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvCell).join(',');
}

/** `\r\n` line endings: what every spreadsheet expects, and what RFC 4180 says. */
export function buildCsv(letters: readonly ApprovedLetter[]): string {
  const lines = [csvRow(CSV_COLUMNS)];
  for (const letter of letters) {
    lines.push(
      csvRow([
        letter.domain,
        letter.contact_name,
        letter.contact_role,
        letter.contact_email,
        letter.subject,
        letter.body,
        letter.category,
        letter.lead_score,
        letter.word_count,
        letter.version,
        letter.created_at,
      ]),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** UTF-8 BOM, without which Excel mangles every Polish character. */
export const UTF8_BOM = '﻿';

/** `storelead-approved-2026-09-08.csv` — sortable, and says what it holds. */
export function exportFileName(now: Date = new Date()): string {
  return `storelead-approved-${now.toISOString().slice(0, 10)}.csv`;
}
