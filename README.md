# STL Text

Put text in **any font** onto an **STL model** – raised (emboss) or cut in (engrave) – and download a print-ready STL.

Everything runs in your browser. Your models and fonts are never uploaded anywhere.

**Live app:** `https://captainteach123.github.io/stl-text/` (after you [enable GitHub Pages](#publishing-on-github-pages)).

## What it does

- **Open any STL** (binary or ASCII), or start from the built-in sample plaque, or use no model at all to export text on its own.
- **Any font:** upload a `.ttf` / `.otf` / `.woff` file (or drop one on the page), pick a font installed on your computer (Chrome / Edge), or use one of six built-in fonts.
- **Click the model to place the text.** It aligns to the surface you click – top, side walls, angled faces. Snap buttons (Top / Front / Back / Left / Right / Bottom), X/Y/Z fields and a rotate control fine-tune it.
- **Emboss or engrave**, with height/depth, letter height (mm), letter spacing, line spacing, left/centre/right alignment, boldness (thicken or thin the outlines – handy for thin script fonts), and mirror (for stamps).
- **Real boolean geometry** (via [Manifold](https://github.com/elalish/manifold)), so the result is a clean, watertight solid – not two overlapping shells.
- **Stack several texts** (apply, click somewhere else, apply again) with **Undo**.

## Using it

1. **Model** – *Open STL…* (or drag a file onto the page). The info line shows its size; the app assumes millimetres, like most slicers.
2. **Text & font** – type your text, choose or upload a font, set the letter height.
3. **Raised or cut** – choose *Emboss* or *Engrave* and the height/depth.
4. **Placement** – click the model where you want the text (the green ring shows where it will land).
5. **Apply to model** merges the text; **Download STL** saves it. (*Download* applies any pending text for you.)

### Tips for printing

- Keep strokes at least ~2× your nozzle width and embossed text ≥ 0.6 mm tall; engraved text ≥ 0.6 mm deep. Use **Boldness** to thicken thin fonts.
- **Overlap** is how far the text pokes into (emboss) or out of (engrave) the surface so the merge is clean. Raise it (1–2 mm) on strongly curved surfaces.
- Text is flat: it sits on the tangent plane where you clicked and does not wrap around curves.

### Limitations

- WOFF2 and `.ttc` font collections can't be read – use the `.ttf`/`.otf`/`.woff` version of the font.
- Engraving needs a **watertight** model. A model with holes can still be embossed (the text is added as a separate overlapping shell, which slicers merge), but not cut – repair it first in your slicer, 3D Builder or Meshmixer. Inside-out (inverted-normal) models are fixed automatically.
- The built-in fonts only contain Latin characters. For other scripts, upload a font that has them.
- Very large models (millions of triangles) will be slow; typical models (up to a few hundred thousand triangles) take around a second.

## Publishing on GitHub Pages

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) tests, builds and deploys the site on every push to `main`.

1. Merge this code into `main`.
2. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push (or re-run the workflow). The app appears at `https://<your-user>.github.io/<repo>/`.

## Development

```bash
npm ci
npm run dev      # local dev server with hot reload
npm test         # unit tests (text -> geometry, placement, STL I/O, booleans)
npm run build    # production build into dist/
npm run e2e      # builds the app and drives it in headless Chromium
```

`npm run e2e` needs a Chromium: set `CHROMIUM_PATH`, or run `npx playwright-core install chromium` once.

### How it works

| File | Role |
| --- | --- |
| `src/textGeometry.js` | Font + string → glyph outlines → flattened polygons → Manifold `CrossSection` (non-zero union, optional offset) → extruded solid |
| `src/editor.js` | Document state: loads the model, applies text with boolean add/subtract, undo history |
| `src/mesh.js` | Triangle soup ⇄ Manifold (vertex welding, inside-out repair, non-watertight detection) |
| `src/placement.js` | Surface normal + spin → text transform (so text stands upright on walls) |
| `src/stl.js` | STL parse (via three.js) and binary STL writer |
| `src/viewer.js` | three.js scene: orbit camera (Z-up), BVH-accelerated click picking, text preview |
| `src/fonts.js` | Bundled fonts, font file parsing, system font access |
| `src/main.js` | UI wiring |

Built with [three.js](https://threejs.org), [opentype.js](https://opentype.js.org), [Manifold](https://github.com/elalish/manifold) and [Vite](https://vite.dev).

## Licenses

The code is MIT licensed (see [LICENSE](LICENSE)). Bundled fonts (Inter, Bebas Neue, Roboto Slab, Pacifico, Orbitron, Permanent Marker, via [Fontsource](https://fontsource.org)) are under the SIL Open Font License. Fonts you upload stay on your machine; make sure your font's license allows the use you have in mind.
