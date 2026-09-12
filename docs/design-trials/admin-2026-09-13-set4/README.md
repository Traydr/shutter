# Admin redesign trials, set 4 (2026-09-13)

Derived from set 3's Sites (options 1–3) and Routes (options 4–5), with the delivery base
URL shown at most once per Space page instead of on every card and row.

- `build.mjs` generates `index.html` (`node build.mjs`); CSS-only switcher for option,
  screen and theme.
- Published copy: https://vellum.traydr.dev/01a09803-c5de-73ca-a493-574ad33a3566

1. Sites: cards, tabs, sources first.
2. Sites with a left section nav; the editor lives inside the nav.
3. Sites as one long page with an anchor list; editing in a side panel.
4. Routes table without the host prefix; editing expands the row in place.
5. Routes on the left, access on the right; the Spaces overview is a compact table.
