import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../ai/client.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';
import { readAboutPages } from './aboutAgent.js';

function fakeClient(reply: string): AiClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    model: 'test-model',
    complete: async (request): Promise<CompletionResult> => {
      calls.push(request);
      return { text: reply, tokensIn: 800, tokensOut: 90, durationMs: 3, model: 'test-model' };
    },
  };
}

function page(overrides: Partial<ScrapedPage> & { kind?: ContactPageKind } = {}): ScrapedPage {
  return {
    kind: 'about',
    url: 'https://sklep.pl/pages/o-nas',
    status: 200,
    source: 'footer',
    html: '',
    text: 'Firma powstała w 2019 roku, gdy Anna Kowalska rzuciła pracę w korporacji.',
    mailtos: [],
    ...overrides,
  };
}

function reply(people: { name: string; role: string; quote: string }[]): string {
  return JSON.stringify({ people });
}

const QUOTE = 'Firma powstała w 2019 roku, gdy Anna Kowalska rzuciła pracę w korporacji.';

test('a founding story names a person no regex would find', async () => {
  const client = fakeClient(reply([{ name: 'Anna Kowalska', role: 'założycielka', quote: QUOTE }]));
  const reading = await readAboutPages({
    client,
    pages: [page()],
    storeDomain: 'sklep.pl',
  });

  assert.deepEqual(
    reading.people.map((person) => [person.name, person.role, person.source]),
    [['Anna Kowalska', 'Founder', 'ai_about']],
  );
  assert.equal(reading.people[0]?.evidence, QUOTE);
  assert.equal(reading.usage?.tokensIn, 800);
});

test('a person whose sentence is not on the page is dropped', async () => {
  // The whole guard: a model that invents a founder must invent a quote too.
  const client = fakeClient(
    reply([{ name: 'Jan Wymyślony', role: 'CEO', quote: 'Sklep prowadzi Jan Wymyślony.' }]),
  );
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.deepEqual(reading.people, []);
  assert.deepEqual(reading.ungrounded, ['Jan Wymyślony']);
});

test('a real sentence that does not contain the name is not evidence for it', async () => {
  const client = fakeClient(reply([{ name: 'Jan Nowak', role: 'CEO', quote: QUOTE }]));
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.deepEqual(reading.people, []);
  assert.deepEqual(reading.ungrounded, ['Jan Nowak']);
});

test('the quote is matched however the model reflowed it', async () => {
  const client = fakeClient(
    reply([
      {
        name: 'Anna Kowalska',
        role: '',
        quote: '  Firma powstała w 2019 roku,\n  gdy Anna Kowalska rzuciła pracę w korporacji. ',
      },
    ]),
  );
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.equal(reading.people.length, 1);
  assert.equal(reading.people[0]?.role, null, 'no title stated means no title invented');
});

test('legal copy and the shop’s own name are refused as before', async () => {
  const text = 'Polityka Prywatności. Sklep prowadzi Salon Bmw Bawaria od 2019 roku.';
  const client = fakeClient(
    reply([
      { name: 'Polityka Prywatności', role: '', quote: text },
      { name: 'Anna Nova', role: 'właścicielka', quote: text },
    ]),
  );
  const reading = await readAboutPages({
    client,
    pages: [page({ text })],
    storeDomain: 'annanova.pl',
  });

  assert.deepEqual(reading.people, []);
  assert.deepEqual(reading.rejected.sort(), ['Anna Nova', 'Polityka Prywatności']);
});

test('an empty answer is the common and correct one', async () => {
  const client = fakeClient(reply([]));
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.deepEqual(reading.people, []);
  assert.deepEqual(reading.ungrounded, []);
});

test('an unreadable answer is nobody, not a failure', async () => {
  // The heuristics already ran and the web search still can.
  const client = fakeClient('the page mentions Anna');
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.deepEqual(reading.people, []);
  assert.equal(reading.usage, null);
});

test('the same person named twice is one person', async () => {
  const client = fakeClient(
    reply([
      { name: 'Anna Kowalska', role: 'założycielka', quote: QUOTE },
      { name: 'Anna Kowalska', role: 'CEO', quote: QUOTE },
    ]),
  );
  const reading = await readAboutPages({ client, pages: [page()], storeDomain: 'sklep.pl' });

  assert.equal(reading.people.length, 1);
  assert.equal(reading.people[0]?.role, 'Founder');
});

test('only about and contact pages are read', async () => {
  const client = fakeClient(reply([]));
  await readAboutPages({
    client,
    pages: [
      page({ kind: 'privacy', url: 'https://sklep.pl/polityka' }),
      page({ kind: 'contact', url: 'https://sklep.pl/kontakt', text: 'Zadzwoń do nas.' }),
    ],
    storeDomain: 'sklep.pl',
  });

  // Policies name regulators, never merchants.
  const prompt = client.calls[0]!.user;
  assert.match(prompt, /kontakt/);
  assert.doesNotMatch(prompt, /polityka/);
});

test('a shop with no readable page costs no call at all', async () => {
  const client = fakeClient(reply([]));
  const reading = await readAboutPages({
    client,
    pages: [page({ kind: 'privacy' }), page({ text: '   ' })],
    storeDomain: 'sklep.pl',
  });

  assert.deepEqual(client.calls, []);
  assert.deepEqual(reading.people, []);
});

test('the page text handed to the model is capped', async () => {
  const client = fakeClient(reply([]));
  await readAboutPages({
    client,
    pages: [page({ text: 'x'.repeat(50_000) })],
    storeDomain: 'sklep.pl',
    maxChars: 100,
  });

  assert.ok(client.calls[0]!.user.length < 400, 'a long page must not be sent whole');
});
