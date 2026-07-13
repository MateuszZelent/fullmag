# F3D-027 report: resource-first hygiene gate correctness

## Scope

Repaired only the false-positive patterns documented in F3D-027 while retaining
the gates' ability to block direct browser transport and legacy preview paths.

- `fetch` now matches an identifier boundary in both gates, so `refetch()` and
  `noopRefetch()` are not treated as direct transport.
- The API hygiene check recognises a quoted `/preview/` path segment, rather
  than arbitrary `preview-` or `preview/` text in CSS/UI identifiers.
- The strict migration gate recognises `/preview/` as an endpoint or import
  path segment, rather than matching harmless UI/CSS names.

No OpenAPI, generated transport, API facade, resource hook, event, codec, or
runtime behavior changed. HTTP v2 remains authoritative and the gates continue
to prohibit component-level direct `fetch` outside allowlisted API layers.

## TDD evidence

### RED

```bash
bash scripts/test-resource-first-gates.sh
```

Before the production change this failed at the clean API fixture:

```text
FAIL: clean/api returned 1, expected 0:
API hygiene check failed: legacy live/bootstrap/poll/preview path
src/data-preview.css:.fm-data-preview-button {
```

The same fixture invokes `refetch()` and `noopRefetch()`; the pre-fix strict
pattern matched their `fetch(` suffix. The legacy-preview-import fixture also
proved that the pre-fix strict gate returned zero instead of detecting an
import path containing `/legacy/preview/`.

### GREEN

```bash
bash scripts/test-resource-first-gates.sh
pnpm --dir apps/control-room check:api-hygiene
./scripts/ci-resource-first-gates.sh --strict
pnpm --dir apps/control-room exec eslint scripts/check-api-hygiene.mjs
git diff --check
```

The executable fixture harness passes both real scripts against:

- negative `refetch()`, `noopRefetch()`, and `.fm-data-preview-button` cases;
- positive direct `fetch(...)` case;
- positive `/v2/.../preview/...` legacy endpoint case;
- positive `legacy/preview` import case.

The real worktree API hygiene and strict resource-first gates both pass.
