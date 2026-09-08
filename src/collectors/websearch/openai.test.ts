import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { createOpenAiWebSearch } from './openai.js';

interface FakeCall {
  model: string;
  tools: unknown[];
  include: unknown;
  input: unknown;
}

/**
 * A stand-in for the Responses API that replays one canned response and records
 * the request. Everything the adapter reads is set here explicitly, so a test
 * asserting on a dropped hit is asserting on the filter, not on the SDK.
 */
function fakeOpenAi(response: Record<string, unknown>): {
  client: OpenAI;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        calls.push({
          model: params['model'] as string,
          tools: params['tools'] as unknown[],
          include: params['include'],
          input: params['input'],
        });
        return response;
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

function searchCall(urls: string[]): Record<string, unknown> {
  return {
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: {
      type: 'search',
      queries: ['"Sklep Anna" (founder OR CEO) linkedin.com/in'],
      sources: urls.map((url) => ({ type: 'url', url })),
    },
  };
}

function message(annotations: { url: string; title: string }[]): Record<string, unknown> {
  return {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: '',
        annotations: annotations.map((a) => ({
          type: 'url_citation',
          url: a.url,
          title: a.title,
          start_index: 0,
          end_index: 1,
        })),
      },
    ],
  };
}

function response(parts: { output: unknown[]; results: unknown[] }): Record<string, unknown> {
  return {
    model: 'test-model',
    output: parts.output,
    output_text: JSON.stringify({ results: parts.results }),
    usage: { input_tokens: 900, output_tokens: 120 },
  };
}

test('a hit the search never reached is dropped, however plausible it looks', async () => {
  const { client } = fakeOpenAi(
    response({
      output: [searchCall(['https://pl.linkedin.com/in/anna-kowalska'])],
      results: [
        { url: 'https://pl.linkedin.com/in/anna-kowalska', title: 'Anna Kowalska', snippet: 'a' },
        // The shape of a real profile URL, and nothing behind it.
        { url: 'https://www.linkedin.com/in/jan-nowak-sklep', title: 'Jan Nowak', snippet: 'b' },
      ],
    }),
  );

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q' });

  assert.deepEqual(
    result.hits.map((hit) => hit.url),
    ['https://pl.linkedin.com/in/anna-kowalska'],
  );
  assert.equal(result.dropped, 1);
});

test('a citation grounds a hit the sources list did not carry', async () => {
  const { client } = fakeOpenAi(
    response({
      output: [
        searchCall([]),
        message([{ url: 'https://www.linkedin.com/in/anna-kowalska', title: 'from the page' }]),
      ],
      results: [
        { url: 'https://www.linkedin.com/in/anna-kowalska', title: 'retyped', snippet: 's' },
      ],
    }),
  );

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q' });

  assert.equal(result.hits.length, 1);
  // The citation title came off the web page; the model's was retyped from it.
  assert.equal(result.hits[0]?.title, 'from the page');
  assert.equal(result.hits[0]?.snippet, 's');
});

test('a URL spelled differently by the search and by the model is one hit', async () => {
  const { client } = fakeOpenAi(
    response({
      output: [searchCall(['https://www.linkedin.com/in/anna-kowalska/'])],
      results: [
        {
          url: 'https://pl.linkedin.com/in/anna-kowalska?originalSubdomain=pl',
          title: null,
          snippet: null,
        },
      ],
    }),
  );

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q' });
  // Host and query differ, the page does not — and the sources list is what
  // proves it was visited, so this must not be dropped.
  assert.equal(result.hits.length, 1);
  assert.equal(result.dropped, 0);
});

test('duplicate results collapse and maxResults truncates', async () => {
  const urls = [
    'https://www.linkedin.com/in/a-one',
    'https://www.linkedin.com/in/b-two',
    'https://www.linkedin.com/in/c-three',
  ];
  const { client } = fakeOpenAi(
    response({
      output: [searchCall(urls)],
      results: [
        { url: urls[0], title: 'A', snippet: null },
        { url: `${urls[0]}/`, title: 'A again', snippet: null },
        { url: urls[1], title: 'B', snippet: null },
        { url: urls[2], title: 'C', snippet: null },
      ],
    }),
  );

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q', maxResults: 2 });

  assert.deepEqual(
    result.hits.map((hit) => hit.title),
    ['A', 'B'],
  );
});

test('the domain restriction is sent as a filter, not folded into the query', async () => {
  const { client, calls } = fakeOpenAi(response({ output: [searchCall([])], results: [] }));

  await createOpenAiWebSearch({ client }).search({
    query: '"Sklep Anna" founder',
    allowedDomains: ['linkedin.com'],
    country: 'pl',
  });

  const tool = calls[0]?.tools[0] as Record<string, unknown>;
  assert.equal(tool['type'], 'web_search');
  assert.deepEqual(tool['filters'], { allowed_domains: ['linkedin.com'] });
  assert.deepEqual(tool['user_location'], { type: 'approximate', country: 'PL' });
  // Without this the response says only that it searched, never what it reached.
  assert.deepEqual(calls[0]?.include, ['web_search_call.action.sources']);
});

test('an unreadable answer is an empty result, not a thrown step', async () => {
  const { client } = fakeOpenAi({
    model: 'test-model',
    output: [searchCall(['https://www.linkedin.com/in/anna'])],
    output_text: 'I could not find anything.',
    usage: null,
  });

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q' });

  assert.deepEqual(result.hits, []);
  assert.equal(result.dropped, 0);
});

test('usage reports the searches the call is billed for', async () => {
  const { client } = fakeOpenAi(
    response({
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', queries: ['one', 'two'], sources: [] },
        },
      ],
      results: [],
    }),
  );

  const result = await createOpenAiWebSearch({ client }).search({ query: 'q' });

  assert.equal(result.usage?.searches, 2);
  assert.equal(result.usage?.tokensIn, 900);
  assert.equal(result.usage?.model, 'test-model');
});
