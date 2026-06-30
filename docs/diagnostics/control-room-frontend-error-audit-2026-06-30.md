# Control Room frontend error audit - 2026-06-30

## Scope

Target: `apps/control-room` on the current working tree.

This audit was started after two browser-visible React errors were reported in
the inspector:

- `Maximum update depth exceeded`
- `Received false for a non-boolean attribute invalid`

Those two reported issues were addressed separately in the current working tree.
This audit looks for other frontend errors and guardrail failures without making
additional code changes.

An existing Next.js dev server was already running at
`http://localhost:3100/workspace`; it was reused for browser smoke checks. No
server process was stopped.

## Summary

The basic local quality gates pass: TypeScript, ESLint, Vitest, and the static
idle-performance audit are green. The frontend is not shippable yet because two
governance gates fail and `smoke:study-authoring-ui` fails in browser workflow
coverage.

The highest-priority finding is the failing Study authoring smoke. It times out
when selecting both Hysteresis and frequency-domain result nodes, so it should
be treated as a real workflow regression or a stale smoke contract until the
inspector routing and fixture expectations are reconciled.

## Gate Results

| Gate | Result | Evidence |
| --- | --- | --- |
| `pnpm --dir apps/control-room typecheck` | PASS | Completed successfully. |
| `pnpm --dir apps/control-room lint` | PASS | Completed successfully. |
| `pnpm --dir apps/control-room test` | PASS | 300 files, 2608 tests. |
| `pnpm --dir apps/control-room audit:idle-performance` | PASS | Static idle render-loop scan passed. |
| `pnpm --dir apps/control-room check:architecture-hygiene` | FAIL | Cross-module Explorer -> Inspector imports; raw viewport hex colors. |
| `pnpm --dir apps/control-room check:api-hygiene` | FAIL | Hand-built `/v2/.../response-map.v2` literals in an Explorer test fixture. |
| `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d` | PASS | No browser console/page errors captured; WebGL/canvas checks passed. |
| `pnpm --dir apps/control-room smoke:study-authoring-ui` | FAIL | Timeout waiting for Hysteresis `Live Progress` inspector. |
| `CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 pnpm --dir apps/control-room smoke:study-authoring-ui` | FAIL | Timeout waiting for `Modal Spectrum` heading. |
| `npx -y react-doctor@latest apps/control-room --verbose --diff` | BLOCKED | Escalation rejected: unpinned third-party code execution. |

## Findings

### CR-FE-001 - Study authoring browser smoke fails on inspector routing

Severity: High

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Failure:

```text
locator.waitFor: Timeout 60000ms exceeded.
waiting for locator('.fm-inspector').getByText('Live Progress') to be visible
at assertHysteresisChildInspectors
apps/control-room/scripts/smoke-study-authoring-ui.mjs:1039
```

The smoke adds a Hysteresis stage, clicks
`model:study:stages:stage:hysteresis-3:live-run`, and expects the Inspector to
show `Live Progress`. The source still contains the expected panel title in
`apps/control-room/src/modules/inspector/panels/stages/hysteresis/HysteresisLiveProgressInspector.tsx:39`,
and the Hysteresis view resolver maps `:live-run` to `live-run` in
`apps/control-room/src/modules/inspector/panels/stages/hysteresis/HysteresisInspectorUtils.ts:41`.

That makes this a confirmed browser workflow failure, but not yet a confirmed
component-level root cause. The likely causes are:

- the Explorer click does not update the active selection to the expected node,
- the selected stage model is not synchronized with the newly added stage when
  the inspector renders,
- the smoke fixture creates a node that no longer matches the production
  inspector contract,
- or an intermediate render error prevents the expected inspector panel from
  becoming visible.

Recommended fix path:

1. Add a focused test around selecting
   `model:study:stages:stage:<id>:live-run` and resolving the Hysteresis
   inspector view.
2. Instrument or assert the active selection after the smoke click.
3. Fix the selection/model synchronization if the selection is wrong.
4. If the UI contract intentionally changed, update the smoke expectation and
   add a lower-level test proving the new contract.

Verification after fix:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

### CR-FE-002 - Frequency-only Study smoke fails on Modal Spectrum

Severity: High

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Failure:

```text
locator.waitFor: Timeout 60000ms exceeded.
waiting for locator('.fm-inspector').getByRole('heading', {
  name: 'Modal Spectrum',
  exact: true
}) to be visible
at verifyFrequencyDomainModalResults
apps/control-room/scripts/smoke-study-authoring-ui.mjs:465
```

The smoke expands `results:frequency-domain:fmr`, clicks
`results:frequency-domain:fmr:modal-spectrum`, and expects the Inspector to show
the Modal Spectrum result panel. The dedicated frequency-domain panel registry
still maps named frequency-domain kinds to dedicated components in
`apps/control-room/src/modules/inspector/inspectorRegistry.tsx:390`.

This is separate from the Hysteresis timeout and points to broader drift between
Explorer result nodes, active selection, and Inspector panel rendering in the
Study authoring smoke fixture.

Recommended fix path:

1. Check whether the modal-spectrum result node is present and selectable after
   the fixture data loads.
2. Assert the selection ref produced by
   `apps/control-room/src/modules/explorer/explorerSelection.ts` for that node.
3. Reconcile the smoke fixture with the current frequency-domain result
   manifest if the node is stale.

Verification after fix:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

### CR-FE-003 - Explorer imports Inspector internals

Severity: Medium

`pnpm --dir apps/control-room check:architecture-hygiene` fails because
Explorer imports sibling Inspector internals:

- `apps/control-room/src/modules/explorer/ExplorerModule.tsx:41`
  imports `@/modules/inspector/extensions/ObjectExtensionsSectionModel`
- `apps/control-room/src/modules/explorer/ExplorerModule.tsx:44`
  imports `@/modules/inspector/extensions/useObjectExtensionActivation`

This violates the v2 module boundary doctrine: modules should communicate
through kernel APIs, resource hooks, shared domain models, or shared primitives,
not by importing another module's private extension state. The imported hook also
owns mutable module-local state, which increases render-coupling risk between
Explorer and Inspector.

Recommended fix path:

- Move the shared object-extension view model and activation snapshot into a
  shared domain/kernel location, or expose it through a small kernel-facing
  contribution API.
- Keep Inspector-specific rendering primitives inside Inspector.

Verification after fix:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
```

### CR-FE-004 - Raw viewport colors bypass design tokens

Severity: Medium

`pnpm --dir apps/control-room check:architecture-hygiene` also fails on raw
`#ffffff` usage in runtime viewport code:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1535`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:555`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:1190`

Runtime viewport code should consume the central `--fm-*` token-derived color
model. Hardcoded colors create theme drift and make dark/light mode behavior
harder to audit.

Recommended fix path:

- Replace raw fallback colors with token-derived viewport colors or a central
  fallback in the viewport color model.
- Run a viewport browser gate because color changes affect rendered output.

Verification after fix:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

### CR-FE-005 - API hygiene gate fails on hand-built v2 endpoint literal

Severity: Medium

`pnpm --dir apps/control-room check:api-hygiene` fails on:

- `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts:3284`
- `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts:3311`

Both locations hardcode:

```text
/v2/sessions/current/analysis/frequency-domain/response-map.v2
```

The occurrence is in a test fixture, not a runtime component, but it still
blocks the resource-first API hygiene gate and normalizes endpoint strings
outside the API path layer.

Recommended fix path:

- Use the central API path constant if this endpoint exists there.
- If it does not exist, add the path to the API path layer or change the fixture
  to model the resource key without embedding a raw endpoint.

Verification after fix:

```bash
pnpm --dir apps/control-room check:api-hygiene
```

### CR-FE-006 - Viewport smoke passes but startup has long tasks and high request fan-out

Severity: Low

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Functional result: pass. The smoke captured no browser console/page errors and
passed visible canvas, WebGL context, nonzero drawing buffer, nonblank pixel,
camera gesture, projection, and dimension-frame checks.

Performance warning from the same run:

- startup phase: `longAnimationFrameCount=14`, `longTaskCount=10`,
  `maxLongTaskMs=566`, `phaseElapsedMs=8185`, `sessionRequestCount=300`
- full smoke: `longAnimationFrameCount=29`, `longTaskCount=16`,
  `maxLongTaskMs=566`, `sessionRequestCount=837`

This is not a functional failure, but it is a startup responsiveness risk and
should be tracked before treating the viewport as production-smooth.

Recommended follow-up:

- Run a targeted profile with request attribution.
- Check whether session-resource fan-out can be staged or deduplicated during
  `/workspace` startup.

Useful commands:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d

CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 \
CONTROL_ROOM_SCREENSHOT_SCENES=fdm \
pnpm --dir apps/control-room screenshot:viewport-3d
```

### CR-FE-007 - React Doctor was not run

Severity: Informational

The local command attempted was:

```bash
npx -y react-doctor@latest apps/control-room --verbose --diff
```

It was blocked by the approval reviewer because it would execute unpinned
third-party code with elevated permissions. This is the right outcome for the
current security posture.

Recommended fix path:

- Add a pinned React Doctor dependency/script to `apps/control-room` if this
  audit should become repeatable.
- Or explicitly approve the one-off external execution with the security tradeoff
  understood.

## Negative Evidence

The static pass did not find direct `fetch(` usage under `apps/control-room/src`.
That supports the current resource-hook/API-facade direction.

The viewport browser smoke did not capture the originally reported React console
errors after the current working-tree fixes for FormField and ObjectRegionsPanel.
Those fixes still need final review and commit hygiene, but they were not
expanded by this audit.

## 2026-06-30 Follow-Up: Maximum Update Depth Recheck

The `Maximum update depth exceeded` error was rechecked against a fresh local
Next.js 16.2.6 dev server on `http://localhost:3102/workspace`.

Additional evidence:

- `FormField.tsx` has no effect or state setter; it maps the Inspector-only
  `invalid` prop to `aria-invalid` and strips wrapper props before spreading DOM
  props.
- `PhysicalScalarField` in `ObjectRegionsPanel.tsx` is the nearest write-back
  path in the reported stack. It now buffers text locally and calls
  `onValueChange(parsed)` only when `!Object.is(parsed, value)`.
- A subagent independently checked the same path and did not find a current
  render-time setter loop in `FormField.tsx` or `ObjectRegionsPanel.tsx`.
- Targeted Vitest commands for `ObjectRegionsPanel`, `FormField`, and
  `ResourceRuntimeStore` passed.
- Browser smoke with Playwright required unsandboxed execution because Chromium
  cannot launch inside the current process sandbox. The fresh dev-server run did
  not emit `Maximum update depth exceeded` in `.next/dev/logs/next-development.log`.

Current interpretation:

- The originally reported depth loop is most likely either already fixed in the
  current source by the scalar write-back guard, or was observed from a stale
  browser/dev-server bundle.
- It is not yet proven impossible, because the full Study authoring smoke still
  fails later on the Hysteresis `Live Progress` expectation. That failure is a
  separate workflow contract failure and remains the active High-severity item.

Regression coverage still needed:

- Add a real client-render interaction test for `PhysicalScalarField` when a
  DOM-capable Vitest environment is available. The test should render
  `value={1e-9}`, edit the input to an equivalent string such as `1e-9` or
  `0.000000001`, and assert that `onValueChange` is not called.
- Until jsdom/happy-dom is available in the package, keep the existing static
  source test that asserts the `Object.is(parsed, value)` guard is present.

## Recommended Fix Order

1. Keep the `Object.is(parsed, value)` guard in `PhysicalScalarField` and add
   client-render regression coverage when the test environment supports it.
2. Fix or update `smoke:study-authoring-ui` for both Hysteresis child inspectors
   and frequency-domain modal-spectrum selection.
3. Repair `check:architecture-hygiene`: move Explorer's Inspector imports out of
   the module boundary and replace raw viewport colors with token-derived
   colors.
4. Repair `check:api-hygiene` by removing the raw response-map endpoint fixture.
5. Add a pinned React Doctor command if React Doctor is expected to be part of
   the standard frontend audit.
6. Profile `/workspace` startup fan-out after functional browser smokes are
   stable.

## Current Shippability

Not shippable for `apps/control-room` yet. The pass/fail baseline is mixed:
core compile/lint/test gates pass, but API/architecture hygiene and Study
authoring browser smoke fail.
