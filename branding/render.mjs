// Generates every Platen icon asset from one set of coordinates.
//
//   npm run brand
//
// The mark is a split P: a bar for the plate and a separate rounded frame for
// the film pressed against it. A continuous P in a rounded square is what a
// parking sign looks like, and the gap is what stops it reading as one.
//
// Everything is drawn on a 1024 grid. Change the geometry here and re-run; do
// not hand-edit the PNGs, which are outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DARK = '#0b0b0e';
const EMBER = '#f2913d';
const EMBER_LIGHT = '#ffac5f';
const EMBER_DEEP = '#e3731c';

/** Rounded rectangle as a path, so shapes can be combined with evenodd. */
const rr = (x, y, w, h, r) =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
  `V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
  `H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
  `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;

// Stroke 80 throughout, a 28-unit gap between bar and frame, and a 150x100
// counter: 3:2, the proportions of a 35mm frame. The glyph sits 12 units left
// of centre because the frame carries most of the visual weight.
const X = 291;
const GLYPH = [
  rr(X, 300, 80, 424, 22), // the plate
  rr(X + 108, 300, 310, 260, 66), // the frame
  rr(X + 188, 380, 150, 100, 10), // its opening
].join(' ');

const PLATE = rr(192, 192, 640, 640, 148);

const gradient = `<linearGradient id="ember" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${EMBER_LIGHT}"/><stop offset="1" stop-color="${EMBER_DEEP}"/>
  </linearGradient>`;

const svg = (body, viewBox = '0 0 1024 1024') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n  <defs>${gradient}</defs>\n  ${body}\n</svg>\n`;

const scaled = (s, body) =>
  `<g transform="translate(512 512) scale(${s}) translate(-512 -512)">${body}</g>`;

/** The plate with the glyph knocked out. Sits on any background. */
const MARK = `<path d="${PLATE} ${GLYPH}" fill="url(#ember)" fill-rule="evenodd"/>`;

/**
 * Full-bleed, for iOS and anywhere the OS applies its own mask. Drawing a
 * rounded plate inside would give a rounded square inside a rounded square.
 */
const FULL_BLEED = `<rect width="1024" height="1024" fill="url(#ember)"/>
  ${scaled(1.34, `<path d="${GLYPH}" fill="${DARK}" fill-rule="evenodd"/>`)}`;

/**
 * Android adaptive foreground. Launchers crop to a circle, squircle or
 * teardrop, and only the central 66 of 108dp is guaranteed visible.
 *
 * Scale 1 technically fits (the furthest corner is 306 units from centre
 * against a safe radius of 313) but it fills 62% of the visible circle, which
 * looks cramped next to the iOS icon at 55%. 0.86 matches iOS and leaves the
 * corner comfortably inside the safe zone at 263.
 */
const ADAPTIVE_SCALE = 0.86;
const glyphOnly = (fill) =>
  scaled(ADAPTIVE_SCALE, `<path d="${GLYPH}" fill="${fill}" fill-rule="evenodd"/>`);

const outputs = [];

async function png(name, markup, size, { flatten } = {}) {
  let image = sharp(Buffer.from(markup), { density: 400 }).resize(size, size);
  // App stores reject icons with an alpha channel.
  if (flatten) image = image.flatten({ background: flatten });
  const path = join(ROOT, name);
  mkdirSync(dirname(path), { recursive: true });
  await image.png().toFile(path);
  outputs.push(`${name} (${size}px)`);
}

function text(name, content) {
  const path = join(ROOT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  outputs.push(name);
}

// Sources, for the README and for anyone who wants the vector.
text('branding/platen-mark.svg', svg(MARK, '192 192 640 640'));
text('branding/platen-icon.svg', svg(FULL_BLEED));

// Unraid's Community Applications template points at this by raw URL.
await png('branding/platen-mark-512.png', svg(MARK, '192 192 640 640'), 512);

// Web.
text('web/public/favicon.svg', svg(MARK, '192 192 640 640'));
await png('web/public/favicon-32.png', svg(MARK, '192 192 640 640'), 32);
await png('web/public/apple-touch-icon.png', svg(FULL_BLEED), 180, { flatten: EMBER });

// Mobile.
await png('mobile/assets/icon.png', svg(FULL_BLEED), 1024, { flatten: EMBER });
await png('mobile/assets/adaptive-icon.png', svg(glyphOnly(DARK)), 1024);
await png('mobile/assets/adaptive-icon-background.png', svg(`<rect width="1024" height="1024" fill="url(#ember)"/>`), 1024);
// Android 13 themed icons tint this with the wallpaper colour; only its alpha
// matters, so it is white on transparent.
await png('mobile/assets/monochrome-icon.png', svg(glyphOnly('#ffffff')), 1024);
// The splash scales to the screen width with `contain`, so the mark is drawn
// small inside a large transparent canvas rather than filling it.
await png('mobile/assets/splash-icon.png', svg(scaled(0.42, MARK)), 1024);
// Shown on the sign-in screen. A PNG because rendering SVG in React Native
// needs react-native-svg, a native module, and a logo is not worth a rebuild.
await png('mobile/assets/mark.png', svg(MARK, '192 192 640 640'), 256);

console.log(`Wrote ${outputs.length} files:\n  ${outputs.join('\n  ')}`);
