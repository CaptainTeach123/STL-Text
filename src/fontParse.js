import opentype from 'opentype.js';
import { fontLabel } from './textGeometry.js';

/**
 * Font file parsing, usable in the worker and in Node (no DOM, no asset URLs).
 */

/** Parse font bytes, with friendly errors for formats opentype.js can't read. */
export function parseFont(arrayBuffer, fileName = 'font') {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 4) {
    throw new Error(`"${fileName}" is empty or not a font file.`);
  }
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

/** Display name for a parsed font, falling back to the file name. */
export function labelFor(font, fileName = 'Custom font') {
  return fontLabel(font, fileName.replace(/\.[^.]+$/, ''));
}
