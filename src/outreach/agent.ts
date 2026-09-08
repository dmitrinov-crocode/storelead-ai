import { z } from 'zod';
import type { AiClient } from '../ai/client.js';
import { CONTEXT_VERSION, type StoreContext } from '../ai/context.js';
import { AiOutputError, promptHash, type StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';
import type { LeadCategory } from '../ai/agents/leadClassifier.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { applyFactGuard, buildFactSheet, type Fact } from './facts.js';
import { runProgrammaticChecks, countWords, type CheckFailure } from './checks.js';
import {
  buildOutreachPrompt,
  languageFor,
  OUTREACH_JSON_SCHEMA,
  OUTREACH_PROMPT_VERSION,
  OUTREACH_SYSTEM_PROMPT,
} from './prompt.js';

/**
 * Agent 4 — Outreach (task 5-03), with the regeneration loop of 5-06.
 *
 * The shape follows the other agents: a schema the API enforces, a guard in code
 * over what comes back, and a bounded retry that hands the model the specific
 * reason its last attempt was refused rather than asking it to try again.
 *
 * What is different here is the order of the checks. The grounding guard runs
 * first and silently — a cited id that is not on the sheet is dropped, not
 * retried on, because mislabelling a source is not the same mistake as making
 * one up and the letter may be fine. Then the programmatic checks of 5-05 run,
 * and those do drive the retry, with their own failure messages going back into
 * the prompt verbatim.
 *
 * A draft that never passes comes back anyway, marked failed and carrying its
 * reasons. Losing it would throw away the evidence the calibration of 5-09 needs
 * and leave a human with nothing to look at.
 */

export const outreachOutputSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  factsUsed: z.array(z.string()),
});

export type OutreachOutput = z.infer<typeof outreachOutputSchema>;

export interface GenerateEmailOptions {
  client: AiClient;
  context: StoreContext;
  category: LeadCategory;
  categoryReason?: string | null;
  /** The analyst's reading; its issues are the best facts a letter has. */
  analysis?: StoreAnalystOutput | undefined;
  contactName?: string | null;
  contactRole?: string | null;
  /** Attempts including the first. Task 5-06 caps the loop here. */
  attempts?: number;
  /**
   * What the previous round got wrong, seeded into the first attempt.
   *
   * The QC loop of 5-06 uses it to hand a rejected draft's verdict back to the
   * writer, so a regeneration knows what to fix instead of rolling the dice.
   */
  feedback?: string | null;
  logger?: Logger;
  signal?: AbortSignal | undefined;
}

export interface EmailDraft {
  subject: string;
  body: string;
  wordCount: number;
  /** Facts that survived the guard, in the order the letter cited them. */
  factsUsed: Fact[];
  /** Ids the model cited that were not on the sheet. */
  inventedFacts: string[];
  /** Empty when the draft passed every programmatic check. */
  failures: CheckFailure[];
  passedChecks: boolean;
  category: LeadCategory;
  promptVersion: string;
  promptHash: string;
  attempts: number;
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    model: string;
  };
  rawText: string;
}

export async function generateEmail(options: GenerateEmailOptions): Promise<EmailDraft> {
  const logger = options.logger ?? silentLogger();
  const attempts = options.attempts ?? 3;
  const facts = buildFactSheet({
    context: options.context,
    ...(options.analysis ? { analysis: options.analysis } : {}),
  });
  const version = `${OUTREACH_PROMPT_VERSION}/ctx${CONTEXT_VERSION}`;

  const promptInput = {
    context: options.context,
    facts,
    category: options.category,
    categoryReason: options.categoryReason ?? null,
    contactName: options.contactName ?? null,
    contactRole: options.contactRole ?? null,
    language: languageFor(options.context.store.country),
  };

  let lastDraft: EmailDraft | null = null;
  let lastError: string | null = null;
  let feedback: string | null = options.feedback ?? null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const user = buildOutreachPrompt({ ...promptInput, feedback });
    const result = await options.client.complete({
      system: OUTREACH_SYSTEM_PROMPT,
      user,
      schemaName: 'outreach_email',
      jsonSchema: OUTREACH_JSON_SCHEMA,
      signal: options.signal,
    });

    let parsed: OutreachOutput;
    try {
      parsed = outreachOutputSchema.parse(JSON.parse(result.text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      feedback = `Your previous answer was not valid JSON for the schema: ${lastError}`;
      logger.warn({ attempt, err: lastError }, 'outreach answer did not fit the schema');
      continue;
    }

    const grounding = applyFactGuard(facts, parsed.factsUsed);
    if (grounding.invented.length > 0) {
      logger.warn(
        { attempt, invented: grounding.invented },
        'the letter cited facts that were not on the sheet',
      );
    }

    const checks = runProgrammaticChecks({
      subject: parsed.subject,
      body: parsed.body,
      factsUsed: grounding.used,
      contactName: options.contactName ?? null,
    });

    const draft: EmailDraft = {
      subject: parsed.subject.trim(),
      body: parsed.body.trim(),
      wordCount: checks.wordCount,
      factsUsed: grounding.used,
      inventedFacts: grounding.invented,
      failures: checks.failures,
      passedChecks: checks.passed,
      category: options.category,
      promptVersion: version,
      promptHash: promptHash(OUTREACH_SYSTEM_PROMPT, user),
      attempts: attempt,
      usage: {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: result.durationMs,
        model: result.model,
      },
      rawText: result.text,
    };

    if (checks.passed) return draft;

    // Keep the best attempt so far: a draft failing one check is worth more to a
    // reviewer than one failing three, and something must come back either way.
    if (lastDraft === null || draft.failures.length < lastDraft.failures.length) lastDraft = draft;

    feedback = checks.failures.map((failure) => failure.message).join(' ');
    logger.info(
      { attempt, failures: checks.failures.map((f) => f.check) },
      'draft refused by the programmatic checks',
    );
  }

  if (lastDraft) return lastDraft;
  throw new AiOutputError(`the outreach agent did not answer in ${attempts} attempts`, {
    attempts,
    lastText: '',
    cause: lastError,
  });
}

export { countWords };
