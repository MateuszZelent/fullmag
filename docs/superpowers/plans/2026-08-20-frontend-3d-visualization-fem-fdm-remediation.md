# Plan naprawy wizualizacji 3D FEM/FDM — masterplan v2

> **Dla agentów wykonawczych:** WYMAGANA PODUMIEJĘTNOŚĆ: użyj `subagent-driven-development` albo `executing-plans`. Każdy subplan zachowania musi dodatkowo użyć `test-driven-development`, `resource-first-api-check`, `frontend-v2-viewport-lifecycle`, `frontend-v2-performance-gates`, `capability-matrix-check`, `backend-golden-masterplan` i `verification-before-completion`. Kroki używają pól wyboru (`- [ ]`).

**Cel:** Zamknąć wszystkie ustalenia `F3D-001–F3D-016` z faktycznie przesłanego audytu `2026-08-20-frontend-3d-visualization-fem-fdm-audit.md`, dodatkowe ustalenia `R3D-001–R3D-022` pochodzące z recenzji planu oraz dwa wymagania przekrojowe `F3D-S01/S02`, zachowując jeden wspólny viewport FEM/FDM, canonical resource-first API v2 i naukowo poprawne target/carrier/topology/field identity.

**Architektura:** HTTP v2 pozostaje źródłem prawdy, WebSocket przenosi wyłącznie zdarzenia i invalidation, a ciężka topologia oraz pola pozostają na binarnym data plane. Publiczna tożsamość targetu, techniczny carrier, fizyczny field response i derived render build są osobnymi kontraktami. Po stage istnieje backend-neutral retained observation context albo jawnie sklasyfikowana alternatywa; renderer pozostaje domain-neutral, demand-driven i mierzalny.

**Stos technologiczny:** Rust (`fullmag-quantities`, `fullmag-runner`, `fullmag-api`, `fullmag-cli`), OpenAPI v2, TypeScript/React 19/Next.js 16, R3F/Three.js, Vitest, Playwright/CDP, managed native FEM przez repozytoryjny `justfile`.

## Status dokumentu

Ten dokument jest **masterplanem i mapą zależności**, a nie pojedynczym planem do wykonania od początku do końca przez jednego agenta. Każdy workstream opisany niżej musi otrzymać osobny plik wykonawczy z małymi krokami RED → GREEN → REFACTOR → review.

Zalecana lokalizacja subplanów:

```text
docs/superpowers/plans/2026-08-20-frontend-3d-remediation/
```

Nie rozpoczynać zmian produkcyjnych przed ukończeniem Zadania 0 i zapisaniem lokalnego implementation baseline.

---

## 1. Źródło prawdy i identyfikatory ustaleń

Przesłany plik audytu ma 1205 wierszy i 16 ustaleń. Recenzja planu opisuje
inny, 22-punktowy zestaw problemów, którego nie ma w przesłanym audycie.
Weryfikacja lokalnego kodu potwierdziła, że większość tych dodatkowych problemów
rzeczywiście istnieje, dlatego plan zachowuje je jako osobny namespace `R3D`
(`review-derived`). Nie wolno opisywać `R3D-001–R3D-022` jako ustaleń
1205-wierszowego audytu ani zastępować nimi jego oryginalnej numeracji `F3D`.

### 1.1 Ustalenia rozszerzające z recenzji planu

| ID | Skrócony zakres |
|---|---|
| R3D-001 | Session-scoped cache/resource/last-good identity |
| R3D-002 | Quantity capability nie może wynikać z field cache/list preview |
| R3D-003 | Backend-neutral retained materialization po stage |
| R3D-004 | Final materialization parity FEM/FDM i terminal/idle transitions |
| R3D-005 | FEM spatial energy-density capability parity |
| R3D-006 | Fields i energies na tym samym observation frame |
| R3D-007 | Usunięcie aktywnej legacy field-vector path |
| R3D-008 | Stable fallback carrier IDs i diagnostic-only semantics |
| R3D-009 | Exact component/scope/carrier capability matching |
| R3D-010 | Per-carrier resource isolation zamiast collection-wide error |
| R3D-011 | Jawne solver/session/resource/connectivity lifecycle |
| R3D-012 | Świeży real-model runtime/browser/WebGL proof |
| R3D-013 | Bounded priority concurrency dla field requests |
| R3D-014 | Kwalifikacja custom R3F root lifecycle |
| R3D-015 | Zmierzona polityka 3D↔2D |
| R3D-016 | Byte-accounted budgets dla derived caches |
| R3D-017 | Raw lifecycle/performance measurements |
| R3D-018 | Brak render-phase `setState` w Inspectorze |
| R3D-019 | Metadata-driven quantity selector, bez ręcznej listy |
| R3D-020 | Legacy frontend cutover i source backup hygiene |
| R3D-021 | Typed dirty reasons |
| R3D-022 | Widoczna CI/required-check matrix dla SHA |

### 1.2 Ustalenia przesłanego audytu i ich właściciele

| ID | Rzeczywisty zakres audytu | Właściciel w masterplanie v2 |
|---|---|---|
| F3D-001 | Brak świeżego real-model E2E FEM/FDM dla audytowanego SHA | Zadania 0, 12 |
| F3D-002 | Dwie publiczne tożsamości FDM Airboxa | Zadanie 3 |
| F3D-003 | Fail-open membership w FDM vectors-only | Zadanie 3 |
| F3D-004 | Niepełny exact scope w diagnostyce Airboxa | Wspólny kontrakt 3.2; Zadania 2, 3, 6 |
| F3D-005 | Quantity-specific H_demag carrier FDM multilayer | Zadanie 2 |
| F3D-006 | Quantity catalog miesza capability z materialization/cache | Zadanie 2 |
| F3D-007 | Rekonstrukcja post-stage FEM shared-air i FDM multilayer | Zadania 5, 12 |
| F3D-008 | Spatial transport quantities poza canonical 3D UI | Zadania 2, 12 |
| F3D-009 | `supports_preview_3d` nie gwarantuje ekspozycji/materializacji | Zadanie 2 |
| F3D-010 | Inspector hardkoduje execution jako interactive | Zadania 5, 6 |
| F3D-011 | Brak świeżych pomiarów lifecycle/performance | Zadania 9, 12 |
| F3D-012 | Brak browser proof stabilności optimistic Inspector/ACK | Zadania 6, 7, 12 |
| F3D-013 | Niezweryfikowany request/ACK budget | Zadania 7, 9, 12 |
| F3D-014 | Proof artifacts bez niezmiennej provenance | Zadania 0, 12 |
| F3D-015 | Backup sources w aktywnym drzewie | Zadanie 10 |
| F3D-016 | Brak świeżego wyniku 3D↔2D gate | Zadania 8, 9, 12 |

### 1.3 Wymagania przekrojowe

| ID | Zakres |
|---|---|
| F3D-S01 | `airbox` jest jedynym publicznym targetem; `fdm-universe-outside-support`, `part:__air__` i `object:__air__` są carrierami/aliasami wejściowymi. |
| F3D-S02 | FDM active/inactive membership jest fail-closed również w vectors-only; brak exact maski nigdy nie oznacza inactive whole-grid. |

Przed wykonaniem Zadania 3 należy utworzyć addendum do audytu rejestrujące `F3D-S01/S02` oraz namespace `R3D`, aby nie nadpisywać znaczenia istniejących numerów `F3D-001–F3D-016`.

---

## 2. Ograniczenia globalne

- Audytowy base commit: `d9518082eaee2131c3e7160bd8ae952ed2f45899`.
- Implementation base commit jest ustalany świeżo w Zadaniu 0; nie zakładać, że nadal odpowiada audytowemu SHA.
- Chronione obce zmiany: `apps/control-room/next-env.d.ts` i `external_solvers/3`; nie modyfikować, nie stage’ować, nie commitować.
- Każdy checkpoint używa dokładnych ścieżek albo `git add -p`; zakazane jest szerokie `git add apps/control-room/src`.
- Publiczny target Airboxa: `targetId="airbox"`.
- Techniczne identity pozostają w `carrierId`, `carrierFingerprint`, topology/membership provenance i debug receipts.
- HTTP v2 jest źródłem prawdy; realtime nie niesie topologii ani pola.
- Ciężkie payloady pozostają binarne; status/event zawiera wyłącznie małe identity, state i revisions.
- Brak session epoch, exact scope, exact component, primary carriera, membership albo topology compatibility daje typed unavailable/conflict; brak fallbacku do całej siatki lub zerowego pola.
- Zmiana quantity nie może przebudowywać topologii.
- Zmiana ustawienia jednego targetu nie może pobierać pól innych targetów.
- Last-good jest dozwolony tylko dla pełnej zgodnej identity i zostaje odcięty przy zmianie session epoch/discard.
- Inspector zachowuje root/scroll/focus/drafts; pending i rejection są per-control/transaction.
- `completed` jest terminalne; ukończenie stage w żywej sesji przechodzi do `awaiting_command`.
- `disconnected` jest connectivity state, a nie solver lifecycle.
- Wszystkie zmiany zachowania: RED → GREEN → REFACTOR.
- OpenAPI: regenerować `openapi-v2.json`, `openapi-v2-types.ts`, `openapi-v2-client.ts`; bez ręcznej edycji.
- Native FEM/MFEM/CUDA/hypre/libCEED: najpierw właściwa managed/container-backed receptura `just`.
- Unit test, source review, HTTP 200, zbudowany segment lub field catalog entry nie zamyka browser/runtime/physical gate.
- Nie używać określenia „production-ready” bez świeżych PASS wszystkich finalnych bramek.

---

## 3. Wspólne kontrakty, które muszą powstać przed integracją

### 3.1 Canonical target identity

Publiczne targety i techniczne carriery nie mogą dzielić jednego pola string.

```ts
export type CanonicalVisualizationTargetIdentity =
  | { kind: "airbox"; targetId: "airbox" }
  | { kind: "object"; targetId: string }
  | { kind: "part"; targetId: string }
  | { kind: "region"; targetId: string }
  | { kind: "fdm-domain"; targetId: string }
  | { kind: "fdm-native-layer"; targetId: string };

export interface VisualizationCarrierIdentity {
  carrierId: string;
  carrierFingerprint: string;
  role: "physical" | "diagnostic" | "presentation";
}
```

Kanonizacja przyjmuje typed input z kind/role/metadata, nie sam `id: string`.

### 3.2 Exact field scope

```ts
export type ExactFieldScope =
  | { kind: "full" }
  | { kind: "airbox"; id: "airbox" }
  | { kind: "object"; id: string }
  | { kind: "part"; id: string }
  | { kind: "region"; id: string };
```

Wire rules:

| Scope | `scope_kind` | `scope_id` |
|---|---|---|
| full | `full` | pominięte |
| airbox | `airbox` | `airbox` |
| object | `object` | niepuste |
| part | `part` | niepuste |
| region | `region` | niepuste |

### 3.3 Cztery warstwy field/render identity

```ts
interface SessionResourceIdentity {
  sessionId: string;
  sessionEpoch: string;
}

interface FieldRequestIdentity {
  session: SessionResourceIdentity;
  quantityId: string;
  component: string;
  scope: ExactFieldScope;
  carrierId: string;
  carrierFingerprint: string;
  domainGenerationId: string;
  topologyIdentity: FemTopologyIdentity | FdmGridIdentity;
  indexing: string;
  maxSamples: number | null;
}

interface FieldResponseIdentity extends FieldRequestIdentity {
  resourceKey: string;
  etag: string;
  fieldRevision: string | number;
  observationFrameId: string;
  sourceStep: number;
  sourceTimeSeconds: number;
}

interface DerivedRenderBuildIdentity {
  response: FieldResponseIdentity;
  targetId: string;
  geometryScope: string;
  membershipRevision: string | null;
  cellSelection: string | null;
  vectorBudget: number | null;
  shaderVariant: string;
}
```

Inwarianty:

- ETag nie wchodzi do pre-request cache key.
- Render style/glyph budget nie wchodzą do raw field cache key.
- FEM i FDM mają discriminated topology identity.
- Request, cache record, debug snapshot i adoption receipt przenoszą tę samą response identity, bez ponownej ręcznej serializacji.

### 3.4 Observation frame

```rust
struct AcceptedObservationFrameRef {
    session_id: String,
    session_epoch: String,
    run_id: String,
    stage_id: Option<String>,
    observation_frame_id: String,
    accepted_sequence: u64,
    step: u64,
    time_seconds: f64,
    state_hash: String,
    plan_revision: String,
    domain_generation_id: String,
    topology_identity: TopologyIdentity,
    carriers: Vec<FieldCarrierIdentity>,
}
```

Każdy field/scalar/energy publikowany jako „current” wskazuje ten sam `observation_frame_id` albo jawnie deklaruje inną klasę danych.

### 3.5 Lifecycle

```ts
interface VisualizationExecutionState {
  sessionLifecycle: "active" | "retained" | "completed" | "discarded" | "failed";
  solverLifecycle:
    | "bootstrapping"
    | "materializing"
    | "running"
    | "paused"
    | "awaiting_command"
    | "completed"
    | "stopped"
    | "failed";
  connection: "connected" | "reconnecting" | "disconnected";
  resources: "fresh" | "stale" | "unavailable";
  commandability: "allowed" | "read_only" | "forbidden";
  reasonCode: string | null;
}
```

### 3.6 Adoption i ACK

- `Viewport3DRenderAdoptionReceipt` dowodzi przyjęcia response identity przez render pass.
- `VisualizationAckCoordinator` potwierdza visualization revision po frame commit.
- Style-only revision może dostać ACK bez nowego field receipt.
- Data-changing revision dostaje `rendered` dopiero po właściwej adopcji albo `failed` z reason.
- Orbit bez persisted revision: 0 ACK.

---

## 4. Proof bundle v1 — poprawiony kontrakt

```js
const manifest = {
  schemaVersion: "fullmag.viewport-proof.v1",
  proofClass: "qualification", // fixture-smoke | baseline-fail | blocked
  outcome: "pass",             // fail | blocked
  scenarioId: "fdm-regular-airbox-post-stage",
  execution: {
    provider: "github-actions",
    runId: "actual-workflow-run-id",
    workflowName: "bootstrap",
    jobName: "control-room-contracts",
    headSha: FULL_SHA,
    conclusion: "success"
  },
  source: {
    auditBaseCommit: FULL_SHA,
    implementationCommit: FULL_SHA,
    statusSha256: SHA256,
    runtimeRelevantDirty: false,
    allowedUnrelatedDirtyPaths: [
      "apps/control-room/next-env.d.ts",
      "external_solvers/3"
    ],
    changedPaths: []
  },
  runtime: {
    lane: "fdm-cpu",
    buildInfoSha256: SHA256,
    sourceSnapshotSha256: SHA256,
    components: [
      { path: "relative/or/declaratively-external", sha256: SHA256, kind: "binary" }
    ],
    managedRecipe: null
  },
  model: {
    path: "actual-existing-model-path",
    sha256: SHA256,
    fixture: false
  },
  browser: {
    name: "chromium",
    version: "exact-version"
  },
  gpu: {
    vendor: "actual GL_VENDOR",
    renderer: "actual GL_RENDERER"
  },
  session: {
    sessionId: "actual-session-id",
    sessionEpoch: "actual-session-epoch",
    startLifecycle: "running",
    endLifecycle: "awaiting_command"
  },
  steps: [
    {
      id: "vectors-only",
      status: "pass",
      quantityId: "H_demag",
      expected: { wireframeVisible: false },
      actual: { glyphCount: 128 },
      artifacts: ["vectors.png", "adoption.json"]
    }
  ],
  artifacts: [
    { path: "vectors.png", sha256: SHA256, mediaType: "image/png" }
  ],
  blocker: null
};
```

Validator wymaga:

- pełnych lowercase SHA/SHA-256;
- artefaktów pod `artifactRoot`, bez traversal i symlink escape;
- zgodności implementation SHA z bundle directory i runtime source snapshot;
- `fixture=false` dla `proofClass=qualification`;
- jawnego `blocker={code,detail}` dla `outcome=blocked`;
- hashy modeli, runtime components, raw logs i screenshots;
- brak runtime-relevant dirty files poza zmianami objętymi implementation commit.

---

# Workstreamy wykonawcze

## Zadanie 0: Traceability addendum, preflight i proof foundation

**Zamyka/przygotowuje:** R3D-012, R3D-017, R3D-022; rejestruje F3D-S01/S02.

**Pliki:**
- Utwórz: `docs/audits/2026-08-20-frontend-3d-visualization-fem-fdm-audit-addendum.md`
- Utwórz: `apps/control-room/scripts/lib/proof-manifest.mjs`
- Utwórz: `apps/control-room/scripts/validate-viewport-proof-manifest.mjs`
- Utwórz: `apps/control-room/src/kernel/performance/viewportProofManifestScript.test.ts`
- Modyfikuj: `apps/control-room/package.json`
- Modyfikuj: smoke/audit scripts konsumujące manifest

**Zależności:** brak.

- [x] Zapisać `AUDIT_BASE_SHA`, świeży `IMPLEMENTATION_BASE_SHA`, pełny `git status --porcelain=v1 -z` i hash statusu.
- [x] Zweryfikować, że chronione obce paths są niezmienione względem preflight snapshot.
- [x] Utworzyć addendum rejestrujące `R3D-001–R3D-022` jako ustalenia z recenzji oraz `F3D-S01/S02` jako wymagania przekrojowe; bez renumerowania audytowych `F3D-001–F3D-016`.
- [x] Napisać RED testy manifestu: valid qualification, fixture rejection, path traversal, bad SHA, missing artifact, unrelated dirty allowed, runtime-relevant dirty rejected, typed blocked outcome.
- [x] Zaimplementować writer/validator i `validate:viewport-proof`.
- [ ] Wpiąć manifest do istniejącego source snapshot/managed report flow, nie tworzyć konkurencyjnego źródła identity.
- [x] Zebrać baseline jako `baseline-fail` albo `blocked`; nie promować do PASS.

**Weryfikacja:**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/performance/viewportProofManifestScript.test.ts
pnpm --dir apps/control-room run validate:viewport-proof -- --self-test
```

**Bramka:** validator odrzuca każdy tamper i prawidłowo zachowuje obce dirty paths w evidence.

**Checkpoint:** stage’ować wyłącznie dokładne nowe/modyfikowane pliki; sprawdzić `git diff --cached --name-only` przed commitem.

---

## Zadanie 1: Session-scoped resource, cache i last-good identity

**Zamyka:** R3D-001.

**Pliki:**
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`
- Modyfikuj: `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`
- Modyfikuj: właściwy owner session status/resource identity w `apps/control-room/src/kernel/resources/`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts`
- Modyfikuj: odpowiadające testy cache/field buffer/adoption

**Zależności:** Zadanie 0.

- [ ] RED: dwie kolejne sesje z tym samym quantity/scope, opóźniona odpowiedź pierwszej sesji i last-good z poprzedniego epoch.
- [ ] Wprowadzić `SessionResourceIdentity { sessionId, sessionEpoch }` jako obowiązkowy składnik topology, field, last-good i derived-buffer owner keys.
- [ ] Odrzucać response starego epoch przed decode/adoption.
- [ ] Atomowo usuwać last-good i leases przy discard/session epoch change.
- [ ] Dodać typed dirty reason `session-identity-changed`.
- [ ] Browser proof: delayed old response nie pojawia się w adoption registry.

**Bramka:** każdy adopted response ma current `sessionId/sessionEpoch`; zero cross-session cache hit.

---

## Zadanie 2: Canonical quantity capability planes i generic field carriers

**Zamyka:** R3D-002, R3D-005, R3D-009, R3D-019.

**Pliki:**
- Modyfikuj: `crates/fullmag-quantities/src/catalog.rs`
- Modyfikuj: `crates/fullmag-runner/src/quantities.rs`
- Modyfikuj: `crates/fullmag-api/src/schemas/quantities.rs`
- Modyfikuj: `crates/fullmag-api/src/schemas/fields.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modyfikuj: `crates/fullmag-api/src/openapi_v2.rs`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Modyfikuj: `apps/control-room/src/kernel/api/quantityIds.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modyfikuj: dokumentację API/capability/physics, gdy publiczna semantyka się zmienia

**Zależności:** Zadanie 1 dla session identity; może rozpocząć Rust catalog tests równolegle po zatwierdzeniu shared contracts.

**Kontrakt:** osobne osie:

```rust
solver_capability
requestability
materialization
renderability
publication
```

- [ ] RED contract tests dla `VectorField`, `SpatialScalar`, `TensorField`, `GlobalScalar` i export-only.
- [ ] Global scalar capability wyprowadzać z scalar provider/capabilities, nie z preview field lists.
- [ ] FEM `eden_*` capability generować z rzeczywiście zarejestrowanych materializerów i aktywnych termów fizycznych.
- [ ] Component/indexing/view metadata uczynić obowiązkowym dla nowej payload version.
- [ ] Legacy payload oznaczyć `legacy_unverified`; brak naukowego adoption w qualified mode.
- [ ] Publikować `FieldCarrierDescriptor[]` bez quantity-specific frontend branchy.
- [ ] `spin_current_tensor` pozostaje `unsupported_shape` bez wymyślonego magnitude/vector mapping.
- [ ] Usunąć ręczne `VISUALIZATION_QUANTITY_ITEMS`; selector powstaje z catalog metadata + resolved lane/carriers.
- [ ] Synthetic generic-carrier test używa test-only registered provider albo rzadkiej canonical quantity; nie nieznanego ID łamiącego catalog.
- [ ] Regenerować transport i sprawdzić deterministyczność generatora bez `|| true`.

**Weryfikacja:**

```bash
cargo test -p fullmag-quantities --no-fail-fast
cargo test -p fullmag-runner quantities --no-fail-fast
cargo test -p fullmag-api quantities --no-fail-fast
pnpm --dir apps/control-room run generate:api
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run typecheck
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

**Bramka:** katalog, fields, scalars i Inspector zgadzają się dla wszystkich 52 canonical quantities; brak ręcznego switch/list per ID w adapterze/UI.

---

## Zadanie 3: Canonical Airbox target i fail-closed FDM membership

**Zamyka:** F3D-S01, F3D-S02; wzmacnia R3D-009.

**Pliki:**
- Utwórz: `apps/control-room/src/kernel/visualization/visualizationTargetIdentity.ts`
- Utwórz: `apps/control-room/src/kernel/visualization/visualizationTargetIdentity.test.ts`
- Modyfikuj: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modyfikuj: `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`
- Modyfikuj: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/model/fdmUniverseOverlay.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modyfikuj: persisted visualization-state normalizer w `crates/fullmag-api/src/session.rs` i właściwym handlerze

**Zależności:** Zadania 1–2.

- [ ] RED typed canonicalization tests dla `airbox`, legacy aliases i non-Airbox targets.
- [ ] Migracja persisted state: canonical wins; legacy conflict rozstrzygany przez revision/timestamp; bounded warning; outgoing canonical only.
- [ ] Selection zachowuje `nodeId`, ale oddziela `targetId="airbox"` od `carrierId`.
- [ ] Usunąć drugi publiczny `VisualizationTargetRef`; techniczna stała nazywa carrier, nie target.
- [ ] RED membership matrix: active/inactive/all/dense, null mask, wrong length, empty mask, sampled node indices.
- [ ] Active/inactive wymagają exact membership; null/stale/wrong-length → typed unavailable i zero worker/adoption.
- [ ] `all` bez membership dozwolone wyłącznie dla jawnego full-domain targetu.
- [ ] Build key/receipt zawiera target, carrier, selection, membership revision i field response identity; itemCount po filtracji.

**Bramka:** outgoing target identity zawsze `airbox`; null membership nie produkuje glyphów ani receipt.

---

## Zadanie 4: Per-carrier resource graph, stable fallback IDs i bounded concurrency

**Zamyka:** R3D-007, R3D-008, R3D-010, R3D-013.

**Pliki:**
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modyfikuj/usuwaj po parity: aktywny `useViewport3DFieldVector` i jego consumers
- Modyfikuj: `apps/control-room/src/kernel/selection/manifestRenderableCarriers.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Modyfikuj: backend manifest/segment owner publikujący stable IDs
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`

**Zależności:** Zadania 1–3.

- [ ] Zbudować inventory wszystkich primary/full/analysis consumers i RED request-log parity tests.
- [x] Przenieść consumers na jeden planner request graph; usunąć aktywny `legacy-field-vector-hook` po parity.
- [x] Każdy carrier otrzymuje własny resource state/key/revision/error/lease; collection jest wyłącznie derived view.
- [x] Jeden target failure nie zmienia `ready` pozostałych targetów.
- [x] Backend publikuje stable fallback segment ID/hash; index-based ID zabronione.
- [x] Fallback bez physical carrier ma `diagnostic_only=true`, field controls hidden i zero field request.
- [x] Wprowadzić bounded concurrency z priorytetem: selected → visible vectors → visible surface → remaining visible.
- [x] Abort wyłącznie requestów bez aktywnych leases; brak request storm.
- [x] Dodać latency/request-count tests dla 1/10/50 targetów.

**Bramka:** zmiana targetu A nie fetchuje B/C; jedna awaria nie degraduje pozostałych; brak legacy consumer label.

---

## Zadanie 5: Retained observation context, atomic finalization i lifecycle

**Zamyka:** R3D-003, R3D-004, R3D-006, R3D-011.

**Pliki:**
- Modyfikuj: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Modyfikuj: `crates/fullmag-cli/src/orchestrator.rs`
- Modyfikuj: `crates/fullmag-runner` provider/runtime interfaces
- Modyfikuj: `crates/fullmag-api/src/session.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modyfikuj: schemas runtime/status/fields i generated API transport
- Modyfikuj: `apps/control-room/src/kernel/resources/useSessionStatus.ts`
- Utwórz lub modyfikuj centralny frontend lifecycle selector

**Zależności:** Zadanie 2 carrier contract; Zadanie 1 session epoch.

- [ ] RED black-box contract tests dla FDM regular, FDM multilayer, FEM magnetic-only, FEM shared-air.
- [x] Wprowadzić `AcceptedObservationFrameRef`.
- [ ] Wprowadzić provider policy per quantity/lane.
- [ ] Provider policy: retained runtime, deterministic reconstruction, immutable terminal snapshot albo unavailable-after-stage.
- [x] `compute_fields` i `compute_energies` publikują ten sam `observation_frame_id`; rozważyć canonical `compute_observables` bez usuwania zgodności API bez migracji.
- [ ] Publikować atomowy `FieldPublicationBundle` obejmujący response revisions i carrier/topology identity.
- [ ] Finalization obejmuje wymagane accepted transitions FEM/FDM; `complete` dopiero po atomowej publikacji.
- [x] Stage completion w interaktywnej sesji → `awaiting_command`; prawdziwe session `completed` → read-only/terminal i compute zwraca typed 409.
- [ ] Oddzielić solver, session resource, connectivity i commandability lifecycle.
- [ ] Close/discard usuwa retained providers i publikuje nowy session epoch/tombstone.
- [ ] Native FEM testy uruchomić przez konkretne znalezione receptury, np. `ensure-managed-fem-runtime`, `fem-managed-headless` lub właściwy `verify-*` recipe.

**Bramka:** fields i scalars mają wspólne frame provenance; post-stage compute zachowuje topology/carrier identity; terminal completed jawnie odrzuca compute.

---

## Zadanie 6: Inspector state, last-good i stabilność transakcji

**Zamyka:** R3D-018; frontendowa część R3D-011.

**Pliki:**
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modyfikuj: `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`
- Modyfikuj: target-scoped resource selectors
- Modyfikuj: `apps/control-room/scripts/smoke-inspector.mjs`
- Modyfikuj: `apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs`

**Zależności:** Zadania 1–5.

- [ ] RED test wykrywający render-phase `setState` i remount panel root.
- [ ] Zastąpić `lastGoodPanel` state w renderze przez reducer/effect/external-store snapshot z identity guard.
- [ ] Last-good zachować tylko dla samego target/session/topology/carrier identity.
- [ ] Pending key: `targetId + fieldName + transactionId`; brak target-wide disabled/dimming.
- [ ] Target-scoped selectors zwracają minimalny używany status.
- [ ] Browser assertions przed/during/after ACK/reject: root identity, scroll, focus, drafts, disabled states, active opacity animations.
- [ ] Copy log pokazuje authoritative lifecycle/connectivity, exact response identity i adoption state.

**Bramka:** zero render-phase update warnings; root/scroll/focus/draft stabilne; unrelated controls nie zmieniają disabled/opacity.

---

## Zadanie 7: Jeden ACK coordinator, oddzielony od adoption registry

**Wzmacnia:** R3D-010, R3D-012, R3D-017; usuwa ryzyko komunikacyjne wykryte w planie.

**Pliki:**
- Modyfikuj: `apps/control-room/src/kernel/visualization/useVisualizationClientAck.ts`
- Modyfikuj: odpowiadające testy
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/model/viewport3DRenderAdoptionRegistry.ts`
- Modyfikuj: visualization debug publisher/model
- Modyfikuj: realtime communication smoke/audit scripts

**Zależności:** Zadania 1, 4, 6.

- [x] RED: dwa hook owners, ten sam session/viewport/revision → jeden ACK.
- [x] RED: style-only revision → jeden rendered ACK bez nowego field receipt.
- [x] RED: orbit/rerender bez revision change → zero ACK.
- [x] Koordynator key: `sessionEpoch + viewportId + visualizationRevision`.
- [x] Data-changing revision oczekuje właściwego adoption/frame commit; style-only revision nie oczekuje nowego field buffer.
- [x] Bounded coordinator cleanup przy unmount/session epoch change.
- [ ] Budżety: quantity switch maks. jeden canonical GET per carrier i jeden terminal ACK per revision; inactive 3D zero ACK.

**Bramka:** request/ACK log spełnia budżety, bez duplikatów i bez utraty style-only ACK.

---

## Zadanie 8: R3F root lifecycle, polityka 3D↔2D i typed dirty reasons

**Zamyka:** R3D-014, R3D-015, R3D-021.

**Pliki:**
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.tsx`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.test.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dBatchedInvalidate.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dTypes.ts`
- Modyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modyfikuj: `apps/control-room/scripts/audit-viewport-main-tab-memory.mjs`
- Modyfikuj: jego test skryptowy

**Zależności:** Zadanie 0 baseline; Zadanie 9 instrumentation może być realizowane wspólnie.

- [x] Instrumentować configure generations, event connections, context lifecycle i reason sets.
- [x] Wprowadzić typed dirty reasons, np. `camera`, `field-buffer`, `topology`, `target-visibility`, `material-style`, `resize`, `frame-commit`.
- [ ] RED strict-mode mount/unmount/configure stress tests.
- [ ] Zebrać baseline dla teardown i reopen kosztu.
- [ ] Wybrać jedną strategię:
  - teardown z budżetem reopen latency/build/upload; albo
  - retained dormant viewport z 0 frames/GET/ACK/jobs i bounded memory.
- [ ] Zakodować wybraną strategię w ADR/plan result; nie wymagać jednocześnie sprzecznych warunków obu.
- [ ] 100 switch test sprawdza właściwe invariants wybranej strategii.

**Bramka:** jeden aktywny context, zero context loss/leak; configure/event counts w budżecie; typed reasons wyjaśniają każdą klatkę.

---

## Zadanie 9: Byte-accounted caches i mierzalny renderer performance

**Zamyka:** R3D-016, R3D-017.

**Pliki:**
- Modyfikuj: derived buffer cache/worker/glyph registries pod `apps/control-room/src/modules/viewport-3d/`
- Modyfikuj: `VectorFieldLayer.tsx`, FDM cuboid layers i GPU upload managers
- Modyfikuj: właściwy diagnostics/performance controller pod `apps/control-room/src/kernel/performance/`
- Modyfikuj: `audit-idle-performance.mjs`
- Modyfikuj: `audit-viewport-3d-memory-churn.mjs`
- Modyfikuj: `audit-airbox-vector-cold-toggle.mjs`
- Modyfikuj: `audit-viewport-3d-fem-topology-uploads.mjs`
- Modyfikuj: `audit-viewport-3d-profile-switch.mjs`

**Zależności:** Zadania 4, 7, 8.

- [ ] RED byte-budget/eviction tests dla każdego cache owner; count-only limit nie wystarcza.
- [ ] Wspólny bounded snapshot counterów: R3F render frames/reasons, topology builds/uploads, field decodes/swaps, worker jobs, typed-array copied bytes, GPU upload bytes, geometry/material create/dispose, cache hit/miss/eviction.
- [ ] Instrumentacja opt-in, bez per-frame log allocation i bez polling timerów.
- [ ] Nie kopiować typed arrays wyłącznie do pomiaru.
- [ ] Zdefiniować konkretne budżety po baseline; „0 idle frames” oznacza R3F render frames w ustalonym settled window, nie globalny browser RAF.
- [ ] Raw JSON/traces trafiają do proof bundle; summary bez raw trace nie jest PASS.

**Bramka:** quantity switch = 0 topology builds; orbit = 0 field GET/decode/topology; unmount/retention zgodne z wybraną policy; caches mieszczą się w byte budget.

---

## Zadanie 10: Legacy frontend cutover i source hygiene

**Zamyka:** R3D-020.

**Pliki:**
- Usuń wszystkie backup suffix files spod `apps/control-room/src`
- Modyfikuj: `apps/control-room/scripts/check-architecture-hygiene.mjs`
- Utwórz/modyfikuj test skryptu hygiene
- Modyfikuj aktywne routing/registration tylko tam, gdzie `apps/legacy_web` nadal może zostać uruchomione jako konkurencyjna ścieżka produktu
- Modyfikuj dokumentację cutover/deprecation

**Zależności:** Zadanie 4 usuwa legacy hook; można prowadzić hygiene gate równolegle.

- [x] Preflight: `rg --files apps/control-room/src | rg '(\.orig|\.rej|\.bak|~)$'`.
- [x] Porównać każdy backup z aktywnym plikiem; przenieść tylko unikatowy wymagany test/code przez osobne RED/GREEN.
- [x] Usunąć wszystkie wykryte backupy, w tym production i test `.orig`.
- [x] Gate odrzuca każdy suffix pod całym `apps/control-room/src` i podaje exact path.
- [x] Zinwentaryzować entrypoints `apps/legacy_web` i pozostałych frontendów; oznaczyć non-canonical path jako build/test-only albo usunąć z aktywnego launcher/registry zgodnie z cutover policy.
- [x] Nie usuwać legacy kodu bez oddzielnego ownership/deprecation proof.

**Bramka:** zero backup suffix files; jeden canonical product entrypoint dla Control Room; legacy path nie jest ukrytą alternatywą runtime.

---

## Zadanie 11: Widoczna CI i required-check matrix

**Zamyka:** R3D-022.

**Pliki:**
- Utwórz/modyfikuj: `.github/workflows/...` odpowiedzialne za contracts/frontend/managed qualification
- Modyfikuj: CI helper scripts i docs release gates
- Modyfikuj: proof manifest writer, aby rejestrował workflow run/job identity

**Zależności:** Zadania 1–10 mają stabilne komendy i gates.

- [ ] Zdefiniować jobs: Rust quantity/API/CLI contracts, generated API determinism, architecture/API hygiene, Control Room typecheck/lint/test, browser fixture smoke, managed FEM qualification (tam gdzie runner dostępny).
- [ ] Opublikować jednoznaczne check contexts i matrix lanes.
- [x] Zdefiniować required checks dla merge/release albo równoważny release gate dokumentowany w repo.
- [x] Proof bundle zapisuje run ID, head SHA, workflow/job names i conclusions.
- [x] Test celowo psuje jeden gate i potwierdza, że workflow/job failuje.

**Bramka:** implementation SHA ma pełną widoczną macierz; pojedynczy React Doctor nie wystarcza.

---

## Zadanie 12: Real-model FEM/FDM qualification i final closure report

**Zamyka:** R3D-012 oraz runtime/browser gates wszystkich pozostałych ustaleń.

**Pliki:**
- Modyfikuj: istniejące smoke/audit scripts z `apps/control-room/package.json`
- Produkuj jako niecommitowane/durable artefakty: proof bundles, HAR/request logs, console, adoption JSON, WebGL probes, traces i screenshots
- Utwórz: końcowy raport kwalifikacyjny po polsku pod `docs/audits/` lub `docs/validation/`

**Zależności:** Zadania 0–11.

### 12.1 Minimalna lane matrix

1. FDM regular.
2. FDM multilayer.
3. FEM magnetic-only.
4. FEM shared mesh + Airbox.

Dla lane wspierających GPU uruchomić osobny resolved-device proof; nie zastępować CPU proof deklaracją capability.

### 12.2 Minimalny scenariusz per lane

- [ ] Załaduj realny, zahashowany model (`fixture=false`).
- [ ] Potwierdź session epoch, topology/grid identity, targety i carriery.
- [ ] Włącz/wyłącz Airbox.
- [ ] Uruchom surface, wireframe, points i vectors-only.
- [ ] Przełącz `m`, `H_demag`, `H_eff`, `H_ext` tam, gdzie canonical capability mówi supported; unsupported ma reason code.
- [ ] Wyłącz wireframe, pozostaw vectors; zapisz glyph count/scale/pixel proof.
- [ ] Orbituj; 0 field GET/decode/topology build/ACK.
- [ ] Doprowadź stage do `awaiting_command`; wykonaj dozwolony compute; porównaj observation/topology/carrier identity.
- [ ] Sprawdź terminal `completed`: compute odrzucone canonical 409.
- [ ] Disconnect/reconnect: last-good stale tylko w tym samym session epoch.
- [ ] Close/discard: purge cache/leases/providers; następna sesja nie adoptuje starego bufferu.
- [ ] Sprawdź console, HTTP status, ETag/revisions, WebSocket invalidations, adoption receipts, context loss, drawing buffer.
- [ ] Uruchom wybraną politykę 3D↔2D przez 100 zmian.

### 12.3 Wymagane połączenie dowodu

Każdy visible pass musi mieć łańcuch:

```text
request identity
→ HTTP response/ETag/revision
→ decoded buffer identity
→ exact topology/carrier/membership
→ derived build identity
→ renderer adoption receipt
→ frame commit/visualization ACK
→ glyph/item count
→ screenshot lub pixel probe
```

### 12.4 Komendy bazowe

```bash
pnpm --dir apps/control-room run generate:api
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room run lint
pnpm --dir apps/control-room run test
cargo test -p fullmag-quantities --no-fail-fast
cargo test -p fullmag-runner quantities --no-fail-fast
cargo test -p fullmag-api router_v2 --no-fail-fast
cargo test -p fullmag-cli interactive_runtime_host --no-fail-fast
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

Native FEM final proof używa właściwych managed recipes z `justfile`, w tym — zależnie od lane — `ensure-managed-fem-runtime`, `fem-managed-headless` lub repozytoryjnego `verify-fem-*-runtime`.

Browser/WebGL commands pozostają skryptami z `apps/control-room/package.json`, ale każdy musi produkować i walidować proof manifest.

### 12.5 Final report

Raport końcowy zawiera:

- implementation SHA i runtime component hashes;
- status każdego audytowego `F3D`, recenzyjnego `R3D` i przekrojowego `F3D-S`;
- PASS/FAIL/BLOCKED per source/API/runtime/browser/physical gate;
- linki/ścieżki do bundles i raw traces;
- brak słowa „production-ready”, jeśli choć jedna wymagana lane/gate pozostaje BLOCKED.

---

# 5. Dependency DAG i kolejność wykonania

```text
Task 0  Proof/addendum/preflight
  ├─> Task 1  Session identity
  │     ├─> Task 2  Quantity/carrier API
  │     │     ├─> Task 3  Airbox target + membership
  │     │     └─> Task 5  Retained observation runtime
  │     └─> Task 4  Per-carrier resource graph
  │             ├─> Task 6  Inspector stability
  │             └─> Task 7  ACK coordinator
  ├─> Task 8  R3F/tab lifecycle policy
  │     └─> Task 9  Cache/performance qualification
  └─> Task 10 Legacy/hygiene

Tasks 1–10 stable
  └─> Task 11 CI matrix
          └─> Task 12 real-model qualification and closure
```

Dozwolona równoległość:

- Task 2 Rust catalog/schema tests i Task 10 hygiene gate mogą rozpocząć się po Task 0.
- Task 8 baseline instrumentation może rozpocząć się po Task 0, lecz ostateczna polityka wymaga Task 9 metrics.
- Task 3 nie może finalizować persisted migration przed zatwierdzeniem Task 1 identity.
- Task 12 jest zawsze ostatni.

---

# 6. Skorygowana macierz zamknięcia

| Ustalenie | Zadanie | Wymagany dowód zamknięcia |
|---|---:|---|
| R3D-001 | 1, 12 | Cross-session delayed-response browser proof |
| R3D-002 | 2 | Catalog/fields/scalars capability contract |
| R3D-003 | 5, 12 | Real post-stage materialization all lane families |
| R3D-004 | 5, 12 | Accepted final frame parity for transitions |
| R3D-005 | 2, 12 | FEM `eden_*` catalog→materialize→surface adoption |
| R3D-006 | 5, 12 | Same `observation_frame_id` fields/energies |
| R3D-007 | 4 | Zero active `legacy-field-vector-hook` consumers + network proof |
| R3D-008 | 4 | Stable IDs under reorder, diagnostic-only zero field GET |
| R3D-009 | 2, 3, 12 | Exact component/scope/carrier rejection/adoption |
| R3D-010 | 4, 6 | One target failure does not affect others |
| R3D-011 | 5, 6, 12 | API + browser lifecycle/action matrix |
| R3D-012 | 0, 12 | Fresh self-identifying real-model bundles |
| R3D-013 | 4, 9 | Bounded concurrency latency/request budgets |
| R3D-014 | 8, 12 | Configure/event/context stress proof |
| R3D-015 | 8, 9, 12 | Chosen tab policy and 100-switch proof |
| R3D-016 | 9 | Byte-budget/eviction tests and trace |
| R3D-017 | 9, 12 | Raw performance traces |
| R3D-018 | 6 | No render-phase update + Inspector browser stability |
| R3D-019 | 2 | Selector generated from canonical metadata |
| R3D-020 | 10 | All suffix backups gone + canonical frontend path |
| R3D-021 | 8, 9 | Typed dirty reasons and frame attribution |
| R3D-022 | 11, 12 | Visible CI check matrix tied to SHA |
| F3D-S01 | 3, 12 | Outgoing canonical `airbox`, carrier separate |
| F3D-S02 | 3, 12 | Null/stale membership unavailable, zero invalid glyphs |

---

# 7. Finalne bramki akceptacyjne

| Gate | Wymaganie bezwzględne |
|---|---|
| G-01 Source identity | Audit base, implementation SHA, status hash i runtime-relevant dirty state są jawne. |
| G-02 Session identity | Cache/last-good/adoption zawiera current session epoch; delayed old response rejected. |
| G-03 Exact scope | Discriminated scope; full bez `scope_id`, scoped targets z niepustym ID. |
| G-04 Target/carrier separation | Publiczny target i techniczny carrier są osobnymi polami. |
| G-05 Membership | Active/inactive bez exact membership nie buduje passu. |
| G-06 Quantity planes | Capability, requestability, materialization, renderability i publication są odrębne. |
| G-07 Generic carriers | Nowa canonical scalar/vector quantity nie wymaga frontendowego branchu po ID. |
| G-08 Per-carrier isolation | Błąd jednego targetu nie degraduje innych; bounded concurrency. |
| G-09 Stable carrier identity | Fallback IDs są backend-owned/stable; diagnostic-only nie żąda pola. |
| G-10 Observation frame | Fields i energies mają ten sam accepted frame/provenance. |
| G-11 Lifecycle | `awaiting_command`, terminal `completed`, disconnect i discard mają jednoznaczne akcje. |
| G-12 Last-good | Tylko pełna zgodna identity; discard/session change purguje. |
| G-13 Adoption/ACK | Data adoption i visualization revision ACK są odrębne, ale korelowalne. |
| G-14 WebGL | Jeden zgodny context według wybranej policy, not lost, non-zero drawing buffer. |
| G-15 Performance | Zero nieuzasadnionych R3F idle frames/GET/ACK; quantity switch bez topology build. |
| G-16 Memory | Wszystkie derived caches mają byte budget; bounded heap/GPU po stress. |
| G-17 Inspector | Stable root/scroll/focus/draft; pending per-control; brak opacity animation. |
| G-18 Tab lifecycle | Jedna wybrana i zmierzona teardown/retained policy przechodzi 100 switch. |
| G-19 CI | Pełna visible matrix i wymagane check contexts dla implementation SHA. |
| G-20 Provenance | Każdy bundle ma hashe modelu/runtime/raw artifacts oraz exact lane/browser/GPU. |

---

# 8. Protokół stagingu i commitów

Przed każdym commitem:

```bash
git diff --name-only
git diff --cached --name-only
! git diff --cached --name-only | grep -Fx 'apps/control-room/next-env.d.ts'
! git diff --cached --name-only | grep -E '^external_solvers/3($|/)'
git diff --cached --check
```

Staging:

```bash
git add -p -- exact/file1 exact/file2 exact/test1
```

Zakazane:

```bash
git add .
git add apps/control-room/src
git add crates/fullmag-api/src
git commit -am ...
```

Każdy commit:

- subject po angielsku, poniżej 72 znaków;
- body wyjaśnia problem, identity/lifecycle invariant i wykonane testy;
- bez obcych zmian i bez ciężkich efemerycznych proof artifacts.

---

# 9. Warunki rozpoczęcia i zakończenia

## Start implementation PASS

- [ ] Addendum rozdzielające `F3D-001–F3D-016`, `R3D-001–R3D-022` i `F3D-S01/S02` istnieje.
- [ ] Implementation base SHA i protected dirty snapshot zapisane.
- [ ] Proof validator ma GREEN self-tests.
- [ ] Każdy workstream ma osobny plan wykonawczy z exact existing paths/symbols.
- [ ] Shared identity/scope/lifecycle contracts są zaakceptowane i niesprzeczne.

## Final closure PASS

- [ ] Wszystkie F3D-001–F3D-016, R3D-001–R3D-022 i F3D-S01/S02 mają świeży dowód zgodny z klasą bramki.
- [ ] Wszystkie G-01–G-20 mają PASS.
- [ ] Brak bramek oznaczonych `BLOCKED` jako substytutu PASS.
- [ ] Finalny audit report odróżnia source, test, API/runtime, browser/WebGL i physical proof.
- [ ] `production-ready` pojawia się tylko po pełnej kwalifikacji czterech real-model lane i CI matrix.
