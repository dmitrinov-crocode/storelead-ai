import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import {
  checkResponsive,
  gradeResponsive,
  MIN_FONT_SIZE_PX,
  MIN_TAP_TARGET_PX,
  PATTERN_THRESHOLD,
  readResponsive,
  type ResponsiveFacts,
} from './responsive.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

/** A page that fits, with comfortable controls and readable text. */
const HEALTHY = html(`
<main style="font-size:16px;margin:0;padding:8px">
  <p>Witamy w naszym sklepie z butami.</p>
  <a href="/a" style="display:block;width:200px;height:48px">Sklep</a>
  <button style="width:120px;height:48px">Kup</button>
</main>`);

async function factsFor(body: string, viewport: 'desktop' | 'mobile' = 'mobile') {
  const fixture = await openFixturePage(browser, { '/': { body } }, { viewport });
  try {
    return await readResponsive(fixture.ctx);
  } finally {
    await fixture.close();
  }
}

test('a page that fits the phone reports nothing', async () => {
  const facts = await factsFor(HEALTHY);
  assert.equal(facts.overflowBy, 0);
  assert.equal(facts.smallTapTargetCount, 0);
  assert.deepEqual(facts.overlaps, []);
  assert.equal(facts.smallFontCount, 0);
});

test('the healthy page also passes the graded check', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: HEALTHY } },
    { viewport: 'mobile' },
  );
  try {
    assert.deepEqual(await checkResponsive(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('a too-wide element is found and named', async () => {
  const facts = await factsFor(
    html('<main style="margin:0"><div id="baner" style="width:900px;height:50px"></div></main>'),
  );
  assert.ok(facts.overflowBy > 400, `overflow was ${facts.overflowBy}px`);
  assert.equal(facts.overflowing[0]!.selector, '#baner');
  assert.ok(facts.overflowing[0]!.overflowPx > 400);
});

test('small tap targets are counted and measured', async () => {
  const facts = await factsFor(
    html(`<main style="margin:0">
      <a href="/a" id="maly" style="display:block;width:20px;height:20px">x</a>
      <button style="width:120px;height:48px">Duży</button>
    </main>`),
  );
  assert.equal(facts.smallTapTargetCount, 1);
  assert.equal(facts.smallTapTargets[0]!.selector, '#maly');
  assert.deepEqual([facts.smallTapTargets[0]!.width, facts.smallTapTargets[0]!.height], [20, 20]);
});

test('hidden controls are not measured', async () => {
  const facts = await factsFor(
    html(`<main><button style="display:none;width:5px;height:5px">x</button>
      <input type="hidden" name="id" value="1"></main>`),
  );
  assert.equal(facts.smallTapTargetCount, 0);
});

test('overlapping controls are detected, nesting is not', async () => {
  const overlapping = await factsFor(
    html(`<main style="margin:0;position:relative;height:300px">
      <button id="a" style="position:absolute;left:0;top:0;width:100px;height:100px">A</button>
      <button id="b" style="position:absolute;left:50px;top:50px;width:100px;height:100px">B</button>
    </main>`),
  );
  assert.deepEqual(overlapping.overlaps, [{ a: '#a', b: '#b' }]);

  const nested = await factsFor(
    html('<main><button style="width:200px;height:60px"><a href="/x">Kup</a></button></main>'),
  );
  assert.deepEqual(nested.overlaps, [], 'a link inside a button is layout, not an overlap');
});

test('text below the readable size is counted', async () => {
  const facts = await factsFor(
    html(`<main>
      <p style="font-size:9px">Regulamin sklepu i polityka prywatności</p>
      <p style="font-size:16px">Normalny tekst</p>
    </main>`),
  );
  assert.equal(facts.smallFontCount, 1);
  assert.equal(facts.smallFonts[0]!.fontSize, 9);
  assert.match(facts.smallFonts[0]!.text, /Regulamin/);
});

const ctxMobile = {
  url: 'https://sklep.pl/',
  target: 'homepage',
  viewport: 'mobile',
} as CheckContext;
const ctxDesktop = { ...ctxMobile, viewport: 'desktop' } as CheckContext;

const baseFacts = (overrides: Partial<ResponsiveFacts> = {}): ResponsiveFacts => ({
  viewportWidth: 390,
  documentWidth: 390,
  overflowBy: 0,
  overflowing: [],
  smallTapTargets: [],
  smallTapTargetCount: 0,
  overlaps: [],
  smallFonts: [],
  smallFontCount: 0,
  ...overrides,
});

test('sideways scroll is major on a phone and minor on a desktop', () => {
  const facts = baseFacts({
    overflowBy: 120,
    documentWidth: 510,
    overflowing: [{ selector: '#baner', overflowPx: 120 }],
  });
  assert.equal(gradeResponsive(facts, ctxMobile)[0]!.severity, 'MAJOR');
  assert.equal(gradeResponsive(facts, ctxDesktop)[0]!.severity, 'MINOR');
  assert.match(gradeResponsive(facts, ctxMobile)[0]!.detail!, /120px wider than the 390px screen/);
});

test('a handful of small targets is minor, a pattern of them is major', () => {
  const few = baseFacts({
    smallTapTargetCount: 2,
    smallTapTargets: [{ selector: 'a.x', width: 20, height: 20, text: 'x' }],
  });
  assert.equal(gradeResponsive(few, ctxMobile)[0]!.severity, 'MINOR');
  assert.equal(
    gradeResponsive(few, ctxMobile)[0]!.evidence[0]!.expected,
    `${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px`,
  );

  const many = baseFacts({ smallTapTargetCount: PATTERN_THRESHOLD + 1 });
  assert.equal(gradeResponsive(many, ctxMobile)[0]!.severity, 'MAJOR');
});

test('tap size and font size are not judged on a desktop', () => {
  const facts = baseFacts({ smallTapTargetCount: 9, smallFontCount: 9 });
  assert.deepEqual(gradeResponsive(facts, ctxDesktop), []);
});

test('overlaps name both elements', () => {
  const issues = gradeResponsive(baseFacts({ overlaps: [{ a: '#a', b: '#b' }] }), ctxMobile);
  assert.equal(issues[0]!.title, 'Controls overlap each other');
  assert.equal(issues[0]!.evidence[0]!.selector, '#a ↔ #b');
});

test('small text is only reported once it is a pattern', () => {
  assert.deepEqual(
    gradeResponsive(baseFacts({ smallFontCount: PATTERN_THRESHOLD }), ctxMobile),
    [],
  );

  const issues = gradeResponsive(
    baseFacts({
      smallFontCount: PATTERN_THRESHOLD + 3,
      smallFonts: [{ selector: 'p.legal', fontSize: 9, text: 'Regulamin' }],
    }),
    ctxMobile,
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Text is too small to read on a phone', 'MINOR']],
  );
  assert.equal(issues[0]!.evidence[0]!.expected, `${MIN_FONT_SIZE_PX}px`);
});

// Task 2-24: hidden controls made up most of the false positives in the
// integration run. Each case below is one of the shapes seen on real shops.

test('a screen-reader-only skip link is not a tap target', async () => {
  const srOnly =
    'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%)';
  const facts = await factsFor(
    html(`<main><a href="#content" style="${srOnly}">Skip to content</a>
      <a href="/sklep" style="display:block;width:200px;height:48px">Sklep</a></main>`),
  );
  assert.equal(
    facts.smallTapTargetCount,
    0,
    'a 1x1 clipped link is for assistive tech, not thumbs',
  );
});

test('a closed off-canvas drawer contributes neither tap targets nor overlaps', async () => {
  const facts = await factsFor(
    html(`<main style="margin:0">
      <nav style="position:fixed;left:-320px;top:0;width:320px;height:600px">
        <a href="/a" style="display:block;width:320px;height:20px">Buty</a>
        <a href="/b" style="display:block;width:320px;height:20px">Torby</a>
      </nav>
      <button style="width:120px;height:48px">Kup</button>
    </main>`),
  );
  assert.equal(facts.smallTapTargetCount, 0);
  assert.deepEqual(facts.overlaps, [], 'a drawer parked off-screen is not on top of anything');
});

test('a collapsed menu clipped away by its container is not measured', async () => {
  const facts = await factsFor(
    html(`<main style="margin:0">
      <div style="position:relative;height:0;overflow:hidden">
        <a href="/a" style="position:absolute;left:0;top:0;width:100px;height:30px">Buty</a>
        <a href="/b" style="position:absolute;left:20px;top:10px;width:100px;height:30px">Torby</a>
      </div>
      <button style="width:120px;height:48px">Kup</button>
    </main>`),
  );
  assert.equal(facts.smallTapTargetCount, 0);
  assert.deepEqual(facts.overlaps, []);
});

test('a dropdown that legitimately escapes an overflow:hidden header is still measured', async () => {
  // The mirror image of the case above: the container hides its overflow, but
  // the panel is positioned against the page, so the visitor does see it.
  const facts = await factsFor(
    html(`<main style="margin:0">
      <header style="height:40px;overflow:hidden">
        <a href="/a" id="drop" style="position:absolute;left:0;top:60px;width:100px;height:30px">Buty</a>
      </header>
    </main>`),
  );
  assert.equal(facts.smallTapTargetCount, 1);
  assert.equal(facts.smallTapTargets[0]?.selector, '#drop');
});

test('a control faded out by an ancestor is not measured', async () => {
  const facts = await factsFor(
    html(`<main><div style="opacity:0">
      <button style="width:20px;height:20px">x</button></div></main>`),
  );
  assert.equal(facts.smallTapTargetCount, 0);
});

test('a control that cannot be clicked is not judged as a tap target', async () => {
  const facts = await factsFor(
    html('<main><button style="width:20px;height:20px;pointer-events:none">x</button></main>'),
  );
  assert.equal(facts.smallTapTargetCount, 0);
});

test('a small control the visitor can actually see is still reported', async () => {
  const facts = await factsFor(
    html('<main><button id="tiny" style="width:20px;height:20px">x</button></main>'),
  );
  assert.equal(facts.smallTapTargetCount, 1, 'the fix must not silence the real finding');
  assert.equal(facts.smallTapTargets[0]?.selector, '#tiny');
});

test('screen-reader-only text is not counted as unreadable', async () => {
  const srOnly = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
  const body = Array.from(
    { length: PATTERN_THRESHOLD + 3 },
    (_, i) => `<span style="${srOnly};font-size:8px">ukryty ${i}</span>`,
  ).join('');
  const facts = await factsFor(html(`<main>${body}</main>`));
  assert.equal(facts.smallFontCount, 0);
});
