# Istravex site

Marketing site for **Istravex**, an XDR conformance and replay kit for Stellar, proposed for SCF #46 RFP 2.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build → dist/
npm run test:e2e   # Playwright, desktop + mobile (builds and serves on :4173)
```

The e2e suite needs Playwright's full Chromium: `npx playwright install chromium`.

## Where things live

| Path | What |
|---|---|
| `src/content.ts` | **Every word on the page.** Edit copy here, not in components. |
| `src/sections/*` | One file per page section, in page order (see `App.tsx`). |
| `src/scenes/*` | GPU scenes. Each exports `create…(ctx, opts) → SceneHandle`. |
| `src/components/SceneMount.tsx` | Lazy-loads a scene near the viewport, pauses it offscreen, disposes it on unmount. |
| `public/proposal.md`, `public/llms.txt` | Full proposal and an agent-readable summary. |

## Scenes

| Section | Library | Fallback |
|---|---|---|
| Hero | Three.js `WebGPURenderer` + TSL | WebGL2 (automatic) |
| Fixture anatomy | Babylon.js `WebGPUEngine` | Babylon WebGL2 `Engine` |
| Closing CTA | TypeGPU compute + render pipelines | Canvas 2D |

Each scene's host element reports `data-backend` (`webgpu` / `webgl2` / `canvas2d`) and `data-state` (`idle` / `ready` / `failed`). If a scene fails, the page still works.

## Design rules

- No gradients, no italic or serif display type: solid colors and Geist / Geist Mono only.
- No taglines, eyebrows or helper text. If a section needs one to make sense, change the layout.
- Respect `prefers-reduced-motion`. Scenes render a still frame, and reveals are skipped.
- Mobile first. Keep a 16px gutter and no horizontal scroll (the e2e suite checks this).
