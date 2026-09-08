import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSearchHit } from '../collectors/websearch/provider.js';
import { extractSerpCompany, extractSerpPeople, readSerpHit, titleSegments } from './serp.js';

const OPTIONS = { storeDomain: 'sklepanna.pl', brand: 'Sklep Anna', query: 'q' };

function hit(overrides: Partial<WebSearchHit> = {}): WebSearchHit {
  return {
    url: 'https://pl.linkedin.com/in/anna-kowalska',
    title: 'Anna Kowalska - Founder - Sklep Anna | LinkedIn',
    snippet: null,
    ...overrides,
  };
}

test('the shapes a LinkedIn title comes back in', () => {
  assert.deepEqual(titleSegments('Anna Kowalska - Founder - Sklep Anna | LinkedIn'), [
    'Anna Kowalska',
    'Founder',
    'Sklep Anna',
  ]);
  assert.deepEqual(titleSegments('Anna Kowalska – Właścicielka – Sklep Anna | LinkedIn'), [
    'Anna Kowalska',
    'Właścicielka',
    'Sklep Anna',
  ]);
  // A hyphenated surname is never spaced, and must survive the split.
  assert.deepEqual(titleSegments('Jan Nowak-Kowalski | LinkedIn'), ['Jan Nowak-Kowalski']);
});

test('name, role and profile are read off the title', () => {
  const person = readSerpHit(hit(), OPTIONS);

  assert.equal(person?.name, 'Anna Kowalska');
  assert.equal(person?.role, 'Founder');
  assert.equal(person?.roleText, 'Founder');
  // Canonicalised, so the same profile found twice is one contact.
  assert.equal(person?.linkedinUrl, 'https://www.linkedin.com/in/anna-kowalska');
  assert.equal(person?.match, 'title');
});

test('a Polish headline is read the same way', () => {
  const person = readSerpHit(
    hit({ title: 'Anna Kowalska – Współzałożycielka – Sklep Anna | LinkedIn' }),
    OPTIONS,
  );

  // `\b` would match `założyciel` inside `współzałożyciel` and file her as Founder.
  assert.equal(person?.role, 'Co-Founder');
});

test('a profile with nothing tying it to this shop is refused', () => {
  // The single most damaging thing this module could do is hand outreach a
  // different Anna Kowalska, so an untied hit is dropped, not kept at low score.
  const person = readSerpHit(
    hit({ title: 'Anna Kowalska - Founder - Inny Sklep | LinkedIn', snippet: 'Warszawa' }),
    OPTIONS,
  );

  assert.equal(person, null);
});

test('a slug carrying the brand ties a hit whose title states no employer', () => {
  const viaSlug = readSerpHit(
    hit({
      url: 'https://www.linkedin.com/in/anna-sklepanna',
      title: 'Anna Kowalska | LinkedIn',
    }),
    OPTIONS,
  );

  assert.equal(viaSlug?.match, 'slug');
});

test('a stated employer that is not the shop cannot be overruled by the slug', () => {
  // `Bob Gatta - TechVetta Solutions` was filed under gatta.pl because his
  // surname is in his slug, while his title said plainly where he works.
  assert.equal(
    readSerpHit(
      {
        url: 'https://www.linkedin.com/in/bob-sklepanna',
        title: 'Bob Kowalski - TechVetta Solutions | LinkedIn',
        snippet: null,
      },
      OPTIONS,
    ),
    null,
  );
});

test('the shop posting as itself is not a person', () => {
  // `Gatta Manufaktura – GATTA | Ferax sp. z o.o.` passes every name heuristic
  // and is the shop's own account. A person is not named after the shop.
  assert.equal(
    readSerpHit(
      {
        url: 'https://www.linkedin.com/in/sklepanna-manufaktura',
        title: 'Sklepanna Manufaktura – Sklep Anna | LinkedIn',
        snippet: null,
      },
      OPTIONS,
    ),
    null,
  );
});

test('a snippet role that names somebody else is refused', () => {
  // Agata Kozielska was filed as Founder of Orientana on the strength of
  // "Wasilewska, założycielka marki Orientana" — a sentence about another woman.
  const person = readSerpHit(
    hit({
      title: 'Anna Kowalska – Sklep Anna | LinkedIn',
      snippet: 'Wasilewska, założycielka marki Sklep Anna, oraz Agnieszka Pocztarska.',
    }),
    OPTIONS,
  );

  assert.equal(person?.name, 'Anna Kowalska');
  assert.equal(person?.role, null, 'the role belongs to Wasilewska, not to her');
});

test('a role in the profile’s own fields survives the attribution guard', () => {
  const person = readSerpHit(
    hit({
      title: 'Anna Kowalska – Sklep Anna | LinkedIn',
      snippet: 'Sklep Anna ... ### CEO, Founder ... Beauty',
    }),
    OPTIONS,
  );

  assert.equal(person?.role, 'CEO');
  assert.equal(person?.roleSource, 'snippet');
});

test('a first-person statement is not an attribution to somebody else', () => {
  const person = readSerpHit(
    hit({
      title: 'Anna Kowalska – Sklep Anna | LinkedIn',
      snippet: 'I am the founder and owner of the company.',
    }),
    OPTIONS,
  );

  assert.equal(person?.role, 'Founder');
});

test('a person’s own name in front of the role keeps it', () => {
  const person = readSerpHit(
    hit({
      title: 'Anna Kowalska – Sklep Anna | LinkedIn',
      snippet: 'Kowalska, założycielka marki Sklep Anna.',
    }),
    OPTIONS,
  );

  assert.equal(person?.role, 'Founder');
});

test('LinkedIn’s people directory is not a profile', () => {
  // A search for a short brand returns these readily: the probe got
  // `2300+ "Natu" profiles` back looking exactly like a person.
  assert.equal(
    readSerpHit(
      {
        url: 'https://www.linkedin.com/pub/dir/Anna/Kowalska',
        title: 'Anna Kowalska – Sklep Anna | LinkedIn',
        snippet: null,
      },
      OPTIONS,
    ),
    null,
  );
});

test('the company page is returned separately from the people', () => {
  const company = extractSerpCompany(
    [
      hit({ url: 'https://www.linkedin.com/in/anna-kowalska' }),
      {
        url: 'https://www.linkedin.com/company/sklep-anna',
        title: 'Sklep Anna | LinkedIn',
        snippet: null,
      },
    ],
    OPTIONS,
  );

  assert.equal(company?.url, 'https://www.linkedin.com/company/sklep-anna');
  assert.equal(company?.kind, 'company');
});

test('a company page for a different company is not returned', () => {
  assert.equal(
    extractSerpCompany(
      [
        {
          url: 'https://www.linkedin.com/company/inna-firma',
          title: 'Inna Firma | LinkedIn',
          snippet: null,
        },
      ],
      OPTIONS,
    ),
    null,
  );
});

test('a brand mentioned only in the snippet does not tie', () => {
  // Every person the 2026-09-08 probe produced this way worked somewhere else:
  // a recruiter quoting a `jobs@lamania.eu` posting, someone who had attended a
  // lecture by the founder of Astrography. A brand in a snippet says the feed
  // mentions the shop, not that the person works there.
  assert.equal(
    readSerpHit(
      hit({
        title: 'Sylwia Sas – Onninen | LinkedIn',
        snippet: 'Zapraszam do składania CV: jobs@sklepanna.pl',
      }),
      OPTIONS,
    ),
    null,
  );
});

test('the tie reads the employer, never the name', () => {
  // Otherwise a person whose own name contains the brand ties to it — the probe
  // returned exactly this shape as "Anna Łacwik - Anna Łacwik | LinkedIn".
  assert.equal(
    readSerpHit(
      {
        url: 'https://www.linkedin.com/in/anna-nowak',
        title: 'Anna Sklepanna - Anna Sklepanna | LinkedIn',
        snippet: null,
      },
      OPTIONS,
    ),
    null,
  );
});

test('the live title shape — name and employer, no role — is read', () => {
  // `Łukasz Pamuła – Maxton Design | LinkedIn`, the form the probe actually
  // returned. The shape this module was first written against is the rare one.
  const person = readSerpHit(
    {
      url: 'https://pl.linkedin.com/in/lukasz-pamula',
      title: 'Łukasz Pamuła – Maxton Design | LinkedIn',
      snippet: 'Maxton Design',
    },
    { storeDomain: 'maxtondesign.com', brand: 'Maxton Design', query: 'q' },
  );

  assert.equal(person?.name, 'Łukasz Pamuła');
  assert.equal(person?.match, 'title');
  assert.equal(person?.role, null);
  assert.equal(person?.roleSource, null);
});

test('a role stated only in the snippet is read', () => {
  // Adam Jesionkiewicz, as the probe returned him: the title carries no title,
  // and `### CEO, Founder` sits in the snippet.
  const person = readSerpHit(
    {
      url: 'https://pl.linkedin.com/in/jesionkiewicz',
      title: 'Adam Jesionkiewicz – Astrography | LinkedIn',
      snippet: 'Astrography ... https://astrography.com ... ### CEO, Founder ... Astronomy',
    },
    { storeDomain: 'astrography.com', brand: 'Astrography', query: 'q' },
  );

  assert.equal(person?.name, 'Adam Jesionkiewicz');
  assert.equal(person?.role, 'CEO');
  assert.equal(person?.roleSource, 'snippet');
});

test('the headline wins over the snippet when both state a role', () => {
  const person = readSerpHit(
    hit({
      title: 'Anna Kowalska - Founder - Sklep Anna | LinkedIn',
      snippet: 'Wcześniej Ecommerce Manager w innej firmie.',
    }),
    OPTIONS,
  );

  // What she says she is beats whatever text the search chose to show.
  assert.equal(person?.role, 'Founder');
  assert.equal(person?.roleSource, 'title');
});

test('a snippet role cannot rescue a hit that is not tied to the shop', () => {
  assert.equal(
    readSerpHit(
      hit({ title: 'Anna Kowalska – Inna Firma | LinkedIn', snippet: 'CEO, Founder' }),
      OPTIONS,
    ),
    null,
  );
});

test('a company page names nobody and is not a person', () => {
  assert.equal(
    readSerpHit(hit({ url: 'https://www.linkedin.com/company/sklep-anna' }), OPTIONS),
    null,
  );
});

test('a non-LinkedIn result is not read for a person', () => {
  assert.equal(
    readSerpHit(
      hit({ url: 'https://sklepanna.pl/o-nas', title: 'Anna Kowalska - Founder' }),
      OPTIONS,
    ),
    null,
  );
});

test('legal and navigation copy in a title cannot become a person', () => {
  // The keyshorts.com failure, arriving through the other door.
  assert.equal(
    readSerpHit(hit({ title: 'Data Protection Office - Prezes - Sklep Anna | LinkedIn' }), OPTIONS),
    null,
  );
  assert.equal(
    readSerpHit(hit({ title: 'Polityka Prywatności - Sklep Anna | LinkedIn' }), OPTIONS),
    null,
  );
});

test('the shop name itself is not the owner', () => {
  assert.equal(
    readSerpHit(
      {
        url: 'https://www.linkedin.com/in/sklep-anna',
        title: 'Sklep Anna | LinkedIn',
        snippet: null,
      },
      { storeDomain: 'sklepanna.pl', brand: 'Sklep Anna', query: 'q' },
    ),
    null,
  );
});

test('a title with no role still yields the person', () => {
  const person = readSerpHit(hit({ title: 'Anna Kowalska - Sklep Anna | LinkedIn' }), OPTIONS);

  assert.equal(person?.name, 'Anna Kowalska');
  assert.equal(person?.role, null);
});

test('a hit with no title is refused — the slug is a URL, not a claimed name', () => {
  assert.equal(readSerpHit(hit({ title: null }), OPTIONS), null);
  assert.equal(readSerpHit(hit({ title: '   ' }), OPTIONS), null);
});

test('people are deduplicated by profile and ranked by seniority', () => {
  const people = extractSerpPeople(
    [
      hit({
        url: 'https://www.linkedin.com/in/jan-nowak',
        title: 'Jan Nowak - Ecommerce Manager - Sklep Anna | LinkedIn',
      }),
      hit({ title: 'Anna Kowalska - CEO - Sklep Anna | LinkedIn' }),
      // The same profile, spelled the way a second query returns it.
      hit({
        url: 'https://www.linkedin.com/in/anna-kowalska?originalSubdomain=pl',
        title: 'Anna Kowalska - CEO - Sklep Anna | LinkedIn',
      }),
    ],
    OPTIONS,
  );

  assert.deepEqual(
    people.map((person) => [person.name, person.role]),
    [
      ['Anna Kowalska', 'CEO'],
      ['Jan Nowak', 'Ecommerce Manager'],
    ],
  );
});

test('the evidence keeps what the search actually showed', () => {
  const person = readSerpHit(hit({ snippet: 'Founder at Sklep Anna. Warszawa.' }), OPTIONS);

  assert.match(person?.evidence ?? '', /Anna Kowalska - Founder/);
  assert.match(person?.evidence ?? '', /Warszawa/);
  assert.equal(person?.query, 'q');
});
