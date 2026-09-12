# Admin redesign trials, set 3 (2026-09-13)

Five self-contained mock-ups for the Shutter Admin app, built after set 2 was rejected
as dense dashboard furniture. Calm monochrome, favicon blue as the only accent, plain
language, no registry-generation counter.

- `build.mjs` generates `index.html` (`node build.mjs`); the page switches option, screen
  and theme with CSS-only radio controls.
- Published copy: https://vellum.traydr.dev/01a097f2-e556-779a-83bd-ba46ffdbbe83

Verdict: options 1 (Sites) and 2 (Routes) were the only ones worth keeping, with Sites
preferred. Feedback: stop repeating the delivery base URL on every card and row. Set 4
derives from those two.
