---
name: design-trials
description: Run UI design trials: compare a fixed-size set of distinct in-app layouts, refresh the full set after feedback, and land one winner. Use when the user wants variations, layout options, redesign, or side-by-side comparison.
---

# Design Trials

Design trials are a temporary studio inside the real app: keep a stable number of
options, make each option structurally different, refresh the whole set from feedback,
then commit the selected layout and delete the studio.

## Companion skills

If `frontend-design` is present, load it before generating a set. Use
`grill-with-docs` when the redesign depends on project-specific domain language,
workflow boundaries, or documented decisions; consult code and docs first, and do
not write app glossary or ADR entries for visual-only trial decisions.

## Stable count

Establish `N` before making options:

- If the user states a count, that count is `N`.
- If the user does not state a count, `N = 5`.
- Every later feedback pass produces exactly `N` variations.
- Change `N` only when the user explicitly asks for a different number.

Feedback never changes the count by implication. "Make them denser", "combine 2
and 4", "another pass", and "closer to option 3" each still mean a fresh set of
`N` options.

## Trial studio

Build a temporary numbered switcher (`1`-`N`) into the real app. It swaps layouts
without a page reload and persists the selected option across sessions. Keep the
studio isolated and easy to remove; it is comparison scaffolding, not product UI.

Every layout must satisfy the same controller contract. On each swap, destroy the
previous controller completely: event listeners, message handlers, storage listeners,
timers, and observers. Then initialize a fresh controller against the new DOM.

Before running the set, verify every required element ID appears exactly once in
each layout.

## Option quality

Every set contains `N` structurally distinct options. A new set is not a tweak pass:
do not reskin the same structure, rename cards, or only change palette. Vary the
information hierarchy, navigation model, density, disclosure, control placement, and
data presentation.

Each option preserves the required product behavior and surfaces the domain concepts
found in code and docs, but it should make the user understand the data differently
from the other options.

## Feedback loop

Treat feedback as constraints for the next fresh set. Constraints accumulate across
the whole trial: if the user likes the compactness of option 2 and the breadcrumbs
of option 5, the next set contains new structures that combine those qualities.

Continue with exactly `N` options until the user selects a winner, explicitly changes
`N`, or asks to stop comparing.

## Winner

When the user picks a layout, make it the only layout. Remove the switcher, layout
templates, discarded CSS, trial helpers, and storage keys. Inline the winner into
the app's permanent templates, and move shared rendering logic out of the trial
system. The final codebase should have no trace that a comparison studio existed.
