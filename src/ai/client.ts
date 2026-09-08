import OpenAI from 'openai';
import { getConfig, requireKey } from '../config/index.js';
import { StepError } from '../lib/errors.js';
import type { PromptImage } from './screenshots.js';
import { describeImage } from './screenshots.js';

/**
 * The single door between this project and the model provider (task 3-03).
 *
 * Everything the agents need is behind `AiClient`, a two-method interface, for
 * one reason: the agents are the part worth testing, and testing them must not
 * cost a network call or an API key. Every agent test injects a fake client and
 * asserts on the prompt it was handed and the reply it made of the answer.
 *
 * Structured output is not optional here. The schema goes to the API, which
 * constrains generation to it, so "the model wrote prose instead of JSON" stops
 * being a failure mode we handle and becomes one we mostly prevent — task 3-04
 * still handles the remainder, because a refusal or a truncated answer can
 * always produce something unparseable.
 */

export interface CompletionRequest {
  /** Role and rules — what the model is, and what it may not do. */
  system: string;
  /** The task and the facts for this one store. */
  user: string;
  images?: readonly PromptImage[];
  /** Names the schema for the API; a-z, digits, `_` and `-` only. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface CompletionResult {
  /** Raw JSON text. Parsing and validation belong to the caller (task 3-04). */
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  model: string;
}

export interface AiClient {
  readonly model: string;
  complete: (request: CompletionRequest) => Promise<CompletionResult>;
}

export interface OpenAiClientOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  projectId?: string | undefined;
  /** Injected by tests; the real one is constructed from the config. */
  client?: OpenAI | undefined;
}

export function createOpenAiClient(options: OpenAiClientOptions = {}): AiClient {
  const config = getConfig().ai;
  const model = options.model ?? config.model;

  // Built lazily: constructing the client must not demand a key from a process
  // that only wanted to read the config (the dashboard imports it too).
  let client = options.client;
  const openai = (): OpenAI => {
    client ??= new OpenAI({
      apiKey: options.apiKey ?? requireKey('ai'),
      ...((options.projectId ?? config.projectId)
        ? { project: options.projectId ?? config.projectId }
        : {}),
    });
    return client;
  };

  return {
    model,
    complete: async (request) => {
      const startedAt = Date.now();
      try {
        const response = await openai().responses.create(
          {
            model,
            instructions: request.system,
            input: [{ role: 'user', content: buildContent(request) }],
            text: {
              format: {
                type: 'json_schema',
                name: request.schemaName,
                schema: request.jsonSchema,
                // The API rejects a schema it cannot enforce rather than
                // silently loosening it, which is the failure we want.
                strict: true,
              },
            },
            ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
          },
          request.signal ? { signal: request.signal } : {},
        );

        return {
          text: response.output_text,
          tokensIn: response.usage?.input_tokens ?? null,
          tokensOut: response.usage?.output_tokens ?? null,
          durationMs: Date.now() - startedAt,
          model: response.model ?? model,
        };
      } catch (error) {
        throw toStepError(error);
      }
    },
  };
}

/**
 * Images are announced before they are shown. Without the caption the model has
 * no way to tell a phone screenshot from a desktop one, and would judge a mobile
 * layout by desktop expectations — the exact mistake the audit exists to avoid.
 */
function buildContent(request: CompletionRequest): OpenAI.Responses.ResponseInputContent[] {
  const content: OpenAI.Responses.ResponseInputContent[] = [
    { type: 'input_text', text: request.user },
  ];
  for (const image of request.images ?? []) {
    content.push({ type: 'input_text', text: `Screenshot — ${describeImage(image)}` });
    content.push({ type: 'input_image', detail: image.detail, image_url: image.dataUrl });
  }
  return content;
}

/**
 * A bad key costs the same retry budget as a rate limit unless the difference is
 * stated. 4xx other than 408/429 is our mistake and will not fix itself.
 */
export function toStepError(error: unknown): StepError {
  if (error instanceof StepError) return error;

  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : NaN;
  const message = error instanceof Error ? error.message : String(error);

  if (
    Number.isFinite(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return new StepError(`OpenAI rejected the request (HTTP ${status}): ${message}`, {
      retryable: false,
      cause: error,
    });
  }
  return new StepError(`OpenAI request failed: ${message}`, { retryable: true, cause: error });
}
