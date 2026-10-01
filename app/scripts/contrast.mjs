/**
 * Measure WCAG contrast on the **rendered page**, not from the stylesheet — M9-43.
 *
 * ## Why this exists as a script and not as eyes
 *
 * On 2026-08-12 every pairing in this product had been screenshotted and looked fine. None had
 * been measured. Two of them failed AA: white on `--primary` at 4.35:1 and white on `--critical`
 * at 3.76:1, both under the 4.5 threshold, on the emergency report button and every filled action
 * in the app. **Screenshots do not catch contrast. Only computing the ratio does.**
 *
 * ## Why it reads the browser rather than the file
 *
 * A stylesheet says `color: var(--slate)`. What reaches an officer's eye is whatever that
 * resolves to *after* the cascade, after a `[data-level]` override, after an `aria-pressed`
 * rule — and after any `rgba()` composited over whatever is actually behind it. Parsing the CSS
 * would measure what somebody meant; `getComputedStyle` measures what they get.
 *
 * Alpha is composited against the nearest opaque ancestor background, walking up, because that
 * is what the eye does. A translucent wash measured against transparent is a measurement of
 * nothing.
 *
 * ## What it does not do
 *
 * It does not decide what is a violation. It prints every pair it finds with its ratio and its
 * verdict, and `src/__tests__/contrast.e2e.test.ts` is what fails a build. A script that both
 * measured and forgave would be a check nobody could argue with.
 *
 *     node scripts/contrast.mjs            # the app shell
 */

import { chromium } from 'playwright';
import { buildWeb } from '../build.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Serve `web/dist` flat, so the page under test is the built artefact and not the source. */
async function serve(root) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(root, path === '/' ? 'index.html' : path);
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end('no');
      });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The measuring itself, run **inside** the page.
 *
 * Every visible element carrying text is measured against what is actually behind it. Elements
 * are skipped when they have no text of their own — a wrapper's colour is inherited by children
 * that are measured separately, and counting it would report the same pair a hundred times.
 */
export const MEASURE = /* js */ `(() => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value);
    if (m === null) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /*
    What is actually behind this element: the nearest ancestor with an opaque background.

    A GRADIENT stops the walk and returns null, because there is no single colour behind text
    sitting on one -- the ratio varies across the element. Reporting it as unmeasured is the
    honest answer; picking one stop and calling it the ground would produce a number that looks
    like a measurement and is not.
  */
  const groundOf = (node) => {
    let ground = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    for (let el = node; el !== null; el = el.parentElement) stack.push(el);
    // Outermost first, compositing down, so a translucent card over a body colour is right.
    for (const el of stack.reverse()) {
      const style = getComputedStyle(el);
      const bg = parse(style.backgroundColor);
      const opaque = bg !== null && bg.a >= 1;

      /*
        A gradient is only unmeasurable when it IS the backdrop -- that is, when the element
        painting it has no opaque colour of its own underneath. The page's header glow sits
        over an explicit background-color, so the text on it has a real ground and gets a real
        number. A severity tile painted entirely in a gradient does not, and saying so is more
        useful than inventing a stop to measure against.
      */
      if (style.backgroundImage.includes('gradient') && !opaque) return null;

      if (bg !== null && bg.a > 0) ground = over(bg, ground);
    }
    return ground;
  };

  const ownText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');

  const results = [];
  const unmeasured = [];
  const seen = new Set();

  for (const el of document.querySelectorAll('body *')) {
    if (!ownText(el)) continue;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (el.getBoundingClientRect().width === 0) continue;

    const fg = parse(style.color);
    if (fg === null) continue;
    /*
      Fully transparent text is not text. The product's one case is the wordmark, which paints
      its letters with background-clip:text -- a gradient through the glyphs, with the colour
      set to transparent so the gradient shows. There is nothing there to measure.

      No backticks anywhere inside MEASURE: this whole block is a template literal, and one
      backtick in a comment ends it in the middle of a function.
    */
    if (fg.a === 0) continue;

    const ground = groundOf(el);
    if (ground === null) {
      unmeasured.push({
        selector: el.tagName.toLowerCase() + (el.id !== '' ? '#' + el.id : ''),
        sample: (el.textContent ?? '').trim().slice(0, 34),
        why: 'sits on a gradient — no single colour behind it',
      });
      continue;
    }
    const colour = over(fg, ground);
    const value = ratio(colour, ground);

    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    // WCAG "large text": 18.66px bold, or 24px. Everything else takes the 4.5 threshold.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? 3 : 4.5;

    const key = style.color + '|' + JSON.stringify(ground) + '|' + threshold;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      selector:
        el.tagName.toLowerCase() +
        (el.id !== '' ? '#' + el.id : '') +
        (el.className !== '' && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).join('.')
          : ''),
      sample: (el.textContent ?? '').trim().slice(0, 34),
      colour: style.color,
      ground: 'rgb(' + [ground.r, ground.g, ground.b].map(Math.round).join(', ') + ')',
      size,
      weight,
      threshold,
      ratio: Math.round(value * 100) / 100,
      passes: value >= threshold,
    });
  }

  return { results, unmeasured };
})()`;

/** Every screen the shell can show without a session, plus the ones a stub login reveals. */
export async function measurePage(page) {
  return page.evaluate(MEASURE);
}

async function main() {
  const root = await buildWeb();
  const { server, origin } = await serve(root);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(origin);
  await page.waitForSelector('body');
  const { results, unmeasured } = await measurePage(page);

  const failures = results.filter((r) => !r.passes);

  for (const r of results.sort((a, b) => a.ratio - b.ratio)) {
    const mark = r.passes ? '  ok' : 'FAIL';
    console.log(
      `${mark}  ${String(r.ratio).padStart(6)} : ${String(r.threshold).padEnd(4)} ` +
        `${r.colour} on ${r.ground}  ${r.selector}  "${r.sample}"`,
    );
  }

  for (const u of unmeasured) {
    console.log(`  ??       -- : --   ${u.selector}  "${u.sample}"  (${u.why})`);
  }

  console.log(
    `
${String(results.length)} pairs, ${String(failures.length)} below AA, ` +
      `${String(unmeasured.length)} unmeasured`,
  );

  await browser.close();
  await new Promise((r) => server.close(r));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('contrast.mjs')) await main();
