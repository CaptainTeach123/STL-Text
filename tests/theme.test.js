import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APART_COLOR, CUT_COLOR } from '../src/split.js';
import { ICONS, THEME_COLOR, THEME_KEY, applyTheme, storeTheme, storedTheme } from '../src/theme.js';
import { LOCK_COLORS, TEXT_COLORS } from '../src/viewer.js';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const styleCss = fs.readFileSync(path.join(src, 'style.css'), 'utf8');
const cyberCss = fs.readFileSync(path.join(src, 'cyber.css'), 'utf8');
const SCOPE = "html:not([data-theme='classic'])";

/** A sheet as a tree of blocks, { prelude, body, children }, comments dropped. Enough for these sheets: no braces in strings. */
function blocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = { prelude: '', body: '', children: [] };
  const stack = [root];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      const node = { prelude: buf.trim().split(';').pop().trim(), body: '', children: [] };
      stack.at(-1).body += buf.slice(0, buf.lastIndexOf(';') + 1);
      stack.at(-1).children.push(node);
      stack.push(node);
      buf = '';
    } else if (ch === '}') {
      stack.pop().body += buf;
      buf = '';
    } else buf += ch;
  }
  root.body += buf;
  return root;
}

/** The properties a rule declares, in order. */
const declared = (rule) => rule.body.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);
/** A rule's selectors. */
const selectorsOf = (rule) => rule.prelude.split(',').map((s) => s.trim());

/** The custom properties a block sets, by name. */
const tokensOf = (block) => Object.fromEntries([...block.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const hexOf = (n) => `#${n.toString(16).padStart(6, '0')}`;

const style = blocks(styleCss);
const classicLight = tokensOf(style.children.find((b) => b.prelude === ':root'));
const classicDark = tokensOf(style.children.find((b) => b.prelude === '@media (prefers-color-scheme: dark)').children[0]);
const cyberSheet = blocks(cyberCss);
const cyber = tokensOf(cyberSheet.children.find((b) => b.prelude === SCOPE));
const cyberMore = tokensOf(cyberSheet.children.find((b) => b.prelude === '@media (prefers-contrast: more)').children[0]);

/* ---------------------------------------------------------------- WCAG 2 contrast */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** color-mix(in srgb, a p%, b), as the browser composites a tint or a translucent overlay. */
const mix = (a, p, b) => `#${rgb(a).map((v, i) => Math.round(v * p + rgb(b)[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;

describe('the stored look', () => {
  const store = (initial = {}) => {
    const data = { ...initial };
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => (data[k] = String(v)), removeItem: (k) => delete data[k] };
  };
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

  it("is Classic only for exactly 'classic', the cyberpunk look for anything else", () => {
    expect(THEME_KEY).toBe('stltext.theme');
    expect(storedTheme(store({ [THEME_KEY]: 'classic' }))).toBe('classic');
    for (const v of [undefined, '', 'Classic', 'classic ', 'cyber', 'dark', 'light']) expect(storedTheme(store(v === undefined ? {} : { [THEME_KEY]: v }))).toBe('cyber');
    expect(storedTheme(null)).toBe('cyber');
    expect(storedTheme(throwing)).toBe('cyber');
  });

  it('stores Classic and removes the key for the default, and never throws where storage is blocked', () => {
    const s = store({ other: 'kept' });
    storeTheme(s, 'classic');
    expect(s.data).toEqual({ other: 'kept', [THEME_KEY]: 'classic' });
    storeTheme(s, 'cyber');
    expect(s.data).toEqual({ other: 'kept' });
    expect(() => storeTheme(throwing, 'classic')).not.toThrow();
    expect(() => storeTheme(throwing, 'cyber')).not.toThrow();
    expect(() => storeTheme(null, 'classic')).not.toThrow();
  });

  it("applies a look: the attribute either way, the browser's colour only in the cyberpunk look, the look's icon", () => {
    const fake = () => {
      const metas = [];
      const icon = { href: 'old' };
      const doc = {
        documentElement: { dataset: {} },
        head: { append: (m) => metas.push(m) },
        createElement: () => {
          const m = { name: '', content: '', remove: () => metas.splice(metas.indexOf(m), 1) };
          return m;
        },
        querySelector: (sel) => (sel.startsWith('meta') ? metas.find((m) => m.name === 'theme-color') ?? null : sel.startsWith('link') ? icon : null),
      };
      return { doc, metas, icon };
    };
    const { doc, metas, icon } = fake();
    applyTheme('classic', doc);
    expect(doc.documentElement.dataset.theme).toBe('classic');
    expect(metas).toEqual([]);
    expect(icon.href).toBe(ICONS.classic);
    applyTheme('cyber', doc);
    expect(doc.documentElement.dataset.theme).toBe('cyber');
    expect(metas.map((m) => [m.name, m.content])).toEqual([['theme-color', THEME_COLOR]]);
    expect(icon.href).toBe(ICONS.cyber);
    applyTheme('classic', doc);
    expect(metas).toEqual([]);
    // Classic's icon is the one the page always had
    expect(ICONS.classic).toContain("fill='%23ff7a1a'");
    expect(THEME_COLOR).toBe(cyber['--panel']);
  });

  it("is the same look in index.html's head, before the app's script: its icon, its colour, and Classic's icon", () => {
    const html = fs.readFileSync(path.join(src, '../index.html'), 'utf8');
    expect(html).toContain(`<link rel="icon" href="${ICONS.cyber}" />`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR}" />`);
    // the head's script sets Classic's icon as theme.js does, so a Classic tab never shows the other one
    const head = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(head).toContain(`'${THEME_KEY}') === 'classic'`);
    expect(head).toContain(`.href = "${ICONS.classic}"`);
  });
});

describe('Classic is the look the page had', () => {
  it("keeps the view's text colours", () => {
    expect(TEXT_COLORS.classic).toEqual({ emboss: 0xff8a2b, engrave: 0xff3b6b });
    expect(TEXT_COLORS.cyber).toEqual({ emboss: 0xff2bd6, engrave: 0xc6ff3d });
  });

  it("keeps every token's value, light and dark", () => {
    const before = {
      '--bg': '#f4f6fa', '--panel': '#ffffff', '--card': '#f6f8fc', '--border': '#dde3ee', '--text': '#1b2230', '--muted': '#5c6880', '--accent': '#ff7a1a',
      '--accent-ink': '#ffffff', '--accent-soft': '#fff0e3', '--ok': '#0f9d7a', '--err': '#d6294b', '--cut': '#8b5cf6', '--apart': '#0d9488', '--amber': '#f59e0b',
      '--lock': '#ff6a00', '--lock-text': '#c2410c', '--stage-top': '#eef2fa', '--stage-bottom': '#cfd8e8', '--radius': '10px',
    };
    const beforeDark = {
      '--bg': '#0f1420', '--panel': '#171d2b', '--card': '#1d2535', '--border': '#2b364c', '--text': '#e8edf7', '--muted': '#94a0b8', '--accent-soft': '#3a2616',
      '--lock-text': '#fb923c', '--stage-top': '#243049', '--stage-bottom': '#121827',
    };
    for (const [k, v] of Object.entries(before)) expect([k, classicLight[k]]).toEqual([k, v]);
    for (const [k, v] of Object.entries(beforeDark)) expect([k, classicDark[k]]).toEqual([k, v]);
    // what the page fell back to where these were never set; in the dark the plan lists take the dark border
    expect(classicLight['--line']).toBe('#d8dde6');
    expect(classicLight['--warn']).toBe('#c77700');
    expect(classicDark['--line']).toBe('var(--border)');
    expect(classicLight['--font-ui']).toBe("system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif");
  });

  it("leaves the line editor's text box the browser's own, as it was", () => {
    // the field rule takes numbers, selects and text areas; a text box by its type only in the cyberpunk sheet
    expect(styleCss).not.toMatch(/input\[type=['"]?text/);
    const rule = style.children.find((b) => b.prelude === '.lines .line-text');
    expect(declared(rule).sort()).toEqual(['font-size', 'grid-column']);
  });
});

describe("the legend's chips are what the view draws, in either look", () => {
  it('reads the view’s own colours', () => {
    expect(classicLight['--emboss']).toBe(hexOf(TEXT_COLORS.classic.emboss));
    expect(classicLight['--engrave']).toBe(hexOf(TEXT_COLORS.classic.engrave));
    expect(cyber['--emboss']).toBe(hexOf(TEXT_COLORS.cyber.emboss));
    expect(cyber['--engrave']).toBe(hexOf(TEXT_COLORS.cyber.engrave));
    expect(classicLight['--cut']).toBe(hexOf(CUT_COLOR));
    expect(classicLight['--apart']).toBe(hexOf(APART_COLOR));
    for (const k of ['lock', 'lug', 'seat', 'over', 'bridge']) expect([k, classicLight[`--${k}`]]).toEqual([k, hexOf(LOCK_COLORS[k])]);
  });

  it('leaves every colour that means something as it is in the cyberpunk look', () => {
    for (const k of ['--cut', '--apart', '--amber', '--lock', '--model', '--pass', '--spot', '--lug', '--seat', '--over', '--bridge']) {
      if (k in cyber) expect([k, cyber[k]]).toEqual([k, classicLight[k]]);
    }
  });
});

describe('the cyberpunk sheet', () => {
  it('keeps every rule under its scope, so nothing of it reaches Classic', () => {
    const where = `:where(${SCOPE})`;
    for (const b of cyberSheet.children) {
      const p = b.prelude;
      const ok =
        p === SCOPE ||
        p === where ||
        p.startsWith('@keyframes ') ||
        (/^@(media|supports) /.test(p) && b.children.length > 0 && b.children.every((c) => c.prelude === SCOPE || c.prelude === where));
      expect([p, ok]).toEqual([p, true]);
    }
    // the imports only declare faces, and come first
    expect(cyberSheet.body.trim().split(/;\s*/).filter(Boolean).every((s) => /^@import '@fontsource\/(inter|orbitron)\/\d00\.css'$/.test(s))).toBe(true);
    // nothing that would cost a frame over the view, and nothing drawn into it
    expect(cyberCss).not.toMatch(/corner-shape\s*:/);
    expect(cyberCss).not.toMatch(/backdrop-filter\s*:/);
    expect(cyberCss).not.toMatch(/clip-path\s*:/);
  });

  it("never outweighs style.css's forced-colours rules, which hold in either look", () => {
    // its rules meet style.css's at the same weight and come later, so one that sets what a forced-colours rule sets
    // wins over it: the bar at the foot of the panel went see-through in a contrast theme that way
    const forced = style.children.find((b) => b.prelude === '@media (forced-colors: active)').children;
    expect(forced.some((f) => selectorsOf(f).includes('.actions') && declared(f).includes('background'))).toBe(true);
    const rules = [];
    const walk = (b) => {
      for (const c of b.children) {
        if (!c.prelude.startsWith('@')) rules.push(c);
        else if (!c.prelude.includes('forced-colors')) walk(c);
      }
    };
    walk(cyberSheet.children.find((b) => b.prelude === `:where(${SCOPE})`));
    const overlaps = (a, b) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
    const clashes = [];
    for (const f of forced) {
      for (const r of rules) {
        for (const sel of selectorsOf(r).filter((x) => selectorsOf(f).includes(x))) {
          for (const p of declared(r)) if (declared(f).some((q) => overlaps(p, q))) clashes.push(`${sel} { ${p} }`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('never upper-cases or spaces out what the page reads back, only the headings', () => {
    const tree = cyberSheet.children.find((b) => b.prelude === `:where(${SCOPE})`);
    const rules = [];
    const walk = (b) => b.children.forEach((c) => (c.prelude.startsWith('@') ? walk(c) : rules.push(c)));
    walk(tree);
    const allowed = ['.brand h1', '.card h2', 'details.card > summary b', '.parts-title'];
    for (const r of rules.filter((r) => /text-transform\s*:\s*uppercase/.test(r.body))) expect(allowed).toContain(r.prelude);
    const spacing = (r) => r.body.match(/letter-spacing\s*:\s*([^;]+)/)?.[1].trim();
    for (const r of rules.filter((r) => spacing(r) && spacing(r) !== '0')) expect(allowed).toContain(r.prelude);
  });

  it('reads at WCAG AA: text 4.5:1, the edges and rings of controls 3:1', () => {
    const t = (k) => {
      const v = cyber[k];
      return v.startsWith('var(') ? cyber[v.slice(4, -1)] : v;
    };
    const ink = t('--ink');
    const surfaces = { panel: t('--panel'), card: t('--card'), field: t('--field'), btn: t('--btn') };
    // the thumb is set on the scope itself; a token in it follows the more-contrast values where they differ
    const thumbSet = cyberSheet.children.find((b) => b.prelude === SCOPE).body.match(/scrollbar-color\s*:\s*(\S+)/)[1];
    const thumbToken = thumbSet.match(/^var\((--[\w-]+)\)$/)?.[1];
    const thumb = thumbToken ? t(thumbToken) : thumbSet;
    const thumbMore = thumbToken ? cyberMore[thumbToken] ?? thumb : thumbSet;
    // the worst a panel over the view gets: 90 % over a white pixel
    const overlayWorst = mix(t('--panel'), 0.9, '#ffffff');
    const text = [
      ...Object.entries(surfaces).flatMap(([n, bg]) => [
        [`text on ${n}`, t('--text'), bg],
        [`muted on ${n}`, t('--muted'), bg],
      ]),
      ['card heading (cyan) on card', t('--cyan'), surfaces.card],
      ['magenta words on card', t('--magenta'), surfaces.card],
      ['status ok on panel', t('--ok'), surfaces.panel],
      ['status error on panel', t('--err'), surfaces.panel],
      ['warn hint on card', t('--warn'), surfaces.card],
      ['lock words on a button', t('--lock-text'), surfaces.btn],
      ['ink on yellow (step, the buttons that do the thing)', ink, t('--yellow')],
      ['ink on magenta (chosen)', ink, t('--magenta')],
      ['ink on violet (cut badge)', ink, t('--cut')],
      ['ink on teal (comes apart)', ink, t('--apart')],
      ['ink on acid green (cut text glyph)', ink, t('--engrave')],
      ['ink on the warn chip', ink, t('--err')],
      ['text on a warn note', t('--text'), mix(t('--err'), 0.09, surfaces.field)],
      ['muted on a warn note', t('--muted'), mix(t('--err'), 0.09, surfaces.field)],
      ['text on a suggestion', t('--text'), mix(t('--amber'), 0.09, surfaces.field)],
      ['text over the view', t('--text'), overlayWorst],
      ['readout "none" over the view', t('--err'), overlayWorst],
      ['lock words over the view', t('--lock-text'), overlayWorst],
      ['the Classic switch on the panel', t('--muted'), surfaces.panel],
    ];
    const parts = [
      ...['panel', 'card', 'field'].flatMap((n) => [
        [`control edge on ${n}`, t('--edge'), surfaces[n]],
        [`focus ring on ${n}`, t('--cyan'), surfaces[n]],
      ]),
      ['checked segment against the field', t('--magenta'), surfaces.field],
      ['card bracket on card', mix(t('--cyan'), 0.7, surfaces.card), surfaces.card],
      ['readout bracket, violet, over the view', t('--cut'), overlayWorst],
      ['more contrast: edge on card', cyberMore['--edge'], surfaces.card],
      // a scroll bar's thumb is often the only sign that there is more, as on the status line cut off mid-sentence
      ...['panel', 'card', 'field'].map((n) => [`scroll bar thumb on ${n}`, thumb, surfaces[n]]),
      ['more contrast: scroll bar thumb on card', thumbMore, surfaces.card],
    ];
    const low = [
      ...text.filter(([, fg, bg]) => contrast(fg, bg) < 4.5),
      ...parts.filter(([, fg, bg]) => contrast(fg, bg) < 3),
    ].map(([n, fg, bg]) => `${n}: ${contrast(fg, bg).toFixed(2)}`);
    expect(low).toEqual([]);
    expect(contrast(cyberMore['--muted'], surfaces.card)).toBeGreaterThan(7);
    // and it is firmer when more contrast is asked for, as the edges are
    expect(contrast(thumbMore, surfaces.card)).toBeGreaterThan(contrast(thumb, surfaces.card));
  });
});
