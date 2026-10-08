# STL Text

Put text in **any font** onto an **STL model** – raised or cut in, following curved surfaces – and download a print-ready STL.

Everything runs in your browser. Your models and fonts are never uploaded anywhere.

**Live app:** https://captainteach123.github.io/STL-Text/

## What it does

- **Open any STL** (binary or ASCII). Broken files are **repaired automatically**: near-duplicate vertices are welded, flipped faces fixed, holes closed, inside-out and overlapping shells sorted out. Whatever cannot be repaired is kept as-is (shown in amber) so nothing from your model is lost.
- **Any font:** upload a `.ttf` / `.otf` / `.woff` file (or drop one on the page), pick a font installed on your computer (Chrome / Edge), or use one of six built-in fonts.
- **Lines in different fonts and sizes.** A text is a stack of lines, and every line has its own font and letter height – a big serif title with a small script name under it, laid out and placed as one block. Press Enter for a new line; the width field scales the whole block.
- **Plaques and banners.** Give a text a backing plate – a rounded plaque or a swallow-tailed banner – that is raised on the model with the text raised on it or engraved into it. Plates follow curves too, so a banner wraps around a cane or a mug.
- **Enhance low-definition models** (often what AI generators produce): *Sharpen edges* makes soft, rounded edges crisp and the surfaces meeting there flat; *Smooth bumps* removes lumps and ripples from surfaces while keeping edges and relief; *Boost relief* deepens fine detail – leaves, berries, scrollwork – so it stands out and prints with more definition. Everything is bounded so the model stays a valid, printable solid: the triangles are kept, none is ever flipped, and no point moves further than a third of its local triangle size unless you raise *Max move* (fine-tune) to sharpen wider roundings. *Edge angle* decides what counts as an edge, *Relief size* how large the detail to boost or the bumps to remove are. Compare with "Show original", undo, or reset at any time; downloads include the enhancement.
- **Clean-up spots** for clumped areas (a wreath whose berries and leaves have run together, a soft scroll): add a spot, drag its ring onto the area and set its radius. Inside the spot *Separate details* deepens the valleys between details so they read as separate shapes, *Even out depth* gives weak details more depth and very strong ones a little less, *Boost relief* and the sharpen/smooth amounts work as in the global tool but with a larger movement allowance (about one triangle size by default, raise *Max move* for deeply merged details). The clean-up fades out over the spot's soft edge, several spots can be combined, and downloads include them. A spot works on the model itself, so it is not part of what is added on top.
- **Attach other STL files** as parts: place a second model on the first and choose how it connects – *fused* (sunk into the surface), *fused with a fillet* (a smooth, layered fillet around the foot: the strongest, cleanest joint) or *pegs and holes* (the part is downloaded on its own with pegs, the model gets matching holes with clearance, for printing separately and gluing). Scale it, choose which side touches, turn it freely (tilt, roll and spin, with 90° buttons), sink it into the surface, or use it as a cutter. A part always comes down to rest on the surface under it (on a curved or sloping surface, or after a click that landed a little high), so it really overlaps the model by its sink; if anything raised still does not overlap the model, the final result and the download say so instead of silently leaving a loose piece. A part that is not touching the model is shown as a grey wireframe and listed as "not touching"; *Snap to model* lays it on the nearest point of the surface by the side that faces the model (so a banner standing on its edge beside the model ends up flat against it), clearing any tilt or roll.
- **Several texts and parts** on one model, each still editable: pick one in the *Texts & parts* list, change its lines, placement or connection at any time. Undo / redo for everything.
- **Click the model to place** a text; it aligns to the surface you click. Drag the text to move it, nudge with the arrow keys, snap to a side, rotate.
- **Follows curves.** Text keeps a constant height / depth on mugs, rings, domes and other curved surfaces instead of cutting a flat slab.
- **Raised or cut in**, with height / depth, letter height or overall width in mm, letter and line spacing, alignment, boldness, mirror (for stamps) and printer-friendly corner rounding.
- **Printing checks** based on your nozzle and layer height: strokes too thin to print, gaps that will fill in, engraving that would cut through a thin wall, text hanging over an edge or crossing a step, text that doesn't touch the model, raised text shallower than two layers – each with a one-click fix where possible.
- **Model tools:** convert inches to millimetres, stand a Y-up model upright, rotate, centre on the build plate, simplify huge meshes. The app suggests these when a file looks like it needs them.
- **Clean solids.** Text and parts are merged with real boolean operations ([Manifold](https://github.com/elalish/manifold)), so the result is one watertight body – not overlapping shells. The heavy work runs in a background thread; the view stays responsive even with large models, and models above ~400k triangles are shown through a lighter preview while downloads keep the full detail.
- **Built for big models.** Every step of the model's derivation (transforms, simplification, enhancement, each clean-up state) is cached, the view is refit rather than rebuilt when only vertices move, and the solid for downloads is built only when needed, so nudging a slider costs one short re-derivation instead of several seconds. Enhancement and clean-up amounts apply when a slider is released (the model dims and the card says *applying…* while the worker catches up). On a dense model the lighter preview is cleaned up alongside the full model, so a spot's effect shows immediately; the download is always computed on the full-detail model.

## Using it

1. **Model** – *Open STL…* (or drag a file onto the page). The info line shows its size and whether it needed repair; the app assumes millimetres, like most slicers.
2. **Texts & parts** – *Add text*, then type; or *Add part (STL)…* to attach another model. Each entry in the list keeps its own settings and placement.
3. **Text & fonts** – one row per line: its wording, font and letter height in mm. *Add line* (or Enter) adds a line below the current one; uploaded fonts apply to the current line. *Text width* scales all lines together.
4. **Raised or cut** – choose *Raised* or *Cut in* and the height / depth; optionally a *Backing plate* (plaque or banner) with its thickness and margin. Warnings about printability appear here. For a part this card offers *Add* or *Cut out*, and the *Part* card its scale, attach side, tilt, sink depth and connection (fused, fused + fillet, pegs & holes).
5. **Placement** – click the model where the text should go, or drag it. The green ring shows where a click would land.
6. **Show final result** (top right of the 3D view) computes the real merged model; **Download STL** saves it.

The final model is always *model + everything raised or fused − everything cut*, whatever order you added them in, so cut-in text always cuts through raised text. Parts connected with pegs are not merged: they are downloaded as separate files.

### Connecting parts well

- **Fused** is right for one-piece prints: the part sinks a little into the surface (default 0.4 mm) so the two bodies share material.
- **Fused + fillet** adds a concave fillet around the foot of the part, built from layers so it prints exactly as drawn. It spreads the load over a wider footprint, hides small gaps on curved surfaces and looks like a cast joint. 1–3 mm radius suits most parts.
- **Pegs & holes** is for parts printed separately (another colour, another orientation): pegs on the part, holes in the model with a clearance (0.15 mm is a good start for a snug fit after printing), glued on assembly. Pegs are only placed where a whole peg fits under the part (one under each foot of a bridge-shaped part), and the part file is saved lying on its face with the pegs pointing up, ready to print. Pegs need a watertight model to make holes in; on a model with gaps the part is fused instead.
- **Tilt** pivots the part about the point you clicked: one edge goes into the surface, the other lifts off it. The app warns when the lifted edge leaves a gap, which a bigger sink or the fillet closes.
- **Cut out** (a part used as a cutter) removes the part's shape from the model; its *Cut depth* is how far it sinks in. A cutter has no connection options.

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
| `src/engine.js` | The geometry engine: a pure request handler (runs in the Web Worker, or in Node for tests). Loads and repairs models and parts, parses fonts, builds text / plate / part solids and their joins (fillet skirts, pegs and holes), computes the final geometry, exports STL (plus separate part files), prepares display buffers – simplified for very dense models – with normals and a serialised BVH for picking |
| `src/worker.js` | 20-line Web Worker shim around the engine, owns the Manifold WASM instance |
| `src/engineClient.js` | Main-thread side: request scheduling (fast typing never queues stale previews), rehydration of fonts and model after a worker restart, error codes |
| `src/document.js` | Plain-data document: model transforms, text items, selection, undo / redo |
| `src/textGeometry.js` | Lines (each with its own font and size) → glyph outlines → polygons → Manifold `CrossSection` (non-zero union, boldness offset, clamped corner rounding) → extruded solid; thin-stroke and gap checks |
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
