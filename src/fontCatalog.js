import interUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import bebasUrl from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';
import slabUrl from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import pacificoUrl from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import orbitronUrl from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff?url';
import markerUrl from '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff?url';

/**
 * Browser-only font sources: the bundled fonts (SIL Open Font License) and the
 * Local Font Access API. Parsing happens in the worker (see fontParse.js).
 */

export const BUNDLED_FONTS = [
  { id: 'inter', label: 'Inter Bold – clean sans', url: interUrl },
  { id: 'bebas', label: 'Bebas Neue – tall caps', url: bebasUrl },
  { id: 'slab', label: 'Roboto Slab Bold – serif', url: slabUrl },
  { id: 'pacifico', label: 'Pacifico – script', url: pacificoUrl },
  { id: 'orbitron', label: 'Orbitron Bold – techy', url: orbitronUrl },
  { id: 'marker', label: 'Permanent Marker – handwritten', url: markerUrl },
];

/** Download a bundled font's bytes (cached). */
const bytesCache = new Map();
export function fetchBundledFont(entry) {
  if (!bytesCache.has(entry.id)) {
    bytesCache.set(
      entry.id,
      fetch(entry.url).then((r) => {
        if (!r.ok) throw new Error(`Could not download ${entry.label}`);
        return r.arrayBuffer();
      }),
    );
  }
  return bytesCache.get(entry.id);
}

/** Local Font Access API (Chromium): fonts installed on this computer. */
export const canQueryLocalFonts = () => typeof window !== 'undefined' && 'queryLocalFonts' in window;

export async function listLocalFonts() {
  const fonts = await window.queryLocalFonts();
  return fonts.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function localFontBytes(fontData) {
  const blob = await fontData.blob();
  return blob.arrayBuffer();
}
