import * as opentype from 'opentype.js';
import { fontLabel } from './textGeometry.js';

import interUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import bebasUrl from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';
import slabUrl from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import pacificoUrl from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import orbitronUrl from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff?url';
import markerUrl from '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff?url';

/** Fonts that ship with the app (all SIL Open Font License). */
export const BUNDLED_FONTS = [
  { id: 'inter', label: 'Inter Bold – clean sans', url: interUrl },
  { id: 'bebas', label: 'Bebas Neue – tall caps', url: bebasUrl },
  { id: 'slab', label: 'Roboto Slab Bold – serif', url: slabUrl },
  { id: 'pacifico', label: 'Pacifico – script', url: pacificoUrl },
  { id: 'orbitron', label: 'Orbitron Bold – techy', url: orbitronUrl },
  { id: 'marker', label: 'Permanent Marker – handwritten', url: markerUrl },
];

/** Parse font bytes, with friendly errors for formats opentype.js can't read. */
export function parseFont(arrayBuffer, fileName = 'font') {
  const tag = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, 0, 4));
  if (tag === 'wOF2') {
    throw new Error('WOFF2 fonts are not supported. Use the .ttf, .otf or .woff version of the font.');
  }
  if (tag === 'ttcf') {
    throw new Error('Font collections (.ttc) are not supported. Use a single .ttf or .otf file.');
  }
  let font;
  try {
    font = opentype.parse(arrayBuffer);
  } catch (err) {
    throw new Error(`Could not read "${fileName}" as a font (${err.message}).`);
  }
  if (!font?.glyphs?.length) throw new Error(`"${fileName}" does not contain any glyphs.`);
  return font;
}

export function labelFor(font, fileName) {
  return fontLabel(font, fileName.replace(/\.[^.]+$/, ''));
}

/** Load a bundled font by id (cached). */
const cache = new Map();
export async function loadBundled(entry) {
  if (!cache.has(entry.id)) {
    cache.set(
      entry.id,
      fetch(entry.url)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not download ${entry.label}`);
          return r.arrayBuffer();
        })
        .then((buf) => parseFont(buf, entry.label)),
    );
  }
  return cache.get(entry.id);
}

/** Local Font Access API (Chromium): fonts installed on this computer. */
export const canQueryLocalFonts = () => typeof window !== 'undefined' && 'queryLocalFonts' in window;

export async function listLocalFonts() {
  const fonts = await window.queryLocalFonts();
  return fonts.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function loadLocalFont(fontData) {
  const blob = await fontData.blob();
  return parseFont(await blob.arrayBuffer(), fontData.fullName);
}
