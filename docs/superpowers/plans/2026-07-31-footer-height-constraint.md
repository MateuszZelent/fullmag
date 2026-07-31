# Footer Height Constraint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline with the repository's frontend verification gates.

**Goal:** Keep every bottom-footer surface inside the height allocated by the resizable workspace dock so telemetry and other single-panel tabs remain visible and scrollable instead of extending underneath the status bar.

**Architecture:** Preserve the existing resizable workspace and footer module boundaries. Change the footer tab-content container from a generic two-row grid to a constrained vertical flex container; use Tailwind utilities at the JSX containment boundaries, keep the logs tab's existing filter/content split, and make each single-root panel consume the remaining height. Add a source-level regression test for the CSS/utility contract because the defect is caused by the style hierarchy rather than a runtime model.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS, Vitest.

## Global Constraints

- Keep the `panel-bottom` slot resizable; do not make the footer auto-grow over the status bar.
- Preserve `fm-*` class naming and `--fm-*` design tokens.
- Touch only the footer sizing styles, the footer containment utility classes, and the focused regression test.
- Preserve all unrelated dirty-worktree changes.
- Verify with the focused Vitest test, Control Room typecheck, lint, and a browser/layout smoke when the Chrome bridge is available.

---

### Task 1: Capture the footer sizing contract

**Files:**
- Modify: `apps/control-room/src/design/styles/designStyles.test.ts`
- Read: `apps/control-room/src/modules/footer/FooterModule.tsx`

- [x] Add a test that reads `src/design/styles/footer.css` and `src/modules/footer/FooterModule.tsx` and asserts the footer content is a constrained column flex container, the log content can consume remaining height, and Tailwind containment utilities constrain single-root footer panels.
- [x] Run the focused design-style test and confirm it fails against the current two-row `.fm-footer__content` rule.

### Task 2: Fix the footer containment hierarchy

**Files:**
- Modify: `apps/control-room/src/design/styles/footer.css`
- Modify: `apps/control-room/src/modules/footer/FooterModule.tsx`

- [x] Replace the generic two-row grid on `.fm-footer__content` with `display: flex`, `flex-direction: column`, `overflow: hidden`, and `flex: 1 1 auto`.
- [x] Keep `.fm-footer__filters` and `.fm-footer__log-content` as the logs tab's vertical sections, with `.fm-footer__log-content` consuming remaining space and `.fm-footer-log` taking the final flexible row.
- [x] Add Tailwind utility classes to the tab content and a small containment wrapper around telemetry, recorder, diagnostics, and mesh roots so each single-panel tab gets a bounded flex child without a module-to-module dependency.
- [x] Run the focused design-style test and confirm it passes.

### Task 3: Run frontend verification

**Files:**
- No additional files.

- [x] Run the focused footer/design tests.
- [x] Run `pnpm --dir apps/control-room typecheck`.
- [x] Run `pnpm --dir apps/control-room lint` and the changed-file lint; record unrelated existing lint errors separately.
- [ ] Inspect the diff and run a browser/layout smoke against `/workspace`; check that the telemetry strip, metrics region, status bar, and footer bottom edge have nonzero, non-overlapping boxes. Blocked because the Chrome bridge fails before browser initialization with the workspace `sandboxCwd` error.
