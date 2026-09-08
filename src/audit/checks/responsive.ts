import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import { cssSelector, type ElementIdentity } from '../pageCollector.js';
import type { CheckContext } from './context.js';

/**
 * Responsiveness checks (task 2-16).
 *
 * Measured in the real emulated device, not guessed from CSS: a page scrolls
 * sideways, a button is too small for a thumb, two controls sit on top of each
 * other, or the text is too small to read. All four are things a visitor feels
 * within seconds and a screenshot alone would not prove.
 */

/** Apple and Google both put the minimum comfortable touch target near this. */
export const MIN_TAP_TARGET_PX = 44;
/** Body text below this is uncomfortable on a phone. */
export const MIN_FONT_SIZE_PX = 12;
/** Sub-pixel layout rounding is not a horizontal scrollbar. */
export const OVERFLOW_TOLERANCE_PX = 4;
/** Below this many small targets or fonts it is a detail, above it is a pattern. */
export const PATTERN_THRESHOLD = 5;

interface RawElement extends ElementIdentity {
  text: string;
}

export interface ResponsiveFacts {
  viewportWidth: number;
  documentWidth: number;
  overflowBy: number;
  overflowing: { selector: string; overflowPx: number }[];
  smallTapTargets: { selector: string; width: number; height: number; text: string }[];
  smallTapTargetCount: number;
  overlaps: { a: string; b: string }[];
  smallFonts: { selector: string; fontSize: number; text: string }[];
  smallFontCount: number;
}

export async function readResponsive(ctx: CheckContext): Promise<ResponsiveFacts> {
  const raw = await ctx.page.evaluate(
    (limits) => {
      // `clientWidth`, not `innerWidth`: a mobile browser widens the layout
      // viewport to fit overflowing content, so `innerWidth` grows with the
      // overflow and would report no overflow at all. It also excludes the
      // desktop scrollbar, which would otherwise look like a 15px overflow.
      const viewportWidth = document.documentElement.clientWidth;
      const documentWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      );

      // Elements worth naming are collected first and identified in one pass at
      // the end: `tsx` compiles a local helper function with an esbuild name
      // shim that does not exist inside the page.
      const notable: Element[] = [];
      const overflowing: { index: number; overflowPx: number }[] = [];
      const smallTargets: { index: number; width: number; height: number }[] = [];
      const smallFonts: { index: number; fontSize: number }[] = [];
      const boxes: { index: number; left: number; top: number; right: number; bottom: number }[] =
        [];
      let smallTapTargetCount = 0;
      let smallFontCount = 0;

      // 1. Horizontal overflow: which elements actually stick out.
      if (documentWidth > viewportWidth + limits.tolerance) {
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          if (overflowing.length >= 5) break;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const overflowPx = Math.round(rect.right - viewportWidth);
          if (overflowPx <= limits.tolerance) continue;
          // Blame the deepest element that sticks out. Its ancestors stretch to
          // the widened layout viewport and would otherwise all be reported.
          let childOverflows = false;
          for (const child of Array.from(el.children)) {
            if (child.getBoundingClientRect().right > viewportWidth + limits.tolerance) {
              childOverflows = true;
              break;
            }
          }
          if (childOverflows) continue;
          notable.push(el);
          overflowing.push({ index: notable.length - 1, overflowPx });
        }
      }

      // A control the visitor cannot see or touch is not a control. Everything
      // below is one flat pass because `tsx` compiles a nested function with an
      // esbuild `__name` shim that does not exist inside the page.
      //
      // Task 2-24 found the cost of skipping this: a 1x1 "Skip to content" link
      // led the evidence for "136 controls under 44px", and the overlap pairs
      // were mobile-menu and mega-menu items that are not on screen at all.
      const interactive = Array.from(
        document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'),
      ).slice(0, limits.maxElements);
      const textual = Array.from(
        document.querySelectorAll('p, li, span, a, td, dd, dt, label, figcaption'),
      ).slice(0, limits.maxElements);

      const state = new Map<Element, { hidden: boolean; untouchable: boolean }>();
      for (const el of interactive.concat(textual)) {
        if (state.has(el)) continue;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        let hidden = false;

        // `checkVisibility` is the browser's own answer, and the only one that
        // sees `content-visibility` and an ancestor's `opacity: 0`.
        if (
          typeof el.checkVisibility === 'function' &&
          !el.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true,
          })
        ) {
          hidden = true;
        }
        if (style.display === 'none') hidden = true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') hidden = true;
        if (Number(style.opacity) === 0) hidden = true;
        if (rect.width === 0 || rect.height === 0) hidden = true;
        if (el instanceof HTMLInputElement && el.type === 'hidden') hidden = true;

        // The screen-reader-only recipe, in both spellings: a 1px box, or a box
        // clipped down to nothing. It is meant for assistive tech, never tapped.
        if (rect.width <= 1 || rect.height <= 1) hidden = true;
        if (style.clipPath.replace(/\s/g, '') === 'inset(50%)') hidden = true;
        if (/^rect\((0px?[,\s]+){3}0px?\)$/.test(style.clip.replace(/\s+/g, ' ').trim())) {
          hidden = true;
        }

        // A closed drawer is parked outside the viewport, not removed from it.
        // Below the fold stays in: that content is real, it is just scrolled to.
        if (rect.right <= 0 || rect.left >= viewportWidth || rect.bottom <= 0) hidden = true;

        // A closed mega menu keeps its items laid out inside a container that
        // hides the overflow, so each item has a plausible rect nobody can see.
        //
        // Which ancestors actually clip is not "all of them": an absolutely
        // positioned box is clipped only from its containing block upwards, and
        // a fixed one only inside a transformed ancestor. Assuming otherwise
        // would hide a dropdown that legitimately escapes an `overflow:hidden`
        // header — trading these false positives for false negatives.
        const fixedPosition = style.position === 'fixed';
        let clipsApply = style.position !== 'absolute' && !fixedPosition;
        let ancestor = el.parentElement;
        while (ancestor && !hidden) {
          const ancestorStyle = window.getComputedStyle(ancestor);
          if (!clipsApply) {
            const anchors =
              ancestorStyle.transform !== 'none' ||
              ancestorStyle.filter !== 'none' ||
              ancestorStyle.perspective !== 'none';
            // Reached the containing block, so this ancestor and everything
            // above it clip again.
            if (anchors || (!fixedPosition && ancestorStyle.position !== 'static')) {
              clipsApply = true;
            }
          }
          if (
            clipsApply &&
            (ancestorStyle.overflowX !== 'visible' || ancestorStyle.overflowY !== 'visible')
          ) {
            const box = ancestor.getBoundingClientRect();
            const shownWidth = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
            const shownHeight = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
            if (shownWidth <= 1 || shownHeight <= 1) hidden = true;
          }
          ancestor = ancestor.parentElement;
        }

        state.set(el, { hidden, untouchable: style.pointerEvents === 'none' });
      }

      // 2. Tap targets and 3. overlapping controls, over the same element set.
      for (const el of interactive) {
        const seen = state.get(el)!;
        // `pointer-events: none` only disqualifies a tap target; unreadable text
        // stays unreadable whether or not it can be clicked.
        if (seen.hidden || seen.untouchable) continue;
        const rect = el.getBoundingClientRect();

        notable.push(el);
        const index = notable.length - 1;

        if (rect.width < limits.minTap || rect.height < limits.minTap) {
          smallTapTargetCount += 1;
          if (smallTargets.length < 5) {
            smallTargets.push({
              index,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }
        boxes.push({
          index,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
      }

      const overlaps: { a: number; b: number }[] = [];
      for (let i = 0; i < boxes.length && overlaps.length < 5; i += 1) {
        for (let j = i + 1; j < boxes.length && overlaps.length < 5; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (width <= 1 || height <= 1) continue;
          const areaA = (a.right - a.left) * (a.bottom - a.top);
          const areaB = (b.right - b.left) * (b.bottom - b.top);
          // Nesting (a link inside a button) is normal layout, not an overlap.
          const overlapArea = width * height;
          if (overlapArea >= Math.min(areaA, areaB) * 0.95) continue;
          if (overlapArea < Math.min(areaA, areaB) * 0.25) continue;
          overlaps.push({ a: a.index, b: b.index });
        }
      }

      // 4. Readability of body text, over the same visibility verdict: the
      // screen-reader-only label a theme hides off-screen is not text anyone
      // is straining to read.
      for (const el of textual) {
        if (state.get(el)!.hidden) continue;
        const text = (el.textContent ?? '').trim();
        if (text.length < 3) continue;
        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize);
        if (!Number.isFinite(fontSize) || fontSize >= limits.minFont) continue;
        smallFontCount += 1;
        if (smallFonts.length < 5) {
          notable.push(el);
          smallFonts.push({ index: notable.length - 1, fontSize });
        }
      }

      const identify: {
        tag: string;
        id: string | null;
        classes: string[];
        nthChild: number;
        text: string;
      }[] = [];
      for (const el of notable) {
        const parent = el.parentElement;
        identify.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean),
          nthChild: parent ? Array.from(parent.children).indexOf(el) + 1 : 0,
          text: (el instanceof HTMLElement ? el.innerText : (el.textContent ?? ''))
            .trim()
            .slice(0, 60),
        });
      }

      return {
        viewportWidth,
        documentWidth,
        identify,
        overflowing,
        smallTargets,
        smallTapTargetCount,
        overlaps,
        smallFonts,
        smallFontCount,
      };
    },
    {
      tolerance: OVERFLOW_TOLERANCE_PX,
      minTap: MIN_TAP_TARGET_PX,
      minFont: MIN_FONT_SIZE_PX,
      maxElements: 300,
    },
  );

  const at = (index: number): RawElement => raw.identify[index]!;

  return {
    viewportWidth: raw.viewportWidth,
    documentWidth: raw.documentWidth,
    overflowBy: Math.max(0, raw.documentWidth - raw.viewportWidth),
    overflowing: raw.overflowing.map((o) => ({
      selector: cssSelector(at(o.index)),
      overflowPx: o.overflowPx,
    })),
    smallTapTargets: raw.smallTargets.map((t) => ({
      selector: cssSelector(at(t.index)),
      width: t.width,
      height: t.height,
      text: at(t.index).text,
    })),
    smallTapTargetCount: raw.smallTapTargetCount,
    overlaps: raw.overlaps.map((o) => ({ a: cssSelector(at(o.a)), b: cssSelector(at(o.b)) })),
    smallFonts: raw.smallFonts.map((f) => ({
      selector: cssSelector(at(f.index)),
      fontSize: Math.round(f.fontSize * 10) / 10,
      text: at(f.index).text,
    })),
    smallFontCount: raw.smallFontCount,
  };
}

export function gradeResponsive(facts: ResponsiveFacts, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const where = { url: ctx.url, viewport: ctx.viewport };
  const mobile = ctx.viewport === 'mobile';
  const add = (item: Omit<Parameters<typeof createIssue>[0], 'page'>) =>
    issues.push(createIssue({ page: ctx.target, ...item }));

  if (facts.overflowBy > OVERFLOW_TOLERANCE_PX) {
    add({
      category: 'ux',
      severity: mobile ? 'MAJOR' : 'MINOR',
      title: 'Page scrolls sideways',
      detail: `The layout is ${facts.overflowBy}px wider than the ${facts.viewportWidth}px screen`,
      evidence: facts.overflowing.length
        ? facts.overflowing.map((o) => ({
            ...where,
            selector: o.selector,
            actual: `${o.overflowPx}px past the right edge`,
          }))
        : { ...where, expected: `${facts.viewportWidth}px`, actual: `${facts.documentWidth}px` },
    });
  }

  // Pointer size only means something on a touch screen.
  if (mobile && facts.smallTapTargetCount > 0) {
    add({
      category: 'ux',
      severity: facts.smallTapTargetCount > PATTERN_THRESHOLD ? 'MAJOR' : 'MINOR',
      title: 'Tap targets are too small',
      detail: `${facts.smallTapTargetCount} control(s) are under ${MIN_TAP_TARGET_PX}px`,
      evidence: facts.smallTapTargets.map((t) => ({
        ...where,
        selector: t.selector,
        ...(t.text ? { text: t.text } : {}),
        expected: `${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px`,
        actual: `${t.width}x${t.height}px`,
      })),
    });
  }

  if (facts.overlaps.length > 0) {
    add({
      category: 'ux',
      severity: mobile ? 'MAJOR' : 'MINOR',
      title: 'Controls overlap each other',
      detail: 'Elements sit on top of one another, so a tap can hit the wrong one',
      evidence: facts.overlaps.map((o) => ({ ...where, selector: `${o.a} ↔ ${o.b}` })),
    });
  }

  if (mobile && facts.smallFontCount > PATTERN_THRESHOLD) {
    add({
      category: 'ux',
      severity: 'MINOR',
      title: 'Text is too small to read on a phone',
      detail: `${facts.smallFontCount} element(s) render below ${MIN_FONT_SIZE_PX}px`,
      evidence: facts.smallFonts.map((f) => ({
        ...where,
        selector: f.selector,
        ...(f.text ? { text: f.text } : {}),
        expected: `${MIN_FONT_SIZE_PX}px`,
        actual: `${f.fontSize}px`,
      })),
    });
  }

  return issues;
}

export async function checkResponsive(ctx: CheckContext): Promise<Issue[]> {
  return gradeResponsive(await readResponsive(ctx), ctx);
}

export async function runResponsiveChecks(
  ctx: CheckContext,
  options: { suite?: CheckSuite } = {},
): Promise<CheckSuite> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });
  await suite.run(`responsive.${ctx.viewport}`, () => checkResponsive(ctx));
  return suite;
}
