# Reference components

React 19 + TypeScript + Tailwind v4, written against the conventions already in
`apps/control-room`: `--fm-*` tokens through the `@theme inline` bridge, `cn()`
from `@/shared/utils/className`, `cva` for variants, `lucide-react` icons, and
the existing `Button` from `@/shared/ui/Button`.

These files do not compile in this folder — they import from `@/shared/*`, which
only resolves inside the app. They are written to be **moved**, not adapted:
copy them to `src/modules/start/` per `docs/02-implementation-guide.md` §2 and
the imports resolve as-is.

| File | What it is | Why it is in this set |
|---|---|---|
| `types.ts` | Types mirroring both JSON schemas | The contract everything else is written against |
| `recentIndex.ts` | Parse, filter, sort, group, format | Pure, framework-free, and the part with real edge cases |
| `ProjectBadges.tsx` | `SolverBadge`, `StatusPill` | Encodes the "colour is never alone" rule |
| `ProjectRow.tsx` | One recent-list entry | The densest component; selection vs activation lives here |
| `ContinueCard.tsx` | The interrupted run | The screen's primary idea |
| `ContextBanner.tsx` | Inspector banner + `selectBanner` | The one-banner priority rule, as testable logic |
| `StartScreen.tsx` | Shell: rail, content, inspector | Layout, keyboard map, compute widget |

Section bodies, the inspector tabs and the templates gallery are specified in
`docs/01-design-spec.md` and visible in `mockups/start-screen.html`; they are
straightforward once the pieces above are in place, so they are not duplicated
here.

## Worth knowing before you copy

**`recentIndex.ts` is where the tests go.** `groupByRecency` compares
day-start timestamps rather than subtracting fixed millisecond amounts, so it
stays correct across local midnight and across a DST change, where a local day
is 23 or 25 hours. It also hoists pinned entries out of their date group and
treats a future timestamp (clock skew, a file copied from another machine) as
"today" rather than letting it fall through to "older". All three behaviours are
easy to break and invisible in a screenshot.

**`parseRecentIndex` never throws.** The index is derived state: a malformed one
returns `{ kind: "error" }` and the UI offers a rebuild. This is what lets the
error state in the design be a banner rather than a crash.

**`selectBanner` is pure and ordered.** Missing file → running → failed →
migration → read-only. Keeping the priority in a function rather than in JSX is
what stops a sixth condition from quietly stacking a second banner.

**`ContinueCard` never renders a button that will fail.** When
`session.resumable` is false the primary action is removed and the reason
replaces the ETA line.

**Three primitives want promoting to `shared/ui/`** once this lands, because the
workspace inspectors hand-roll them already: `StatusPill`, `KeyValueGrid` (the
inspector's `dl` layout) and `Timeline` (used by both the History tab and the
release notes in Learn).

## Tokens

`ProjectBadges.tsx` uses `text-fm-solver-fdm`, `text-fm-project-running` and
friends. Those utilities exist only after the bridge block at the bottom of
`tokens/start-screen.tokens.css` is appended to the `@theme inline` in
`src/design/styles/tailwind-theme.css`. Until then the classes are inert and the
badges render in the inherited colour — visible but wrong, so do that first.
