/**
 * Render `web/icon.svg` to every raster the product needs — the PWA icons, the favicon, and
 * the Windows `.ico` the installer puts on the district's desktop.
 *
 *     node scripts/make-icons.mjs
 *
 * **Run by hand, and the output is committed.** Playwright is a development dependency and a
 * browser download; making `npm run build` need one to produce a favicon would put a 150 MB
 * prerequisite in front of the build on the district's own machine, for files that change
 * about once a year. Same argument as `npm run shell:record` being its own command.
 *
 * Two families come out of one drawing:
 *
 *   * `icon-*.png` — the icon as drawn, edge to edge. What Windows, a browser tab and iOS use.
 *   * `maskable-*.png` — the same mark at 62% inside a full-bleed square of the tile colour,
 *     because Android crops a home-screen icon to whatever shape the launcher prefers. Ship
 *     only the first and a round launcher takes a bite out of the pulse line; ship only the
 *     second and every other platform gets an icon with a wide empty border.
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'web');
const out = join(web, 'icons');

/** The PWA and browser sizes. 180 is iOS's `apple-touch-icon`; 192 and 512 are the manifest's. */
const PNG_SIZES = [32, 180, 192, 512];
const MASKABLE_SIZES = [192, 512];
/** What goes inside the `.ico`. 256 is what Windows shows on a large-icon desktop. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * What fills the padding on the maskable variant.
 *
 * The tile itself is a gradient, and continuing it into the padding would need the gradient
 * re-projected across a larger box. The mid-tone reads as the same tile at every size anyone
 * sees a launcher icon at, for none of that.
 */
const TILE = '#0d9fce';

/**
 * Shoot one size.
 *
 * A `<img>` at an explicit width beats setting the SVG's own attributes: the browser rasterises
 * from the vector at the device pixel ratio we ask for, so 16px comes out sharp rather than
 * being a 512px bitmap thrown down a well.
 */
async function shoot(page, svg, size, { inset = 0 } = {}) {
  const pad = Math.round((size * inset) / 2);
  const inner = size - pad * 2;

  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;` +
      `background:${inset > 0 ? TILE : 'transparent'};display:flex;align-items:center;` +
      `justify-content:center;overflow:hidden">` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" ` +
      `width="${inner}" height="${inner}" style="display:block">` +
      `</body></html>`,
  );

  return page.screenshot({ omitBackground: inset === 0, type: 'png' });
}

/**
 * Pack PNGs into a Windows `.ico`.
 *
 * ICO entries may be either a headless BMP or a whole PNG file, and Windows has read the PNG
 * form since Vista. PNG is used for every size here: the BMP form needs a hand-built AND mask
 * and gets the alpha channel wrong in exactly the places this icon has soft edges.
 *
 * The one trap is the header — a 256px image is written as `0`, because the field is a single
 * byte and 256 does not fit in one. Writing 255 there produces an icon Explorer renders one
 * pixel short and Inno Setup rejects outright.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette: none, this is truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

const svg = await readFile(join(web, 'icon.svg'), 'utf8');
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const written = [];

for (const size of PNG_SIZES) {
  const png = await shoot(page, svg, size);
  await writeFile(join(out, `icon-${String(size)}.png`), png);
  written.push(`icon-${String(size)}.png`);
}

for (const size of MASKABLE_SIZES) {
  // 38% total inset keeps the whole mark inside Android's 80% safe circle with room to spare.
  const png = await shoot(page, svg, size, { inset: 0.38 });
  await writeFile(join(out, `maskable-${String(size)}.png`), png);
  written.push(`maskable-${String(size)}.png`);
}

const icoImages = [];
for (const size of ICO_SIZES) {
  icoImages.push({ size, png: await shoot(page, svg, size) });
}
await writeFile(join(out, 'app.ico'), ico(icoImages));
written.push(`app.ico (${ICO_SIZES.join(', ')})`);

await browser.close();

// eslint-disable-next-line no-console
console.log(`icons -> ${out}\n  ${written.join('\n  ')}`);
