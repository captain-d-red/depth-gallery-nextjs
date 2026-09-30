# AK47 · Through the Years

One continuous camera move through seventy-two films from 2010 to 2025. Depth in the scene
is time in the catalogue, every poster lights the haze around it, and titles and posters
break into dust as the camera walks through them.

```
  scroll ─► Lenis ─► film position ─► dwell ─► camera Z
                                                  │
        ┌─────────────────────────────────────────┴───────────────────────┐
        │ haze pass, half resolution                                      │
        │   analytic single scattering from six light samples per poster  │
        ├─────────────────────────────────────────────────────────────────┤
        │ scene pass, half float with 4x MSAA                             │
        │   backdrop · posters · title cards · poster and title dust ·    │
        │   floating motes                                                │
        ├─────────────────────────────────────────────────────────────────┤
        │ post pass                                                       │
        │   velocity smear toward the vanishing point · shoulder · grain  │
        └─────────────────────────────────────────────────────────────────┘
```

## The scene

- Posters alternate sides of the camera path, and each film's type is set on the opposite side.
- The haze is lit by the posters, using a closed-form integral per light sample, so no ray marching is needed.
- A poster breaks into ash as the camera passes it, handing each fragment to its own particle.
- Titles puff away as you leave a film and re-form from dust as you arrive or scroll back.
- The interface is a viewfinder, with a running timecode, a roll and take slate and each film's grade.

## Run it

- Install with `pnpm install`, then start the dev server with `pnpm dev`.
- Run every gate with `pnpm check`, which covers typecheck, lint, unit tests and the production build.
- Capture real renders with `node tools/capture.mjs --sizes laptop,fhd,imac,uhd,phone`.
- Rebuild the poster set with `pnpm films`, which reads sources from the sibling local-scripts folder.

## Layout

```
src/app/                  layout, page, global styles, fonts and the preview image
src/components/long-take/ the client shell, the scroll and the viewfinder interface
src/engine/               the renderer, film nodes, dust, title art and world layout
src/engine/shaders/       GLSL as typed template strings, shared chunks and passes
src/data/                 the generated catalogue and its runtime validation
src/lib/                  colour science in OKLab, easing and small math
scripts/prepare-films.ts  posters to WebP, the atlas and per-poster light samples
tools/                    Playwright capture and preview-image scripts
```

Poster art belongs to the studios that released the films and appears here as a
non-commercial design study. The interface face is an Inter-derived subset under the
SIL Open Font License.
