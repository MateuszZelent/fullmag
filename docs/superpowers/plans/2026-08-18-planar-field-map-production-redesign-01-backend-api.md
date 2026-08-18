# Plan wdrożenia backendu i API mapy pola 2D

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` albo `executing-plans`. Każda nowa zmiana zachowania zaczyna się od focused RED, a zakończony task wymaga wąskiego commitu i review.

**Cel:** Zachować naprawiony niezerowy default FDM slice, domknąć canonical sparse planar overrides oraz udowodnić rozdział presentation-state identity od planar data-plane identity.

**Architektura:** `resolve_default_planar_source` snapuje wyłącznie normalną oś structured FDM do środka komórki. Bieżące pole pozostaje własnością `resolve_current_spatial_field`. Tożsamości prezentacyjne pochodzą z istniejącego `VisualizationTargetRegistryState`; `PlanarTargetPresentationOverrideState` jest sparse style record, a nie nowym sampling targetem ani profilem danych.

**Tech Stack:** Rust, Axum, Serde, Utoipa/OpenAPI v2, PNG export, Cargo tests i generated TypeScript contract.

## Global Constraints

- Nie dodawaj drugiego planar target union, kolekcji pełnych profili per target, osobnej listy z-order ani nowego target registry.
- Backend akceptuje planar override tylko dla `VisualizationScopeKind::{Airbox,Object,Part}`.
- Exact identity to `(scope, scope_id)`; nigdy label, suffix, array index ani Explorer selection.
- `planar.wireframe_style` jest globalnym fallbackiem i nie jest przepisywany podczas target patch.
- Supplied `target_overrides` zastępuje pełną listę; omission jest no-op.
- PATCH odrzuca identity nieobecną w bieżącym registry. Persisted identity usunięta przez późniejszą scene/mesh revision pozostaje dormant i nie jest automatycznie usuwana.
- Override zmienia wyłącznie wireframe presentation. Quantity, component, range, opacity rastera, layers, frame, operator i resolution nie stają się per-target.
- Scalar/vector/mask/mesh-overlay ETags i `sample_token` nie zawierają stylu.
- Styled `render.png` zawiera effective presentation identity i zmienia ETag razem ze stylem.
- `ArtifactLinear` nie jest spatial carrierem; brak mappingu lub mismatch kończy się 409/422, nigdy syntetycznym zerem.
- Prawidłowe fizyczne zero pozostaje HTTP 200 i nie jest utożsamiane z brakiem danych.
- Generated OpenAPI nie jest edytowane ręcznie.

---

### Zadanie 1: RED granicy środkowej komórki FDM — zakończony

**Pliki:**
- Modified: `crates/fullmag-api/src/router_v2/tests.rs`
- Inspected: `crates/fullmag-api/src/planar_sampling/source.rs`
- Inspected: `crates/fullmag-api/src/planar_sampling/fdm.rs`

**Produces:** `planar_default_fdm_even_depth_uses_cell_centered_midplane`.

- [x] Fixture ma grid `[2,2,2]`, origin `[-1,-1,-1]`, spacing `[1,1,1]`, niezerową dolną i zerową górną warstwę.
- [x] Test sprawdza field meta, planar meta, canonical scalar link i FMVP.
- [x] RED wystąpił na `frame.origin_m[2] == 0.0` zamiast `-0.5`, nie na statusie HTTP ani dekoderze.
- [x] Commit: `b1464b481 test: reproduce planar FDM midplane boundary bug`.

### Zadanie 2: Snap default FDM slice do środka komórki — zakończony

**Pliki:**
- Modified: `crates/fullmag-api/src/planar_sampling/source.rs`

**Interfaces:**
- Consumes: `DomainMeta.discretization`, `DomainMeta.grid`, `DefaultPlanarSliceState.plane`, `position_fraction`.
- Produces: efektywną ramę ze środkiem wybranej komórki na osi normalnej.

- [x] Indeks structured FDM jest `ceil(q*n)-1`, ograniczony do `[0,n-1]`; granica należy do niższej komórki.
- [x] Koordynata jest `origin + (index + 0.5) * spacing`.
- [x] Snap dotyczy tylko normalnej osi FDM; extent nadal pokrywa pełne bounds.
- [x] FEM i domena bez structured grid zachowują ciągłe `min + q*length`.
- [x] Shape zero, niedodatni/niefinity spacing, niespójne bounds i overflow są odrzucane.
- [x] Testy `xy/xz/yz`, parzystego/nieparzystego shape oraz `q=0,0.5,1` przechodzą.
- [x] Commity: `a750062ca`, `d47029f97`.

### Zadanie 3: Source parity i legalne zero — zakończony

**Pliki:**
- Modified: `crates/fullmag-api/src/router_v2/tests.rs`
- Verified: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Verified: `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`
- Verified: `crates/fullmag-api/src/router_v2/handlers/data/resolved_spatial_field.rs`

**Produces:** `source_parity_across_meta_vector_and_planar`.

- [x] Test porównuje quantity revision, generation, field stats, FMVP headers i wartości przeciętej warstwy.
- [x] Vector i planar korzystają z `resolve_current_spatial_field`; nie powstał drugi resolver.
- [x] Osobne ścieżki persisted snapshot, native layer, Airbox i steady transport artifact zostały zachowane.
- [x] Test nie wykazał drugiego source-selection defectu.
- [x] Commit: `48ed0c3f6 test: lock planar field source parity`.

### Zadanie 4: Zatwierdź kanoniczny kontrakt prezentacji targetu — zakończony

**Pliki:**
- Modified: `docs/adr/0020-planar-field-map-and-monitor.md`
- Modified: `docs/specs/frontend-v2/15-viewport-2d-module.md`
- Modified: `docs/specs/resource-first-control-room-api-v2.md`

- [x] Dokumenty wskazują `visualization.targets` jako jedyny registry.
- [x] Kontrakt dopuszcza tylko `airbox | object | part`.
- [x] Zdefiniowano sparse `target_overrides`, global fallback, replacement PATCH i exact IDs.
- [x] Zdefiniowano dormant diagnostic, exact reactivation i zakaz silent prune/remap.
- [x] Zdefiniowano ETag separation oraz rollback bez usuwania ustawień.
- [x] Commit: `b01cbb807 docs: define planar target presentation overrides`.

### Zadanie 5: Backend schema i visualization API — zakończony

**Pliki:**
- Modified: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modified: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modified: `crates/fullmag-api/src/router_v2/tests.rs`

**Published interface:**

~~~rust
#[serde(deny_unknown_fields)]
pub struct PlanarTargetPresentationOverrideState {
    pub scope: VisualizationScopeKind,
    pub scope_id: String,
    pub wireframe_style: PlanarWireframeStyleState,
}
~~~

- [x] `PlanarVisualizationState.target_overrides` ma `#[serde(default)]`.
- [x] `PlanarVisualizationPatch.target_overrides` jest optional replacement field.
- [x] Validation odrzuca unsupported scope, blank ID, duplicate pair, invalid color/opacity i nieobecną registry identity.
- [x] Airbox, object i part są porównywane exact `scope + scope_id`.
- [x] Global `wireframe_style` pozostaje bez zmian podczas target replacement.
- [x] Usunięcie targetu po zapisie zachowuje dormant entry i diagnostic.
- [x] Powrót tej samej exact identity reaktywuje wpis; PATCH nowej nieobecnej identity pozostaje odrzucony.
- [x] Test schema-9-like payload bez listy daje pustą listę i zachowany fallback.
- [x] Commit: `2fb09e817 feat: isolate planar target presentation`.

### Zadanie 6: Wygenerowany kontrakt OpenAPI — zakończony

**Pliki:**
- Regenerated: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerated: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

- [x] Schema zawiera `PlanarTargetPresentationOverrideState` z required `scope`, `scope_id`, `wireframe_style`.
- [x] `PlanarVisualizationState.target_overrides` jest array; patch field pozostaje optional.
- [x] Generated TypeScript rozróżnia state i patch.
- [x] Commit: `5aafbe2cd chore: regenerate planar visualization API`.

### Zadanie 7: RED/GREEN — izolacja presentation identity od data-plane identity

**Status:** oczekuje. Nie uznawać istniejącego schema commitu za dowód tej bramki.

**Pliki:**

- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Inspect first: `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`
- Inspect first: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modify only if RED proves leakage: `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`
- Modify only if RED proves missing effective-style export: `crates/fullmag-api/src/field_render_png.rs`

**Exact symbols to inspect:**

- `get_planar_default_field_meta`
- `get_planar_default_field_scalar`
- `get_planar_default_field_vectors`
- `get_planar_default_empty_mask`
- `get_planar_default_mesh_overlay`
- `get_planar_default_render_png`
- `patch_visualization_state`
- `build_visualization_state_response`
- current helper that composes planar `sample_token`
- current helper that composes planar child-resource ETags

#### Krok 7.1 — snapshot identity matrix before mutation

- [ ] Extend the existing router fixture that already publishes `m` and `planar-default`; do not create a second mock router.
- [ ] Ensure the same fixture publishes registry entries for Airbox and object `film`.
- [ ] GET `/v2/sessions/current/visualization/state` and retain the complete JSON plus response ETag if present.
- [ ] GET `/v2/sessions/current/data/fields/m/planar-default/meta?component=magnitude&resolution_x=16&resolution_y=16`.
- [ ] Follow `meta.links.scalar`, `meta.links.vectors`, `meta.links.empty_mask`, `meta.links.mesh_overlay` and `meta.links.render_png`; do not reconstruct child paths inside the assertion helper.
- [ ] For every binary response retain status, content type, ETag, byte length and SHA-256.
- [ ] Retain `sample_token`, `field_revision`, `carrier_revision`, `source_revision`, `generation_id`, `scalar_min` and `scalar_max` from meta.

Add a test-local evidence record with all compared fields. This is test support, not a public runtime type:

~~~rust
#[derive(Debug)]
struct PlanarIdentityEvidence {
    sample_token: String,
    field_revision: String,
    carrier_revision: Option<String>,
    source_revision: Option<String>,
    generation_id: String,
    scalar_etag: String,
    vectors_etag: String,
    empty_mask_etag: String,
    mesh_overlay_etag: String,
    scalar_sha256: String,
    vectors_sha256: String,
    empty_mask_sha256: String,
    mesh_overlay_sha256: String,
    render_etag: String,
    render_sha256: String,
}
~~~

Do not reuse the visualization resource revision as any field in this record.

#### Krok 7.2 — write the first RED

Add exact test name:

~~~rust
#[tokio::test]
async fn planar_target_style_patch_does_not_change_sample_identity() {
    // Use the existing planar router fixture and existing response/body helpers.
    // Capture PlanarIdentityEvidence before the PATCH.
    // Replace only planar.target_overrides with an Airbox style.
    // Capture PlanarIdentityEvidence after the PATCH.
    // Assert all non-render fields and binary hashes are identical.
    // Assert visualization state changed exactly once.
}
~~~

The PATCH body is exact and contains no sampling field:

~~~json
{
  "planar": {
    "target_overrides": [
      {
        "scope": "airbox",
        "scope_id": "airbox",
        "wireframe_style": {
          "color": "#ff0000",
          "opacity": 0.35
        }
      }
    ]
  }
}
~~~

Required assertions:

- [ ] before/after `sample_token` equal;
- [ ] field/carrier/source revisions and generation equal;
- [ ] scalar/vector/mask/mesh-overlay ETags equal;
- [ ] scalar/vector/mask/mesh-overlay SHA-256 equal;
- [ ] visualization resource body differs only in presentation state plus its documented revision/diagnostics;
- [ ] response is not accepted if it silently modifies global `planar.wireframe_style`.

Run:

~~~bash
cargo test -p fullmag-api planar_target_style_patch_does_not_change_sample_identity -- --exact --nocapture
~~~

Oczekiwany RED: an equality assertion fails only if presentation state leaks into sample identity or a child-resource ETag. If the test passes immediately, record that the implementation already satisfies this invariant and do not force a source diff.

#### Krok 7.3 — minimal GREEN for sample identity

- [ ] Trace the failing field to the helper composing `sample_token` or the affected child ETag.
- [ ] Remove only presentation style/revision from that fingerprint.
- [ ] Preserve quantity, component, frame, bounds, resolution, topology, generation, carrier revision and source revision.
- [ ] Do not cache around the failure and do not suppress invalidation globally.
- [ ] Re-run the exact RED command.
- [ ] Run the existing planar child-resource identity tests next.

Oczekiwany GREEN: exact test PASS; existing stale-token and mismatch tests remain PASS.

#### Krok 7.4 — write the styled PNG RED

Add exact test name:

~~~rust
#[tokio::test]
async fn planar_render_png_etag_tracks_only_effective_target_style() {
    // Capture default render.png for Airbox and object/film.
    // Patch only Airbox wireframe style.
    // Assert Airbox render ETag and bytes change.
    // Assert object/film render ETag and bytes remain identical.
    // Assert every data-plane identity from Step 7.2 remains identical.
}
~~~

Required fixture state:

- Airbox and object `film` must both exist in `visualization.targets`;
- global fallback must be visibly different from both target styles;
- rendered wireframe must intersect at least one non-background pixel;
- raster range and colormap remain fixed.

Oczekiwany RED: either Airbox PNG bytes do not change, or object PNG changes despite no effective object-style change. A changed ETag with identical PNG bytes is also RED.

#### Krok 7.5 — minimal GREEN for render identity

- [ ] Resolve the export target to an existing registry identity only for `airbox`, `object` or `part`.
- [ ] Find an exact `(scope, scope_id)` override; otherwise use global `planar.wireframe_style`.
- [ ] Keep unsupported and missing targets on global fallback.
- [ ] Build the render fingerprint from sample ETag, effective color, effective opacity, global render options and explicit render-codec version.
- [ ] Draw the same effective style used in the fingerprint.
- [ ] Never include label, registry array index or whole visualization revision.

Run:

~~~bash
cargo test -p fullmag-api planar_render_png_etag_tracks_only_effective_target_style -- --exact --nocapture
cargo test -p fullmag-api planar_default_child_resources_share_meta_identity_and_resolve_probe_world_coordinate -- --exact --nocapture
~~~

Oczekiwany GREEN: both tests PASS; legal uniform zero still returns HTTP 200 and a valid PNG.

#### Krok 7.6 — task gate

~~~bash
cargo test -p fullmag-api planar_target_style_patch_does_not_change_sample_identity -- --exact --nocapture
cargo test -p fullmag-api planar_render_png_etag_tracks_only_effective_target_style -- --exact --nocapture
cargo test -p fullmag-api planar_default -- --nocapture
git diff --check
~~~

Record exact passed test count and any filtered count. Commit only files proven necessary by RED. Proponowany commit after review: `fix: isolate planar render style identity`.

### Zadanie 8: RED/GREEN — persistence, wpisy dormant i deterministyczne restore

**Status:** oczekuje.

**Pliki:**

- Modify: `crates/fullmag-api/src/session_persistence.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Inspect: `crates/fullmag-api/src/schemas/visualization_state.rs`

**Dokładne symbole:**

- `DISPLAY_PRESENTATION_SCHEMA_VERSION`
- `restore_display_presentation`
- `migrate_display_presentation_v9`
- serializer/deserializer tests adjacent to those symbols
- `build_visualization_state_response`

#### Krok 8.1 — legacy migration RED

Add exact test:

~~~rust
#[test]
fn display_presentation_v9_without_target_overrides_migrates_to_empty_schema_10_list() {
    // Deserialize the real v9 fixture through restore_display_presentation.
    // Preserve its non-default global wireframe style.
    // Assert schema 10 and an empty target_overrides list.
    // Assert every unrelated field equals the v9 fixture expectation.
}
~~~

Required fixture values:

~~~json
{
  "schema_version": 9,
  "visualization_planar": {
    "wireframe_style": {
      "color": "#123456",
      "opacity": 0.42
    }
  }
}
~~~

Oczekiwany RED: missing schema default or migration drops/normalizes the global fallback. Minimalny GREEN: add only the schema default/migration initialization required to produce `target_overrides: []`; do not manufacture per-target entries.

Run:

~~~bash
cargo test -p fullmag-api display_presentation_v9_without_target_overrides_migrates_to_empty_schema_10_list -- --exact --nocapture
~~~

#### Krok 8.2 — active plus dormant round-trip RED

Add exact test:

~~~rust
#[test]
fn display_presentation_v10_preserves_active_and_dormant_planar_overrides() {
    // Serialize and restore ordered Airbox, object and removed-part entries.
    // Compare the complete target_overrides JSON value before/after.
}
~~~

Fixture order and values:

~~~json
[
  {
    "scope": "airbox",
    "scope_id": "airbox",
    "wireframe_style": {"color": "#ff0000", "opacity": 0.35}
  },
  {
    "scope": "object",
    "scope_id": "film",
    "wireframe_style": {"color": "#00ff00", "opacity": 0.90}
  },
  {
    "scope": "part",
    "scope_id": "removed-part",
    "wireframe_style": {"color": "#0000ff", "opacity": 0.60}
  }
]
~~~

Assertions:

- [ ] ordered array equal before/after;
- [ ] color strings and opacity values exact;
- [ ] dormant entry not dropped during deserialize;
- [ ] global fallback unchanged;
- [ ] no label, selection or registry snapshot persisted in override;
- [ ] GET after restore reports dormant diagnostic without mutating state;
- [ ] unrelated Airbox PATCH preserves dormant entry exactly.

Oczekiwany RED: only an actual loss, reorder, validation-at-restore or mutation can fail. Minimalny GREEN: persistence stores the sparse list verbatim; registry membership is evaluated in the read model, not deserialization.

Run:

~~~bash
cargo test -p fullmag-api display_presentation_v10_preserves_active_and_dormant_planar_overrides -- --exact --nocapture
cargo test -p fullmag-api visualization_planar_target_overrides -- --nocapture
~~~

#### Krok 8.3 — task gate

~~~bash
cargo test -p fullmag-api session_persistence -- --nocapture
cargo test -p fullmag-api visualization_planar_target_overrides -- --nocapture
git diff --check
~~~

Oczekiwany GREEN: all selected tests PASS and the schema version stays exactly the current repository value. Do not bump it without a new migration test. Proponowany commit: `test: preserve planar target overrides across restore`.

### Zadanie 9: Determinizm generated contract i higiena architektury

**Status:** oczekuje; generated commit `5aafbe2cd` is present, but determinism and negative architecture gates are not yet recorded.

**Pliki:**

- Verify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Verify: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Verify: `apps/control-room/src/kernel/api/openapiV2GeneratedContract.test.ts`
- Verify: `apps/control-room/src/kernel/api/apiTypes.ts`

#### Krok 9.1 — deterministic generation

~~~bash
pnpm --dir apps/control-room generate:api
git diff --exit-code -- \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
pnpm --dir apps/control-room generate:api
git diff --exit-code -- \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
~~~

Oczekiwany GREEN: both diff commands exit 0. A generated diff is a contract change to review; it must not be hand-edited away.

#### Krok 9.2 — positive allowlist gate

Poprawne symbole muszą istnieć, dlatego jest to jawnie niepusty skan dodatni:

~~~bash
rg -n \
  'PlanarTargetPresentationOverrideState|target_overrides|VisualizationTargetRegistryEntry|VisualizationTargetRegistryState' \
  crates/fullmag-api/src/schemas/visualization_state.rs \
  crates/fullmag-api/src/router_v2/handlers/visualization/display.rs \
  crates/fullmag-api/src/router_v2/tests.rs \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/kernel/api/openapiV2GeneratedContract.test.ts
~~~

Oczekiwany GREEN: exit 0 and matches only in the listed files. This scan must never be described as expected-empty.

For an executable repository-wide allowlist:

~~~bash
rg -l \
  'PlanarTargetPresentationOverrideState|target_overrides' \
  crates/fullmag-api/src apps/control-room/src \
  | rg -v \
  '^(crates/fullmag-api/src/(schemas/visualization_state\.rs|router_v2/handlers/visualization/display\.rs|router_v2/tests\.rs)|apps/control-room/src/kernel/api/(generated/openapi-v2\.(json|types\.ts)|openapiV2GeneratedContract\.test\.ts)|apps/control-room/src/kernel/visualization/planarTargetPresentation(\.test)?\.ts|apps/control-room/src/modules/(inspector/visualization|field-map)/)' \
  && exit 1 || true
~~~

Oczekiwany GREEN: no unexpected path printed. If a new legitimate owner appears, add that exact path after review; do not widen to an entire unrelated tree.

#### Krok 9.3 — negative architecture gate

Do ujemnego wyrażenia należą wyłącznie zakazane równoległe modele:

~~~bash
if rg -n \
  'PlanarOverrideIdentity|PlanarOverrideSelectionResolution|PlanarPresentationTarget|PlanarTargetRegistry|planarTargetZOrder|activePlanarTarget|perTarget(Quantity|Range|Raster|Layer)' \
  apps/control-room/src crates/fullmag-api/src; then
  echo 'forbidden parallel planar target model found' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: `rg` itself exits 1 and prints no source match. Matches in this plan document are outside the scanned source roots.

#### Krok 9.4 — generated contract test

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/openapiV2GeneratedContract.test.ts
~~~

Oczekiwany GREEN: test PASS and asserts exact required fields `scope`, `scope_id`, `wireframe_style`; state list required/defaulted according to generated schema; patch list optional replacement. No empty generated diff is committed.

### Zadanie 10: Bramka A — live fixture, dokładne requesty i niezależny dekoder FMVP

**Status:** oczekuje. Unit/integration tests do not replace this proof.

**Pliki:**

- Create: `apps/control-room/scripts/lib/decode-fmvp.mjs`
- Create: `apps/control-room/scripts/lib/decode-fmvp.test.mjs`
- Create: `apps/control-room/scripts/qualify-planar-live-api.mjs`
- Modify: `apps/control-room/package.json` only to expose `qualify:planar-api`
- Create evidence: `.superpowers/sdd/planar-redesign-backend-api-evidence.md`
- Create evidence payload directory under the existing smoke output root; do not commit binary bodies unless repository policy explicitly allows it.

**Owner launchera fixture:** existing `justfile` recipe `run-viewport-2d-default-slice-smoke` and fixture `examples/viewport_2d_default_slice_fdm_smoke.py`.

Canonical manual launcher:

~~~bash
just run-viewport-2d-default-slice-smoke fdm cpu 3196 8196
~~~

The convenience alias `just run-viewport-2d-default-slice-smoke-fdm-cpu` is acceptable only if it resolves to the same recipe. Do not replace this managed launcher with host `cargo run`.

#### Krok 10.1 — decoder RED

`decode-fmvp.test.mjs` builds bounded in-memory buffers for:

- valid scalar FMVP, two finite nonzero values and one zero;
- valid uniform-zero scalar FMVP;
- bad magic;
- unsupported version;
- truncated header;
- product-of-shape overflow;
- payload length mismatch;
- NaN/Infinity payload.

Complete public surface:

~~~javascript
export function decodeFmvp(arrayBuffer) {
  // Validate magic, version, kind, scalar component count, dimensions,
  // declared element count and exact byte length before constructing the view.
  // Return immutable metadata and a Float64Array view/copy according to the codec.
}

export function summarizeFinite(values) {
  let finiteCount = 0;
  let nonzeroCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    finiteCount += 1;
    if (value !== 0) nonzeroCount += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return Object.freeze({
    sampleCount: values.length,
    finiteCount,
    nonzeroCount,
    min: finiteCount === 0 ? null : min,
    max: finiteCount === 0 ? null : max,
  });
}
~~~

The byte offsets, endianness and version rules must be copied from the existing TypeScript codec `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts`, not guessed. The Node helper remains smoke tooling; browser modules continue using the typed frontend codec.

Run RED:

~~~bash
node --test apps/control-room/scripts/lib/decode-fmvp.test.mjs
~~~

Oczekiwany RED: module-not-found. Minimalny GREEN: implement only validated scalar decoding and finite summary required by live proof. Oczekiwany GREEN: all malformed fixtures reject with stable error classes/messages and valid fixtures decode exactly.

#### Krok 10.2 — live request sequence

`qualify-planar-live-api.mjs` accepts:

~~~text
--api-base http://127.0.0.1:8196
--quantity m
--output-dir <existing smoke output directory>
~~~

It performs this exact sequence:

1. `GET /v2/sessions/current/status` and records session/run/backend/device/precision/generation provenance.
2. `GET /v2/sessions/current/data/fields/m/meta` and records field range/revision/source.
3. `GET /v2/sessions/current/data/fields/m/planar-default/meta?component=magnitude&resolution_x=64&resolution_y=64`.
4. Reads the canonical scalar URL from `planarMeta.links.scalar`; rejects absent or cross-origin links.
5. GETs the canonical scalar link with `Accept: application/octet-stream`.
6. Decodes bytes with `decodeFmvp`; computes SHA-256 with `node:crypto`.
7. GETs `meta.links.vectors`, `meta.links.empty_mask`, `meta.links.mesh_overlay` and `meta.links.render_png`, recording status, content type, ETag, length and SHA-256.
8. `GET /v2/sessions/current/visualization/state` and retains its exact pre-PATCH body.
9. PATCHes `/v2/sessions/current/visualization/state` with only the complete replacement `planar.target_overrides` list derived from that GET plus the changed Airbox entry.
10. Repeats steps 3–7 and compares presentation/data identity matrix.

Do not hand-construct child data URLs after step 3. Direct URLs are permitted in this external qualification script; React modules remain forbidden from doing so.

The live script must fail unless:

~~~javascript
assert.equal(summary.sampleCount, planarMeta.shape[0] * planarMeta.shape[1]);
assert.equal(summary.finiteCount, summary.sampleCount);
assert.ok(summary.nonzeroCount > 0);
assert.ok(Math.abs(summary.min - planarMeta.scalar_min) <= numericTolerance);
assert.ok(Math.abs(summary.max - planarMeta.scalar_max) <= numericTolerance);
assert.equal(after.sample_token, before.sample_token);
assert.equal(after.scalar.etag, before.scalar.etag);
assert.equal(after.scalar.sha256, before.scalar.sha256);
assert.equal(after.vectors.etag, before.vectors.etag);
assert.equal(after.emptyMask.etag, before.emptyMask.etag);
assert.equal(after.meshOverlay.etag, before.meshOverlay.etag);
assert.notEqual(after.visualizationBody, before.visualizationBody);
~~~

`numericTolerance` is derived from the payload scalar type and magnitude, documented in evidence; it is not an arbitrary UI tolerance.

#### Krok 10.3 — legal zero and mismatch cases

- [ ] Reuse the existing router integration fixture for uniform zero; do not claim the SP4 live fixture is zero.
- [ ] Assert HTTP 200, finite count equals sample count, nonzero count 0 and `min=max=0`.
- [ ] Reuse or extend the existing cardinality/grid mismatch test.
- [ ] Assert 409 or 422 according to the existing typed error contract, with no FMVP body and no synthetic zero.
- [ ] Record both focused test names next to the live evidence.

#### Krok 10.4 — evidence schema

The Markdown evidence file contains:

~~~text
Timestamp UTC:
Git HEAD:
Dirty paths in scope:
Fixture path:
Launcher command:
API base:
Session id:
Run id:
Resolved backend/device/precision:
Generation id:
Field revision:
Carrier/source revisions:
Planar sample token digest:
Scalar sample/finite/nonzero counts:
Decoded min/max:
Meta min/max:
Scalar/vector/mask/overlay/render ETags:
SHA-256 values before/after style PATCH:
Visualization revision/body digest before/after:
Uniform-zero focused test result:
Mismatch focused test result:
Conclusion: PASS or FAIL
Unresolved observations:
~~~

No field may be replaced with “see screenshot”. Secrets and unrelated environment values are never written.

#### Krok 10.5 — final commands and expected result

With the managed fixture already running:

~~~bash
node --test apps/control-room/scripts/lib/decode-fmvp.test.mjs
node apps/control-room/scripts/qualify-planar-live-api.mjs \
  --api-base http://127.0.0.1:8196 \
  --quantity m \
  --output-dir .superpowers/sdd/planar-live-api
cargo test -p fullmag-api planar -- --nocapture
cargo test -p fullmag-api router_v2 -- --nocapture
git diff --check
~~~

Oczekiwany GREEN:

- decoder tests PASS;
- live command exits 0;
- SP4 `nonzero_count > 0`;
- decoded min/max agree with meta;
- style-only PATCH changes visualization state and the effective styled export only;
- data-plane sample token, ETags and SHA-256 stay stable;
- zero and mismatch focused tests PASS;
- evidence file ends with `Conclusion: PASS`.

Nie oznaczaj Bramki A jako ukończonej, jeżeli launcher był niedostępny, payload nie został zdekodowany, link został odtworzony zamiast odczytany z meta albo brakuje wymaganego nagłówka lub hasha.