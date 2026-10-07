# STL Text

Put text in **any font** onto an **STL model** – raised or cut in, following curved surfaces – and download a print-ready STL.

Everything runs in your browser. Your models and fonts are never uploaded anywhere.

**Live app:** https://captainteach123.github.io/STL-Text/

## What it does

- **Open any STL** (binary or ASCII). Broken files are **repaired automatically**: near-duplicate vertices are welded, flipped faces fixed, holes closed, inside-out and overlapping shells sorted out. Whatever cannot be repaired is kept as-is (shown in amber) so nothing from your model is lost.
- **Any font:** upload a `.ttf` / `.otf` / `.woff` file (or drop one on the page), pick a font installed on your computer (Chrome / Edge), or use one of six built-in fonts.
- **Several texts** on one model, each still editable: pick one in the *Texts* list, change its wording, font, size or placement at any time. Undo / redo for everything.
- **Click the model to place** a text; it aligns to the surface you click. Drag the text to move it, nudge with the arrow keys, snap to a side, rotate.
- **Follows curves.** Text keeps a constant height / depth on mugs, rings, domes and other curved surfaces instead of cutting a flat slab.
- **Raised or cut in**, with height / depth, letter height or overall width in mm, letter and line spacing, alignment, boldness, mirror (for stamps) and printer-friendly corner rounding.
- **Printing checks** based on your nozzle and layer height: strokes too thin to print, gaps that will fill in, engraving that would cut through a thin wall, text hanging over an edge or crossing a step, text that doesn't touch the model, raised text shallower than two layers – each with a one-click fix where possible.
- **Model tools:** convert inches to millimetres, stand a Y-up model upright, rotate, centre on the build plate, simplify huge meshes. The app suggests these when a file looks like it needs them.
- **Clean solids.** Text is merged with real boolean operations ([Manifold](https://github.com/elalish/manifold)), so the result is one watertight body – not overlapping shells. The heavy work runs in a background thread; the view stays responsive even with large models.

## Using it

1. **Model** – *Open STL…* (or drag a file onto the page). The info line shows its size and whether it needed repair; the app assumes millimetres, like most slicers.
2. **Texts** – *Add text*, then type. Each text in the list keeps its own font, size, placement and raised/cut setting.
3. **Text & font** – choose or upload a font, set the letter height (or the overall width).
4. **Raised or cut** – choose *Raised* or *Cut in* and the height / depth. Warnings about printability appear here.
5. **Placement** – click the model where the text should go, or drag it. The green ring shows where a click would land.
6. **Show final result** (top right of the 3D view) computes the real merged model; **Download STL** saves it.

The final model is always *model + all raised texts − all cut-in texts*, whatever order you added them in, so cut-in text always cuts through raised text.

### Tips for printing

- Set your **nozzle** and **layer height** under *Printing*; the warnings use them. With a 0.4 mm nozzle keep strokes ≥ 0.8 mm (use **Boldness** to thicken thin fonts) and raised text ≥ 0.4 mm tall, cut-in text ≥ 0.4 mm deep.
- **Round sharp corners** rounds every corner by half the nozzle width, which prints more cleanly; the radius is limited automatically so thin letters are never erased.
- Text follows curves up to about 60° away from the direction you clicked from. Wider than that (more than roughly a third of the way around a cylinder) letters stretch – the app warns; use shorter text, smaller letters or two lines.
- **Overlap** (under *Advanced*) is how far the text sinks into or pokes out of the surface so the merge is clean. The default 0.4 mm is fine almost everywhere.

### Limitations

- WOFF2 and `.ttc` font collections can't be read – use the `.ttf` / `.otf` / `.woff` version of the font.
- Cutting text into a model needs a watertight solid. Repair fixes most files; parts that stay open are kept in your download but can only have text raised on them.
- The built-in fonts contain Latin characters only. For other scripts, upload a font that has them.
- Text does not wrap around a cylinder; it follows the surface as seen from the click direction. Text placed on another text item is positioned relative to the model surface, not the other text.
- Very large models (millions of triangles) need a lot of memory. Use **Simplify** in *Fix model* first – the app suggests it above a million triangles.

## Publishing on GitHub Pages

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests, builds the app with Vite and deploys `dist/` to GitHub Pages on every push to `main` or the development branch (the branch names are listed in the `if:` conditions of that file).

1. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push (or re-run the workflow from the Actions tab). The app appears at `https://<your-user>.github.io/<repo>/`.

Don't use the "Jekyll" starter workflow GitHub suggests: this app has to be *built* (the browser cannot load `src/` and `node_modules/` directly), so a Jekyll deployment would publish a blank page.

## Development

```bash
npm ci
npm run dev      # local dev server with hot reload
npm test         # unit tests: text → geometry, mesh repair, surface conforming, engine protocol, document model
npm run build    # production build into dist/
npm run e2e      # builds the app and drives it in headless Chromium
```

`npm run e2e` needs a Chromium: set `CHROMIUM_PATH`, or run `npx playwright-core install chromium` once.

### How it works

| File | Role |
| --- | --- |
| `src/engine.js` | The geometry engine: a pure request handler (runs in the Web Worker, or in Node for tests). Loads and repairs models, parses fonts, builds text solids, computes the final geometry, exports STL, prepares display buffers with normals and a serialised BVH for picking |
| `src/worker.js` | 20-line Web Worker shim around the engine, owns the Manifold WASM instance |
| `src/engineClient.js` | Main-thread side: request scheduling (fast typing never queues stale previews), rehydration of fonts and model after a worker restart, error codes |
| `src/document.js` | Plain-data document: model transforms, text items, selection, undo / redo |
| `src/textGeometry.js` | Font + string → glyph outlines → polygons → Manifold `CrossSection` (non-zero union, boldness offset, clamped corner rounding) → extruded solid; thin-stroke and gap checks |
| `src/conform.js` | Samples the model surface along the text's normal and warps the text solid to follow it; wall thickness, slope, step and curvature statistics behind the warnings |
| `src/repair.js` | Triangle soup → watertight Manifold: degenerate removal, exact and tolerant welding (gated so thin sheets are never welded shut), winding fix, hole filling, shell classification (cavities kept), passthrough of what cannot be repaired |
| `src/mesh.js` | Conversions between triangle soups, Manifold and three.js buffers; display buffers; BVH building |
| `src/placement.js` | Surface normal + rotation → text transform (text stands upright on walls) |
| `src/stl.js` | STL parsing (via three.js) and the binary STL writer |
| `src/viewer.js` | three.js scene: orbit camera (Z-up), BVH picking, one overlay mesh per text, click-to-select / click-to-move / drag |
| `src/fontParse.js`, `src/fontCatalog.js` | Font parsing (worker) and the bundled / installed font sources (browser) |
| `src/main.js` | UI wiring |

Built with [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [opentype.js](https://opentype.js.org), [Manifold](https://github.com/elalish/manifold) and [Vite](https://vite.dev). Needs a browser with module Web Workers and WebGL (current Chrome, Edge, Firefox, Safari).

## Licenses

The code is MIT licensed (see [LICENSE](LICENSE)). Bundled fonts (Inter, Bebas Neue, Roboto Slab, Pacifico, Orbitron, Permanent Marker, via [Fontsource](https://fontsource.org)) are under the SIL Open Font License. Fonts you upload stay on your machine; make sure your font's license allows the use you have in mind.
