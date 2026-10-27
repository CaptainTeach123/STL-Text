/**
 * The page's look: the cyberpunk one (cyber.css) unless the visitor ticked Classic (style.css alone), remembered per
 * browser. index.html's head script reads the same key before the first paint: it sets the attribute and, for Classic,
 * takes the browser's colour away, so a Classic visitor never sees the other look flash by in the page or in the
 * browser's bar. This module keeps the attribute, the browser's colour and the icon in step after that. The view's own
 * colours follow through `Viewer.setTheme`.
 */

/** Where the choice is kept: `'classic'`, or nothing for the default (so a visitor who never chose follows it). */
export const THEME_KEY = 'stltext.theme';

/** The browser's colour for its own bar in the cyberpunk look (the panel's); Classic has none, as it never had. */
export const THEME_COLOR = '#0e0b1a';

/** The tab's icon in each look: a violet-black tile edged magenta with a cyan "A", and the orange one with a white "A". */
export const ICONS = Object.freeze({
  cyber:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M0 0h24l8 8v24H8L0 24z' fill='%230e0b1a'/%3E%3Cpath d='M1 1h22.6L31 8.4V31H8.4L1 23.6z' fill='none' stroke='%23ff2bd6' stroke-width='2'/%3E%3Ctext x='16' y='23' font-size='18' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='%2329e6ff'%3EA%3C/text%3E%3C/svg%3E",
  classic:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23ff7a1a'/%3E%3Ctext x='16' y='23' font-size='19' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='white'%3EA%3C/text%3E%3C/svg%3E",
});

/** The browser's storage, or null where even asking for it throws (blocked site data). */
export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The look this browser keeps: `'classic'` only for exactly that, `'cyber'` for anything else – nothing stored, another
 * value, or storage that throws (a private window, blocked site data), where the visit gets the default.
 */
export function storedTheme(storage = browserStorage()) {
  try {
    return storage?.getItem(THEME_KEY) === 'classic' ? 'classic' : 'cyber';
  } catch {
    return 'cyber';
  }
}

/** Keep the look: Classic is stored, the default removes the key. Where storage throws, the choice lasts the visit. */
export function storeTheme(storage, theme) {
  try {
    if (theme === 'classic') storage?.setItem(THEME_KEY, 'classic');
    else storage?.removeItem(THEME_KEY);
  } catch {
    /* private mode etc. */
  }
}

/** Show a look: the attribute the sheets key on (set either way, so the state can be seen), the browser's colour, the icon. */
export function applyTheme(theme, doc = document) {
  const classic = theme === 'classic';
  doc.documentElement.dataset.theme = classic ? 'classic' : 'cyber';
  let meta = doc.querySelector('meta[name="theme-color"]');
  if (classic) meta?.remove();
  else {
    if (!meta) {
      meta = doc.createElement('meta');
      meta.name = 'theme-color';
      doc.head.append(meta);
    }
    meta.content = THEME_COLOR;
  }
  const icon = doc.querySelector('link[rel="icon"]');
  if (icon) icon.href = ICONS[classic ? 'classic' : 'cyber'];
}
