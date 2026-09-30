@AGENTS.md

# AK47 · Depth Gallery Experience

A scroll-driven WebGL depth gallery of film posters. Read `README.md` for the architecture.

## Invariants

- Scroll progress maps to a film position through `dwell`, so integers frame films exactly.
- Posters and their dust share `releaseAmount` in `shaders/chunks.ts`, and so do titles and theirs. Change both sides together.
- Per-frame values never go through React state. The frame loop writes them through `HudHandle.update`.
- Colour work is linear. Posters and the atlas upload as sRGB textures, and only the post pass encodes.
- The haze uniforms are shared objects across materials, so mutate their values and never replace them.

## Checks

- `pnpm check` must stay green, and CI runs the same gates plus a format check.
- Visual changes are verified with `node tools/capture.mjs` against the dev server on port 3100.
- The autosave watcher commits and pushes `main` every ten minutes, and `main` deploys to Vercel.
