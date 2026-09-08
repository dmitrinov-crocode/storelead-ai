import { WORD_RANGE, firstName } from './prompt.js';
import type { Fact } from './facts.js';

/**
 * The checks that run before the QC agent (task 5-05).
 *
 * They exist for two reasons. The obvious one is money: an AI review costs a
 * call, and a letter that is 300 words long or opens with "I hope this finds you
 * well" can be refused for free. The better one is that these four things are
 * not judgement calls. A word count is a number, a name is present or it is not,
 * a fact is on the sheet or it is invented. Handing a model something arithmetic
 * to decide invites it to be diplomatic about it, and 5-04 has enough genuinely
 * subjective work — tone, pushiness, whether the letter earns a reply.
 *
 * Every failure names what is wrong in a sentence the regeneration loop of 5-06
 * can hand straight back to the writer.
 */

export type CheckName = 'length' | 'greeting' | 'grounding' | 'phrases' | 'subject';

export interface CheckFailure {
  check: CheckName;
  /** Given verbatim to the model on a retry, so it must be actionable. */
  message: string;
}

export interface CheckResult {
  passed: boolean;
  failures: CheckFailure[];
  wordCount: number;
}

/**
 * Openings and filler that mark a letter as bulk outreach.
 *
 * Every entry earns its place by being a phrase a merchant has read a hundred
 * times, in Polish as well as English — these shops are sold to constantly, and
 * the first line is where they decide whether this is another one.
 */
export const BANNED_PHRASES: readonly string[] = [
  // English openings and filler
  'i hope this email finds you well',
  'i hope this finds you well',
  'hope you are doing well',
  'i wanted to reach out',
  'i am reaching out',
  'quick question',
  'game changer',
  'game-changer',
  'leverage',
  'synergy',
  'cutting edge',
  'cutting-edge',
  'best in class',
  'world class',
  'take your business to the next level',
  'unlock the potential',
  'boost your sales',
  'skyrocket',
  'no obligation',
  'free consultation',
  'quick call',
  'jump on a call',
  'book a call',
  'schedule a call',
  'circle back',
  'touch base',
  // Polish equivalents
  'mam nadzieję, że ten e-mail zastanie',
  'mam nadzieję, że u państwa wszystko dobrze',
  'piszę do państwa z propozycją',
  'chciałbym zaproponować',
  'chciałabym zaproponować',
  'niezobowiązująco',
  'bezpłatna konsultacja',
  'krótka rozmowa',
  'umówić się na rozmowę',
  'zwiększyć sprzedaż',
  'wynieść na wyższy poziom',
];

/** Words, as a human counts them: whitespace-separated, punctuation ignored. */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export interface RunChecksInput {
  subject: string;
  body: string;
  /** Facts that survived the grounding guard — invented ids are already gone. */
  factsUsed: readonly Fact[];
  /** The name the letter was told to open with, when there was one. */
  contactName?: string | null;
}

const SUBJECT_MAX = 60;

export function runProgrammaticChecks(input: RunChecksInput): CheckResult {
  const failures: CheckFailure[] = [];
  const body = input.body.trim();
  const wordCount = countWords(body);

  if (wordCount < WORD_RANGE.min || wordCount > WORD_RANGE.max) {
    failures.push({
      check: 'length',
      message:
        `The email is ${wordCount} words. It must be between ${WORD_RANGE.min} and ` +
        `${WORD_RANGE.max}. ${wordCount > WORD_RANGE.max ? 'Cut it down' : 'It is too thin'}.`,
    });
  }

  // The name is checked only when we had one to use. A letter to a shop that
  // named nobody is fine; a letter that was given "Anna" and greets nobody is
  // the personalisation the whole epic exists for, silently missing.
  const greeting = firstName(input.contactName);
  if (greeting !== null && !containsWord(body, greeting)) {
    failures.push({
      check: 'greeting',
      message: `The contact is called ${greeting} and the email never uses their name. Open with it.`,
    });
  }

  if (input.factsUsed.length === 0) {
    failures.push({
      check: 'grounding',
      message:
        'The email cites no fact from the sheet. Name something specific that was actually found ' +
        'on the storefront, using the ids you were given.',
    });
  }

  const haystack = normalise(`${input.subject}\n${body}`);
  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(normalise(phrase))) {
      failures.push({
        check: 'phrases',
        message: `Remove the phrase "${phrase}" — it marks the email as bulk outreach.`,
      });
      break;
    }
  }

  const subject = input.subject.trim();
  if (subject === '') {
    failures.push({ check: 'subject', message: 'The subject line is empty.' });
  } else if (subject.length > SUBJECT_MAX) {
    failures.push({
      check: 'subject',
      message: `The subject is ${subject.length} characters; keep it under ${SUBJECT_MAX}.`,
    });
  }

  return { passed: failures.length === 0, failures, wordCount };
}

/** Lowercase, diacritics folded, whitespace collapsed — for phrase matching. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether the body uses a name as a word.
 *
 * Substring matching would pass "Ana" against "analytics"; Polish also inflects
 * the vocative, so `Anno,` and `Aniu` are the same greeting as `Anna`. The
 * comparison therefore matches the stem rather than demanding the exact form.
 */
function containsWord(body: string, name: string): boolean {
  const stem = normalise(name).slice(0, Math.max(3, normalise(name).length - 1));
  if (stem === '') return false;
  return new RegExp(`(?<![\\p{L}])${escapeRegExp(stem)}[\\p{L}]{0,3}(?![\\p{L}])`, 'u').test(
    normalise(body),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
