# Region-Owned Etapy 1-4 Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not skip verification steps. Do not mark an etap ready without the exact evidence listed here.

**Goal:** Doprowadzic etapy 1-4 z `docs/plans/active/region-owned-production-readiness-rollout-plan-2026-06-07-pl.md` do jakosci produkcyjnej: typed authoring contract, kompletne region sub-object inspectors, bezpieczny mesh lifecycle z realnym region mesh-policy proof oraz material parameter fields z poprawna fizyka, provenance i capability gates.

**Architecture:** Region jest sub-obiektem obiektu wlasciciela, a nie drugim materialem fizycznym. Region dziedziczy geometry/material/texture/mesh/visualization parenta i moze lokalnie nadpisac wybrane aspekty bez niszczenia ostatniego poprawnego meshu. Python DSL, SceneDocument, OpenAPI v2, Control Room, `ProblemIR`, planner i runtime musza zachowac jeden authored intent oraz jawnie rozdzielac `authored`, `planned`, `realized`, `stale` i `blocked_by_capability`. Produkcyjna gotowosc jest orzekana per lane (`FDM CPU`, `FDM CUDA`, `FDM multilayer`, `FEM CPU`, `FEM GPU`); brak wsparcia w lane jest dopuszczalny tylko wtedy, gdy planner blokuje go przed runtime i UI pokazuje ten sam blocker.

**Tech Stack:** Rust (`fullmag-authoring`, `fullmag-ir`, `fullmag-plan`, `fullmag-api`, `fullmag-engine`, `fullmag-runner`), native FDM C/CUDA (`backends/fdm`, `native/include/fullmag_fdm.h`), native FEM/MFEM (`backends/fem`, `native/include/fullmag_fem.h`), Python DSL/meshing (`packages/fullmag-py`), Next/React Control Room (`apps/control-room`), OpenAPI v2 generated TypeScript.

---

## Status audytu i zakres planu

Plan zostal ponownie zweryfikowany 2026-06-07 przeciwko aktualnemu,
niezacommitowanemu checkoutowi. W chwili audytu worktree obejmowal zmiany w 99
plikach oraz nowe pliki region-owned. Plan nie zaklada czystego brancha i nie
upowaznia wykonawcy do resetowania zmian uzytkownika.

Ten dokument domyka dokladnie etapy 1-4 z planu nadrzednego:

| Etap nadrzedny | Zakres w tym dokumencie | Fazy wykonawcze |
|---|---|---|
| 1. Typed authoring contract | SceneDocument, API DTO, OpenAPI, generated TS, Python/UI round-trip | A, B |
| 2. Region sub-object inspectors | dedykowane inspektory, prawdziwe dziedziczenie, SI inputs, diagnostics | C |
| 3. Mesh policy i lifecycle | zachowanie ostatniego meshu, bounds, realny wplyw size fields, report | D, E, F |
| 4. Material parameter fields | conflict semantics, sampling, provenance, FDM CPU oracle, lane gates | G, H, I, J |

Etapy 1-4 moga uzyskac status produkcyjny mimo jawnie zablokowanej funkcji w
konkretnej lane tylko wtedy, gdy:

1. authored intent jest zachowany bez utraty danych,
2. capability gate dziala przed buildem albo uruchomieniem backendu,
3. UI pokazuje ten sam stabilny capability ID i komunikat,
4. nie istnieje silent fallback do wartosci parenta albo uniform material,
5. macierz gotowosci oznacza lane jako `blocked_by_capability`, a nie
   `supported`.

## Jak wykonywac ten plan

1. Kazdy task zaczyna sie testem lub audytem, ktory potrafi wykryc opisywana
   regresje. Nie wolno zaczynac od zmiany implementacji.
2. Po kazdym tasku uruchamiamy najwezszy test. Po zamknieciu fazy uruchamiamy
   bramke fazy. Pelny release candidate suite uruchamiamy dopiero w Phase K.
3. Nie wolno recznie edytowac plikow
   `apps/control-room/src/kernel/api/generated/openapi-v2-*`. Zmieniamy Rust
   schema, uruchamiamy generator i reviewujemy wygenerowany diff.
4. Nie wolno usuwac ani resetowac zmian spoza tego planu. Worktree jest brudny;
   przed kazda edycja trzeba ponownie przeczytac dotykany plik.
5. Zmiany natywnego FEM sa dowiedzione dopiero przez container-backed `just`.
   Hostowy `cargo`, `cmake` albo bezposredni binary run jest tylko diagnostyka.
6. Kazdy task powinien byc osobnym, reviewowalnym commitem. Nie laczymy zmian
   kontraktu, UI polish, meshera i fizyki w jednym commicie.
7. Gdy test ujawni, ze opisany symbol albo wlasciciel odpowiedzialnosci sie
   zmienil, najpierw aktualizujemy ten plan. Nie dopasowujemy implementacji do
   nieaktualnej nazwy z dokumentu.
8. Kazda faza ma dwa rozne wyniki:
   - `contract complete`: wszystkie typy, walidacje i capability gates sa
     spojne;
   - `runtime qualified`: kanoniczna lane wykonala wymagany runtime proof.
   Nie wolno zastapic drugiego wyniku pierwszym.
9. W etapach 1-4 nie rozszerzamy zakresu na RKKY runtime, nested regions,
   arbitrary CSG conformal split ani realized membership overlay.
10. Wykonawca prowadzi
    `docs/reports/region-owned-etap-1-4-execution-log-2026-06-07.md`. Po kazdej
    fazie zapisuje commit SHA bazowy, liste dotknietych plikow, dokladne
    komendy, exit codes, metryki i sciezki artefaktow.

## 0. Current-State Corrections

Ten plan byl zweryfikowany przeciwko aktualnemu checkoutowi w `/home/kkingstoun/git/fullmag/fullmag`. Worktree jest aktywny i brudny, wiec przed implementacja trzeba ponownie wykonac Phase A.

### 0.1 Rzeczy, ktore juz istnieja i nie wolno ich planowac od zera

| Obszar | Aktualny stan w kodzie | Konsekwencja dla planu |
|---|---|---|
| Typed create/patch contract | `crates/fullmag-api/src/schemas/authoring.rs` ma `ObjectRegionCreateRequest.region: SceneObjectRegion`, `ObjectRegionPatchRequest.patch: SceneObjectRegionPatch`; `apps/control-room/src/kernel/api/apiTypes.ts` uzywa generated `components["schemas"]`. | Etap 1 nie zaczyna od migracji z `JsonObject`; zaczyna od drift audit, tests i usuniecia pozostalych raw boundary. |
| Dedicated region panel files | Istnieja `ObjectRegionOverviewPanel.tsx`, `ObjectRegionGeometryPanel.tsx`, `ObjectRegionMagneticParametersPanel.tsx`, `ObjectRegionMeshPanel.tsx`, `ObjectRegionTexturePanel.tsx`, `ObjectRegionNestedRegionsPanel.tsx`, `ObjectRegionDiagnosticsPanel.tsx`. | Etap 2 nie ma tworzyc paneli od zera; ma usunac bledna semantyke, inline style debt, slabosc diagnostics i udowodnic routing. |
| Region visualization routing | `object.region.visualization` nadal routuje do ogolnego `ObjectVisualizationPanel`. | Zgodnie z `AGENTS.md` semantic node musi miec wlasny inspector contribution. Nalezy dodac region-owned wrapper/panel, nawet jezeli wspoldzieli niskopoziomowe sekcje wizualizacji. |
| Region authoring invalidation | `regionAuthoringInvalidationKeys()` invaliduje scene/model/diagnostics/material-fields, ale nie invaliduje `MESH_BUILD_CURRENT_RESOURCE_KEY` ani `MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY`. | Nie wolno przywracac mesh invalidation po create/patch/delete regionu. |
| Browser smoke Add Region | `apps/control-room/scripts/smoke-viewport-3d.mjs` ma `verifyRegionAuthoringOverlayFlow()`. Tworzy cylinder, czeka na scene/overlay, sprawdza brak stale safety view i canvas delta, ale nie dowodzi jeszcze niezmiennosci render mode/topology generation ani patch/delete flow. | Etap 3 lifecycle nie zaczyna od zera. Trzeba uczynic ten smoke deterministyczna release gate, zapisac before/after screenshots i udowodnic main mesh layer identity. |
| FDM material field sampling scaffold | `crates/fullmag-plan/src/fdm.rs` sampluje `Ms`, `Aex`, `Alpha` przez `resolve_spatial_parameter` i wpisuje `ms_field`, `a_field`, `alpha_field` do `FdmMaterialIR`. | Etap 4 nie ma pisac drugiej sciezki samplingu; ma udowodnic conflict resolution, CPU physics, CUDA/multilayer gates i provenance. |
| FDM CPU field model | `crates/fullmag-engine/src/fdm/shared/problem.rs` ma `ms_field`, `a_field`, `alpha_field`, walidacje i getters. `crates/fullmag-runner/src/fdm/cpu/reference.rs` przekazuje te pola. | Etap 4 musi sprawdzic, czy wszystkie termy fizyczne uzywaja lokalnych pol, nie tylko czy payload istnieje. |
| FDM CPU Taylor test | `crates/fullmag-engine/src/lib.rs` ma `spatial_material_fields_exchange_energy_field_taylor_consistency`. | Nie implementowac drugiego testu o tej samej tresci. Wzmocnic go o wspolny pair helper, region mask/exchange override oraz runner-level reachability. |
| CUDA native preflight | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` odrzuca cellwise `Ms/Aex/alpha`; `backends/fdm/api/c_api.cpp` ma defensywny fail-fast. | Etap 4 ma utrzymac pre-runtime gate i testy, nie dopuscic do poznego C ABI bledu jako pierwszego UX. |
| Region mesh-policy descriptors | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` buduje `region_mesh_policy` size fields dla box/cylinder/sphere; `mesh_build_report.py` liczy authored/realized region fields. | Etap 3 musi przejsc z descriptor proof do actual mesh-density proof. |
| Actual region mesh-density test | `test_arch_waveguide_skyrmion_core_refinement_actual_mesh_density` istnieje, ale w aktualnym kodzie tworzy `per_object_recipes` i przekazuje `None`, a asercje nie obejmuja reportu ani ratio. | Test trzeba utwardzic i ponownie uruchomic; samo istnienie testu nie jest dowodem przejscia. |
| Region mesh-policy `minimum_element_size` i `order` | `_size_field_plan.py` zapisuje oba pola jako metadata, ale `_gmsh_fields.py` nie realizuje lokalnego `MinimumElementSize`, a `Mesh.ElementOrder` jest zawsze `1`. | To jest P0 kontrakt drift. `minimum_element_size` musi byc realizowane albo jawnie odrzucone. Lokalny `order` nie jest wspierany przez obecny conforming MeshIR/solver-space i nie moze udawac zastosowanego. |
| Automatic FEM conformal OCC meshing | `_gmsh_occ.py` i `asset_pipeline.py` materializuja markery dla wspieranych conformal box/cylinder regionow; `FemDomainMeshAssetIR.object_region_markers` zachowuje ich tozsamosc. | Mesher contract istnieje. Nie implementowac go od zera i nie utozsamiac obecnosci markera z poprawnym runtime coefficient mapping. |
| FEM strict conformal runtime | Planner wymaga realnego markera w `mesh.element_markers`, ale sharp `Aex/Ms` strict path jest celowo zablokowany do czasu element/domain coefficient mapping przy jednym wspolnym polu `m`. | Produkcyjny status tej lane to `blocked_by_capability`, dopoki nie istnieje managed runtime proof bez duplikowania interface DOF. |
| Scene/import bounds validation | `fullmag-authoring::validation` sprawdza object-frame region AABB przeciw owner bounds; API create/patch/duplicate clampuja. | Nie implementowac trzeciej sciezki. Domknac parity testy, unknown-owner behavior, world-frame semantics i wspolny zestaw fixtures. |
| Material-field API summary | API potrafi wyliczyc `min/max/mean/sample_count`, ale dopasowuje `LatestFields` po nazwie parametru, nie po `assignment_id`/asset provenance. | Status moze zostac przypisany do niewlasciwego assignmentu. Etap 4 musi oprzec resource na plan/asset identity, nie na heurystyce parametru. |
| Material-field session publication | `crates/fullmag-api/src/session.rs::apply_current_live_metadata` recznie parsuje `metadata.execution_plan` jako JSON, kopiuje `ms_field/a_field/alpha_field` i wstawia je do `latest_fields`. | To jest tymczasowy control-plane/data-plane bypass. Etap 4 musi zastapic go typed asset manifestem i zasobem danych; nie wolno tylko rozbudowac parsera JSON. |

### 0.2 Aktualne blokery produkcyjne etapow 1-4

| Priorytet | Bloker | Dowod z kodu / znane ryzyko | Dlaczego blokuje |
|---|---|---|---|
| P0 | Browser-visible Add Region proof musi byc release gate | Smoke istnieje, ale potrzebuje stabilnego fixture, before/after artefaktow i asercji main mesh identity. | Uzytkownik raportowal regresje widoczna w UI, a nie tylko w modelu danych. |
| P0 | Region magnetic panel falszuje parent value | `ObjectRegionMagneticParametersPanel.tsx` zwraca `defaultMaterialOverrideValue(param)` gdy parent value jest nierozpoznany. | UI nie moze pokazywac default edit value jako fizycznej wartosci parenta. |
| P0 | Inline style debt w region panels | `rg "style={{"` trafia w region panels. | AGENTS/design system wymaga `fm-` classes i tokenow; inline style utrudnia produkcyjna jakosc. |
| P0 | Local region mesh policy silently overclaims `hmin/order` | Descriptor niesie `MinimumElementSize` i `Order`, ale Gmsh realization ich nie stosuje; geometric mesh jest zawsze first-order. | UI/report nie moga pokazywac parametru jako applied, gdy nie zmienia meshu. |
| P0 | Imported/direct scene bounds parity nie jest kompletna | Validation istnieje, ale obecne UI/API clampowanie jest oparte glownie na AABB; trzeba udowodnic parity dla obrotowego cylindra, world-frame, arch waveguide i unknown owner bounds. | Region musi byc podzbiorem rzeczywistego ciala parenta, a nie tylko jego bounding box. |
| P1 | Actual mesh proof jest zbyt waski | Test gęstosci istnieje, ale nie sprawdza reportu, ratio, transformu, rejected field ani paired disabled baseline. | Mesh policy moze przechodzic przypadkiem albo dzialac tylko dla obiektu w origin. |
| P1 | `MaterialFieldPlan` jest za ubogi | Ma object/parameter/source/location/warnings oraz aggregate statistics, ale nie ma `plan_id`, typed source refs, source region IDs, capability status ani domain generation identity. | API/UI nie moga poprawnie skorelowac authored assignmentu z planem i realized asset. |
| P1 | Material field provenance jest heurystyczne | API laczy latest field z assignmentem po parametrze, a nie po plan/asset identity. | Dwa assignmenty `Ms` moga dostac ten sam falszywy status/statystyki. |
| P1 | Material arrays sa kopiowane przez metadata JSON | `apply_current_live_metadata` odczytuje backend plan z `Value` i publikuje tablice do `latest_fields`. | Duzy payload trafia do control plane, provenance jest utracone, a API zalezy od ksztaltu serializacji execution planu. |
| P1 | Sampling wymaga kompletnego dowodu invariantow | Resolver ma post-sampling validation, ale testy musza pokryc linear/radial `Ms <= 0`, `Aex < 0`, `alpha < 0`, NaN i infinity z identyfikacja zrodla. | Walidacja deskryptora nie wystarcza; kazda zrealizowana probka musi byc legalna. |
| P1 | Object-frame sampling nie ma pelnego transformu ownera | Resolver przyjmuje tylko translacje; rotacja i dozwolona skala parenta nie sa czescia kanonicznego inverse transform. | Authoring w object frame musi byc niezalezny od polozenia i orientacji parenta. |
| P1 | FDM pair rule jest zduplikowany | Harmonic mean wystepuje osobno w field i energy. Taylor test przechodzi, ale implementacje moga sie rozjechac przy kolejnej zmianie. | Jedna funkcja ma byc jedynym zrodlem `A_ij`. |
| P2 | Full frontend gates moga miec unrelated debt | Wczesniejsze pamieci wskazuja, ze targeted Vitest byl stabilniejszy niz caly suite. | Raport musi rozroznic scoped proof od unrelated failures; nie wolno ukrywac failures. |

### 0.3 Definicja gotowości etapow 1-4

| Etap | Ready only when |
|---|---|
| 1: Typed authoring contract | Region/coupling/material-field payloady sa typed w Rust schemas, OpenAPI, generated TS, ControlRoomApi i round-trip Python/SceneDocument/export. Raw JSON zostaje tylko jako jawnie nazwany extension/import/merge-patch/forbidden-identity sentinel boundary z testem odrzucenia blednego payloadu. |
| 2: Region sub-object inspectors | Kazdy semantic `object.region.*` node, lacznie z Visualization, ma dedykowany inspector contribution; brak fabricated parent values; SI/scientific inputs; brak inline style debt; jasne inherited/local override labels; lokalne capability diagnostics; draft state nie nadpisuje server resources. |
| 3: Mesh policy and lifecycle | Region authoring nigdy nie wymusza edge-only safety view; latest successful mesh zostaje widoczny; region overlay pojawia sie po add; region mesh policy zmienia finalny mesh density w rzeczywistym buildzie; disabled policy jest invariant; kazdy authored parametr jest `applied`, `degraded` albo `rejected`, nigdy silently ignored. |
| 4: Material parameter fields | `Ms/Aex/Alpha` maja deterministyczne priority/conflict handling, post-sampling validation, assignment-level sample summaries/provenance, object-frame transform correctness, FDM CPU physics oracle, field/energy consistency proof, CUDA/multilayer gates i API/UI lifecycle diagnostics. |

### 0.3.1 Wiazace decyzje implementacyjne

Te decyzje nie sa opcjami do ponownego wyboru podczas implementacji:

| Temat | Decyzja |
|---|---|
| Equal-priority overlap | Dwa aktywne zrodla tego samego parametru na nakladajacym sie support i tym samym priority zawsze sa bledem, nawet jezeli ich stale wartosci sa rowne. Eliminuje to niejednoznaczne provenance. |
| Disabled region | Nie uczestniczy w conflict resolution, sampling, mesh fields ani capability gates. Payload nadal musi byc strukturalnie poprawny. |
| Mesh overlap | Dla `maximum_element_size` wygrywa mniejszy target. To nie jest regula material-field conflicts. |
| Region `maximum_element_size` | Wykonywalny lokalny target size. |
| Region `transition_distance` | Wykonywalny profil przejscia do parent target. |
| Region `minimum_element_size` | Non-null wartosc jest w pierwszym produkcyjnym wydaniu jawnie `rejected` z capability ID `mesh.region.local_hmin`. UI pokazuje pole read-only jako unsupported. Nie wolno raportowac jej jako applied, dopoki kompozycja Gmsh nie egzekwuje lokalnego floor bez kasowania wazniejszych refinement fields. |
| Region `order` | Lokalny p-order nie jest wspierany przez jeden conforming FE space. Wartosc pusta albo rowna globalnemu order jest normalizowana do `inherited_global`; inna wartosc jest odrzucana z capability ID `mesh.region.local_order`. |
| Bounds CRUD | UI moze clampowac draft. API create/patch/duplicate zwraca kanonicznie clampowany ksztalt i diagnostyke. |
| Bounds import | Import/replace scene nie zmienia cicho danych; odrzuca region wykraczajacy poza parenta. |
| Parent containment | AABB jest tylko szybkim filtrem. Status `supported` wymaga testowanego predicate rzeczywistej geometrii ownera. |
| Material plan identity | Deterministyczny `plan_id` laczy authored source refs z realized asset. Korelacja po samej nazwie parametru jest zabroniona. |
| Material arrays | Pelne tablice nie trafiaja do session metadata ani `latest_fields`; control plane publikuje manifest i statystyki, data plane publikuje values. |
| FEM conformal | Conformal mesh marker i conformal runtime coefficient mapping sa osobnymi capability. Marker nie moze tworzyc drugiego pola `m` ani duplikowac interface DOF. |
| Etap 4 verdict | FDM CPU moze byc `supported_validated`; CUDA, multilayer i FEM moga byc `blocked_by_capability` bez blokowania semantycznej gotowosci etapu, ale tylko przy testach pre-runtime gate. |

### 0.4 Produkcyjna macierz lane dla etapow 1-4

| Lane | Minimalny status po realizacji tego planu | Warunek |
|---|---|---|
| FDM CPU reference | `supported_validated` | Spatial `Ms/Aex/alpha`, region mask, harmonic/explicit/disabled exchange, Taylor test i runner test przechodza. |
| FDM CUDA | `blocked_by_capability` albo `supported_validated` | Jezeli kernels nie obsluguja cellwise fields, planner/runner blokuje przed C ABI. Nie wolno raportowac `supported`. |
| FDM multilayer | `blocked_by_capability` | Do czasu osobnej kwalifikacji region-owned material fields/couplings. |
| FEM CPU | `supported_with_constraints` | Smooth/projected fields tylko z jawna polityka; sharp strict tylko z realnym markerem. Managed runtime proof jest wymagany dla claimu wykonawczego. |
| FEM GPU | `blocked_by_capability` albo `supported_with_constraints` | Status zalezy od managed proof; host test nie zmienia capability. |
| UI authoring | `supported` | UI moze authorowac wszystkie semantyki, ale pokazuje lane-specific blockers przed build/run. |

---

## 1. Phase A: Baseline Audit and Guardrails

**Goal:** Ustalic aktualny stan i zapobiec poprawianiu nieaktualnego planu zamiast realnego kodu.

**Files:** read-only, chyba ze `git diff --check` wskaze whitespace w pliku dotykanym przez ten rollout.

- [ ] **A1: Capture dirty worktree without reverting unrelated changes**

  Run:

  ```bash
  git status --short
  git diff --stat
  ```

  Expected:

  - Execution notes list files touched by this implementation.
  - No unrelated dirty file is reverted.
  - If another agent/user edits a touched file during execution, reread it before patching.

- [ ] **A2: Verify current code still matches this plan**

  Run:

  ```bash
  rg -n "ObjectRegionCreateRequest|SceneObjectRegionPatch|SceneObjectRegion" crates/fullmag-api/src/schemas/authoring.rs apps/control-room/src/kernel/api/apiTypes.ts
  rg -n "object-region|object\\.region" apps/control-room/src/modules/inspector/inspectorRegistry.tsx apps/control-room/src/modules/inspector/panels/region
  rg -n "regionAuthoringInvalidationKeys|MESH_BUILD_CURRENT_RESOURCE_KEY|MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY" apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.ts apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.test.ts
  rg -n "resolveVisualizationRenderResolution|edge-only safety view|topologyFreshness" apps/control-room/src/kernel/visualization apps/control-room/src/modules/viewport-3d
  rg -n "ms_field|a_field|alpha_field|MaterialFieldPlan|resolve_spatial_parameter|object_region_markers" crates/fullmag-ir crates/fullmag-plan crates/fullmag-engine crates/fullmag-runner native backends
  ```

  Expected:

  - If a symbol moved, update this plan before coding.
  - If typed schemas regressed to raw JSON, Etap 1 becomes P0.
  - If region authoring invalidates mesh resources again, Phase D becomes P0 and must run before any UI polish.
  - Record the exact commit SHA and dirty-file list in the execution report so
    later evidence can be traced to one checkout.

- [ ] **A3: Baseline hygiene**

  Run:

  ```bash
  git diff --check
  ```

  Expected:

  - No whitespace errors in files touched by this rollout.
  - If unrelated files fail, record exact paths and do not claim global hygiene until resolved.

- [ ] **A4: Baseline targeted tests**

  Run:

  ```bash
  pnpm --dir apps/control-room exec vitest run \
    src/modules/inspector/panels/regionAuthoringInvalidation.test.ts \
    src/modules/inspector/panels/ObjectRegionsPanelModel.test.ts \
    src/modules/inspector/panels/RegionsListPanelModel.test.ts \
    src/modules/inspector/inspectorRegistry.test.tsx \
    src/modules/viewport-3d/layers/regionOverlayModel.test.ts \
    src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
  cargo test -p fullmag-ir --no-fail-fast
  cargo test -p fullmag-plan --no-fail-fast
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q
  ```

  Expected:

  - If dependencies are missing, install through repo-sanctioned path and rerun.
  - If tests fail, classify as pre-existing vs caused-by-this-work before editing.

- [ ] **A5: Capture current factual implementation matrix**

  Create an execution note table before any patch:

  ```markdown
  | Contract | Present | Test present | Runtime proof present | Gap |
  |---|---:|---:|---:|---|
  | typed region create | yes/no | yes/no | n/a | exact missing schema/test or none |
  | typed region patch | yes/no | yes/no | n/a | exact missing schema/test or none |
  | dedicated region visualization inspector | yes/no | yes/no | n/a | exact missing contribution/test or none |
  | Add Region preserves latest mesh | yes/no | yes/no | yes/no | exact missing smoke evidence or none |
  | region hmax affects final mesh | yes/no | yes/no | yes/no | measured density gap or none |
  | region hmin is rejected explicitly | yes/no | yes/no | yes/no | missing capability gate or none |
  | region order is inherited/rejected explicitly | yes/no | yes/no | yes/no | missing normalization/gate or none |
  | assignment-level material provenance | yes/no | yes/no | yes/no | missing identity/resource link or none |
  | FDM CPU spatial field physics | yes/no | yes/no | yes/no | missing term/test or none |
  | FDM CUDA spatial fields | yes/no | yes/no | yes/no | missing pre-runtime gate/kernel proof or none |
  | FEM sharp conformal path | yes/no | yes/no | yes/no | mesh proof/runtime blocker/runtime proof |
  ```

  Rules:

  - `present=yes` without a test is not production evidence.
  - `test present=yes` without running it in this checkout is not current
    evidence.
  - `runtime proof present=yes` requires the canonical lane-specific recipe.
  - Do not replace a missing executable capability with a documentation claim.

---

## 2. Phase B: Etap 1 Typed Authoring Contract

**Goal:** Domknac typed contract end-to-end. To nie jest rewrite; aktualny kod ma juz typed create/patch, wiec praca polega na audycie raw boundary, testach round-trip i uszczelnieniu import/patch validation.

**Files:**

- `crates/fullmag-authoring/src/scene.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `crates/fullmag-api/src/schemas/authoring.rs`
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- `crates/fullmag-api/src/router_v2/tests.rs`
- `apps/control-room/src/kernel/api/apiTypes.ts`
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `packages/fullmag-py/tests/test_api.py`

- [ ] **B1: Classify every raw JSON boundary**

  Run:

  ```bash
  rg -n "serde_json::Value|JsonObject|Record<string, unknown>|asRecord\\(|as any|as never" \
    crates/fullmag-authoring/src \
    crates/fullmag-api/src/schemas/authoring.rs \
    crates/fullmag-api/src/router_v2/handlers/model/authoring.rs \
    apps/control-room/src/kernel/api \
    apps/control-room/src/modules/inspector/panels \
    apps/control-room/src/modules/explorer/builders \
    apps/control-room/src/modules/viewport-3d/layers \
    packages/fullmag-py/src/fullmag/runtime
  ```

  Allowed boundaries:

  | Boundary | Allowed form | Required proof |
  |---|---|---|
  | CSG expression | Opaque expression payload only until CSG language is typed | Validation blocks unsupported runtime realization. |
  | JSON merge-patch internals | Internal `Value` only before conversion into `SceneObjectRegionPatch` | API tests reject identity mutation and invalid fields. |
  | Legacy/import adapter | Raw at adapter edge only | Tests normalize or reject with diagnostics. |
  | Forbidden identity sentinel | `SceneObjectRegionPatch.id/region_id/owner_object: Option<Value>` only if handler uses it solely to return the stable `cannot modify region identity` diagnostic | OpenAPI description marks fields forbidden; tests prove scene revision and stored object remain unchanged. |

  Not allowed:

  - `ObjectRegionCreateRequest.region: JsonObject`.
  - `ObjectRegionPatchRequest.patch: JsonObject`.
  - UI final model parsing known `SceneRegionShape` as arbitrary `Record<string, unknown>` when generated type is available.
  - `as any` to bypass generated region/coupling/material-field schemas.

  Wiazaca decyzja:

  - zachowaj `id`, `region_id` i `owner_object` jako forbidden identity
    sentinels, poniewaz stabilny komunikat `cannot modify region identity` jest
    czescia kontraktu authoring UX;
  - dodaj komentarz/schema description, ze pola sa przyjmowane tylko po to,
    aby zwrocic deterministyczny blad i nigdy nie sa stosowane;
  - dodaj `#[serde(deny_unknown_fields)]` do `SceneObjectRegionPatch`, aby
    pozostale literowki byly odrzucane na granicy deserializacji;
  - test z `"mesh_polciy"` musi zwrocic HTTP 400 i nie zmienic scene revision.

- [ ] **B2: Add API schema regression test for typed patch**

  In `crates/fullmag-api/src/router_v2/tests.rs`, ensure tests cover:

  ```rust
  // PATCH name/priority/shape/mesh_policy works through SceneObjectRegionPatch.
  // PATCH region_id returns HTTP 400 and scene revision does not change.
  // PATCH owner_object returns HTTP 400 and scene revision does not change.
  // PATCH id alias returns HTTP 400 if accepted by schema for rejection diagnostics.
  ```

  Expected response phrase:

  ```text
  cannot modify region identity
  ```

  If the existing phrase differs, keep the existing stable phrase and assert it.

  Also cover:

  ```rust
  // unknown field "mesh_polciy" returns HTTP 400;
  // invalid shape enum returns HTTP 400;
  // explicit null clears mesh_policy/texture_override/realization_policy;
  // omitted field preserves previous value;
  // base_revision conflict returns HTTP 409 and does not mutate scene.
  ```

- [ ] **B3: Add frontend facade regression test**

  In `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`, assert create/patch preserve typed payload:

  ```ts
  await api.model.createRegion(
    "arch_waveguide",
    {
      region_id: "arch_waveguide:skyrmion_core",
      owner_object: "arch_waveguide",
      name: "skyrmion_core",
      enabled: true,
      priority: 10,
      frame: "object",
      shape: {
        kind: "cylinder",
        radius: 8e-8,
        height: 2e-9,
        center: [0, 0, 0],
        axis: [0, 0, 1],
      },
      mesh_policy: null,
      material_overrides: [],
      texture_override: null,
      realization_policy: "inherit",
    },
    { baseRevision: 12 },
  );
  ```

  Assertions:

  ```ts
  expect(body.region.shape.kind).toBe("cylinder");
  expect(body.region.shape.radius).toBe(8e-8);
  expect(body.region.owner_object).toBe("arch_waveguide");
  ```

- [ ] **B4: Add Python/SceneDocument/script round-trip test**

  In `packages/fullmag-py/tests/test_api.py`, add or verify one test that:

  1. Creates magnet `film`.
  2. Adds region with explicit `region_id="film:skyrmion_core"`.
  3. Adds mesh policy and `Ms` override.
  4. Builds SceneDocument.
  5. Rebuilds builder from SceneDocument.
  6. Exports canonical Python script.

  Required assertions:

  ```python
  self.assertEqual(roundtripped_region.region_id, "film:skyrmion_core")
  self.assertIn("add_region", script)
  self.assertIn('region_id="film:skyrmion_core"', script)
  self.assertIn("maximum_element_size=1e-09", script)
  self.assertIn("Ms", script)
  ```

  Extend the same fixture with:

  - `texture_override`,
  - `realization_policy`,
  - a second region to prove ordering/stable ids,
  - one material parameter assignment with explicit `assignment_id`,
  - one disabled region to prove enabled state survives.

  Compare normalized semantic payloads, not raw JSON text order:

  ```python
  self.assertEqual(
      normalize_region_owned_semantics(roundtripped_problem),
      normalize_region_owned_semantics(original_problem),
  )
  ```

  Dodaj test-only helper `_normalize_region_owned_semantics` bezposrednio w
  `packages/fullmag-py/tests/test_api.py`, obok testu round-trip. Helper sortuje
  regiony po `region_id`, assignments po `assignment_id`, couplingi po
  `coupling_id` i usuwa wyłącznie pola runtime/provenance, ktore nie naleza do
  authored semantics. Nie dodawaj produkcyjnej abstrakcji tylko dla tej
  asercji.

- [ ] **B5: Add UI resource -> patch -> export semantic continuity test**

  This is not a browser screenshot test. It verifies the browser contract:

  1. Deserialize a `SceneResource` using generated
     `SceneObjectRegion`/`SceneObjectRegionPatch`.
  2. Build a region editor draft.
  3. Build the PATCH body.
  4. Apply the same patch through the Rust API test fixture.
  5. Export the resulting scene to Python.

  Required semantic equality:

  | Field | Expected |
  |---|---|
  | `region_id` | unchanged |
  | `owner_object` | unchanged |
  | `name` | patched |
  | `shape` | patched in SI |
  | `mesh_policy` | null/defined semantics preserved |
  | `material_overrides` | order and priorities preserved |
  | `texture_override` | asset/preset semantics preserved |
  | `realization_policy` | preserved |

  Keep frontend and backend tests separate if one cross-language fixture would
  be brittle. The shared fixture JSON must live under a test-fixture directory,
  not be duplicated as two hand-maintained payloads.

- [ ] **B6: Regenerate API only if schema changed**

  If `crates/fullmag-api/src/schemas/authoring.rs` changed, run:

  ```bash
  pnpm --dir apps/control-room generate:api
  ```

  Then verify:

  ```bash
  rg -n "ObjectRegionCreateRequest|ObjectRegionPatchRequest|SceneObjectRegionPatch" apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
  rg -n '"ObjectRegionCreateRequest"|"ObjectRegionPatchRequest"|"SceneObjectRegionPatch"' apps/control-room/src/kernel/api/generated/openapi-v2.json
  ```

- [ ] **B7: Etap 1 verification**

  Run:

  ```bash
  cargo test -p fullmag-authoring --no-fail-fast
  cargo test -p fullmag-api router_v2 --no-fail-fast
  pnpm --dir apps/control-room generate:api
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room exec vitest run \
    src/kernel/api/ControlRoomApi.test.ts \
    src/modules/inspector/panels/ObjectRegionsPanelModel.test.ts \
    src/modules/inspector/panels/RegionsListPanelModel.test.ts
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q
  ```

  Then run contract drift searches:

  ```bash
  rg -n "ObjectRegion(Create|Patch)Request.*JsonObject|region: JsonObject|patch: JsonObject" \
    apps/control-room/src/kernel/api apps/control-room/src/modules/inspector
  rg -n "as any|as never" \
    apps/control-room/src/modules/inspector/panels/region \
    apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts \
    apps/control-room/src/modules/inspector/panels/RegionsListPanelModel.ts
  ```

  Etap 1 ready only if all commands pass. Infrastructure failure may be
  documented during iteration, but must be rerun successfully before release.

---

## 3. Phase C: Etap 2 Region Sub-Object Inspectors

**Goal:** Region zachowuje sie w UI jak sub-obiekt. Kazdy semantic node ma dedykowany inspector, inherited values sa prawdziwe, local overrides sa lokalne, a capability blockers sa widoczne przy polach, ktorych dotycza.

**Files:**

- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- `apps/control-room/src/modules/inspector/panels/region/*.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionVisualizationPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionDiagnosticsPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionVisualizationPanel.test.tsx`
- Create: `apps/control-room/src/shared/domain/quantities/physicalScalar.ts`
- Test: `apps/control-room/src/shared/domain/quantities/physicalScalar.test.ts`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.test.ts`
- `apps/control-room/src/modules/inspector/panels/RegionsListPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/RegionsListPanelModel.ts`
- `apps/control-room/src/design/styles/*`

- [ ] **C1: Lock inspector routing**

  Add/verify test for registry mapping:

  ```ts
  expect(resolveInspectorPanel({ kind: "object.regions" })?.id).toBe("object-regions");
  expect(resolveInspectorPanel({ kind: "object.region" })?.id).toBe("object-region");
  expect(resolveInspectorPanel({ kind: "object.region.geometry" })?.id).toBe("object-region-geometry");
  expect(resolveInspectorPanel({ kind: "object.region.shape" })?.id).toBe("object-region-geometry");
  expect(resolveInspectorPanel({ kind: "object.region.magnetic-parameters" })?.id).toBe("object-region-magnetic-parameters");
  expect(resolveInspectorPanel({ kind: "object.region.material" })?.id).toBe("object-region-magnetic-parameters");
  expect(resolveInspectorPanel({ kind: "object.region.mesh" })?.id).toBe("object-region-mesh");
  expect(resolveInspectorPanel({ kind: "object.region.texture" })?.id).toBe("object-region-texture");
  expect(resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.id).toBe("object-region-texture");
  expect(resolveInspectorPanel({ kind: "object.region.regions" })?.id).toBe("object-region-regions");
  expect(resolveInspectorPanel({ kind: "object.region.diagnostics" })?.id).toBe("object-region-diagnostics");
  expect(resolveInspectorPanel({ kind: "object.region.visualization" })?.id).toBe("object-region-visualization");
  ```

  `object.region.visualization` jest obecnie zgrupowany z ogolnym
  `ObjectVisualizationPanel`. Dodaj dedykowany contribution/wrapper. Moze on
  wspoldzielic model i sekcje niskiego poziomu, ale musi rozwiazywac wylacznie
  region visualization target i nie moze przypadkiem patchowac parent object.

- [ ] **C2: Fix fabricated parent material values**

  In `ObjectRegionMagneticParametersPanel.tsx`, replace fallback:

  ```ts
  return {
    value: defaultMaterialOverrideValue(param),
    unit: defaultMaterialOverrideUnit(param),
  };
  ```

  with explicit unresolved state. Required type:

  ```ts
  type ParentParamInfo =
    | { status: "resolved"; unit: string; value: number | string }
    | { status: "field"; fieldKind: string; unit: string }
    | { status: "unavailable"; reason: string; unit: string };
  ```

  UI rules:

  | Parent resolution | UI text |
  |---|---|
  | Parent constant number | `<value> <unit> (inherits parent)` |
| Parent authored field | `<kind> field (inherits parent)` |
| Parent unavailable | `parent value unavailable` plus diagnostic reason |
  | Local override exists | `<value> <unit> (local override)` |

  `defaultMaterialOverrideValue(param)` may be used only when creating a new
  local override draft, never as inherited physics. Add tests for resolved
  constant, parent field, unavailable parent and local override. The lookup
  test must include two objects so owner scoping is proven.

- [ ] **C3: Remove inline styles from region panels**

  Run:

  ```bash
  rg -n "style=\\{\\{" apps/control-room/src/modules/inspector/panels/region apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx apps/control-room/src/modules/inspector/panels/RegionsListPanel.tsx
  ```

  Replace inline styles with `fm-` prefixed classes and token CSS. Example:

  ```tsx
  <div className="fm-region-inherited-parameters">
  <div className="fm-region-override">
  <div className="fm-region-panel-actions">
  ```

  CSS must use existing `--fm-*` tokens. Do not introduce raw Catppuccin hex values inside components.

  Completion search:

  ```bash
  rg -n "style=\\{\\{|#[0-9A-Fa-f]{3,8}" \
    apps/control-room/src/modules/inspector/panels/region \
    apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx \
    apps/control-room/src/modules/inspector/panels/RegionsListPanel.tsx
  ```

  Expected: no inline styles and no raw color literals in these components.

- [ ] **C4: Move physical scalar parsing into a shared, dimension-aware helper**

  Current parser accepts scientific numeric strings only and lives in a
  region-specific model. Move parser/formatter semantics to
  `src/shared/domain/quantities/physicalScalar.ts`. The parser must know the
  physical dimension, not only strip arbitrary suffixes.

  Required API:

  ```ts
  type PhysicalScalarDimension =
    | "length"
    | "magnetization"
    | "exchange-stiffness"
    | "energy-density"
    | "dimensionless";

  type PhysicalScalarParseResult =
    | { ok: true; valueSi: number; normalizedText: string }
    | { ok: false; message: string };
  ```

  Required tests:

  ```ts
  expect(parsePhysicalScalar("1e-9", "length")).toMatchObject({ ok: true, valueSi: 1e-9 });
  expect(parsePhysicalScalar("1 nm", "length")).toMatchObject({ ok: true, valueSi: 1e-9 });
  expect(parsePhysicalScalar("800 kA/m", "magnetization")).toMatchObject({ ok: true, valueSi: 800e3 });
  expect(parsePhysicalScalar("13 pJ/m", "exchange-stiffness")).toMatchObject({ ok: true, valueSi: 13e-12 });
  expect(parsePhysicalScalar("0.1", "dimensionless")).toMatchObject({ ok: true, valueSi: 0.1 });
  expect(parsePhysicalScalar("1 nm", "magnetization").ok).toBe(false);
  expect(parsePhysicalScalar("", "length").ok).toBe(false);
  ```

  Do not use `<input type="number">` for physical values. Use text input with
  `inputMode="decimal"`. Priority may remain numeric integer control. Region
  mesh `order` is resolved by Phase F and must not appear as an executable
  local control while the runtime ignores it.

- [ ] **C5: Make nested regions panel explicit**

  `ObjectRegionNestedRegionsPanel.tsx` must display this semantic content:

  ```text
  Nested regions are not supported in v1. This region inherits its parent object and cannot currently own child regions.
  ```

  It must not show `degraded`, `inherits none`, or placeholder copy that looks like a broken feature.

- [ ] **C6: Add field-local capability diagnostics**

  Region magnetic and mesh panels must render diagnostics next to the relevant editor for:

  - material override authored but backend cannot execute it,
  - mesh policy requires unsupported realization,
  - `realization_policy=conformal` lacks real conformal marker,
  - `realization_policy=project` is accepted only in extended mode,
  - unsupported texture override backend.

  Required display shape:

  ```text
  severity: warning|error
  code: stable diagnostic code
  capability_gate: optional backend gate
  realization_status: authored_pending|planned_sampled|realized_asset_available|blocked_by_capability
  message: actionable text
  ```

  Diagnostics come from the typed resource hook/API. React must not recreate
  planner legality by parsing backend names or warning strings.

- [ ] **C7: Verify region texture and visualization are scoped**

  Required:

  - `object.region.texture` edits only `texture_override`, not parent texture.
  - `object.region.visualization` resolves a region target and never patches the
    parent object target.
  - If editable region visualization is not implemented, the dedicated panel
    says `inherits object visualization` and shows read-only overlay diagnostics.
  - Texture/visualization edits do not invalidate mesh topology resources.

- [ ] **C8: Verify draft ownership and selection transitions**

  Add tests for:

  ```text
  region A dirty draft -> select region B -> B gets clean draft
  region A dirty draft -> server revision changes -> draft is preserved and conflict is shown
  apply succeeds -> draft rekeys to committed revision
  apply fails -> draft and user-entered SI text remain available
  ```

  Canonical scene/model data stays in resource hooks. Unsaved edits stay in
  inspector draft state. Do not copy full SceneResource into a module store.

- [ ] **C9: Accessibility and action semantics**

  Verify:

  - every editor has an accessible label,
  - validation error is connected through `aria-describedby`,
  - delete uses the shared confirmation dialog,
  - pending mutations disable duplicate/save/delete,
  - icon-only actions use Lucide icon plus tooltip/accessible name,
  - Enter cannot submit an invalid partial draft.

- [ ] **C10: Etap 2 verification**

  Run:

  ```bash
  pnpm --dir apps/control-room exec vitest run \
    src/shared/domain/quantities/physicalScalar.test.ts \
    src/modules/inspector/inspectorRegistry.test.tsx \
    src/modules/inspector/panels/ObjectRegionsPanel.test.ts \
    src/modules/inspector/panels/ObjectRegionsPanelModel.test.ts \
    src/modules/inspector/panels/RegionsListPanelModel.test.ts
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room lint
  ```

  Also produce screenshot/manual evidence for:

  - Geometry panel with SI inputs.
  - Magnetic Parameters panel showing inherited parent value and local override.
  - Magnetic Parameters panel showing `parent value unavailable` when parent cannot be resolved.
  - Mesh panel showing region mesh policy.
  - Texture panel showing region-scoped/inherited texture state.
  - Visualization panel showing region target rather than parent target.
  - Diagnostics panel grouped by source.

---

## 4. Phase D: Etap 3 Mesh Lifecycle and Add Region Viewport Proof

**Goal:** Add/Patch/Delete Region never destroys or hides latest successful mesh. The only visible change from Add Region is the authored region overlay.

**Files:**

- `apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.ts`
- `apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.test.ts`
- `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/layers/RegionOverlayLayer.tsx`
- `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts`
- `apps/control-room/scripts/smoke-viewport-3d.mjs`

- [ ] **D1: Strengthen invalidation tests**

  `regionAuthoringInvalidation.test.ts` must assert:

  ```ts
  expect(keys).not.toContain(MESH_BUILD_CURRENT_RESOURCE_KEY);
  expect(keys).not.toContain(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY);
  expect(keys).not.toContain(resolveObjectMeshReportResourceKey("film"));
  expect(keys).not.toContain(resolveObjectMeshQualityResourceKey("film"));
  ```

  Also assert `publishRegionAuthoringScene()` writes committed scene data into the resource runtime store immediately, so overlay can appear without topology rebuild.

- [ ] **D2: Lock stale-vs-unknown visualization behavior**

  Dodaj test regresji przez aktualny fixture builder
  `createVisualizationResolutionInput()`; ustaw tylko pole
  `topologyFreshness`, pozostawiajac pozostale wymagane pola fixture bez zmian:

  ```ts
  const stale = createVisualizationResolutionInput();
  stale.topologyFreshness = "stale";
  expect(resolveVisualizationRenderResolution(stale).degradedReasons).toEqual([]);

  const unknown = createVisualizationResolutionInput();
  unknown.topologyFreshness = "unknown";
  expect(
    resolveVisualizationRenderResolution(unknown).degradedReasons[0]?.message,
  ).toContain("edge-only safety view");
  ```

  If existing test fixture names differ, use current fixture helper. The semantic assertion is non-negotiable: `stale` remains renderable.

- [ ] **D3: Ensure region authoring does not create mesh dirty/building tags**

  Run:

  ```bash
  rg -n "mesh:dirty|mesh:building|topologyFreshness|source_scene_revision" apps/control-room/src/modules/inspector crates/fullmag-api/src/router_v2/handlers/model/authoring.rs apps/control-room/src/modules/viewport-3d
  ```

  Create/patch/delete/duplicate region must not set tags that make topology freshness `unknown`. If a rebuild recommendation is needed, expose it as region diagnostic:

  ```json
  {
    "code": "region_mesh_policy_requires_rebuild",
    "severity": "info",
    "realization_status": "authored_pending"
  }
  ```

- [ ] **D4: Harden the existing browser smoke for the exact reported regression**

  `verifyRegionAuthoringOverlayFlow()` already creates a cylinder region and
  asserts no safety-view text. Extend that exact public flow; do not create a
  second mocked smoke path.

  The smoke must:

  1. Load a workspace/session with latest successful mesh visible.
  2. Record before-state:
     - visualization target key,
     - render mode,
     - topology generation/revision,
     - main mesh layer count,
     - non-zero drawing buffer,
     - deterministic canvas sample/screenshot.
  3. Add a cylinder region through Explorer -> Inspector -> Add Region.
  4. Wait for committed scene plus model region resource revisions to settle.
  4. Assert:

  ```js
  assert(!visibleText.includes("Mesh topology is stale; rendering an edge-only safety view"));
  assert(!visibleText.includes("edge-only safety view"));
  assert(webglDrawingBufferNonZero === true);
  assert(regionOverlayCount >= 1);
  assert(mainMeshLayerStillVisible === true);
  assert(afterRenderMode === beforeRenderMode);
  assert(afterTopologyGeneration === beforeTopologyGeneration);
  assert(afterMainMeshLayerCount === beforeMainMeshLayerCount);
  ```

  5. Patch the region center/radius and assert only overlay transform changes.
  6. Delete the region and assert overlay disappears while all recorded main
     mesh identities remain unchanged.

  If overlay count is not currently observable, expose a development/smoke
  diagnostic attribute on the overlay group. Do not couple test code to
  private Three.js object traversal.

- [ ] **D5: Screenshot proof**

  Run:

  ```bash
  CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
  CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
  ```

  Required visual evidence:

  - Before Add Region: main mesh shaded in current visualization mode.
  - After Add Region: same main mesh mode, plus region wireframe/transparent overlay.
  - After Patch Region: same main mesh, moved/resized overlay.
  - After Delete Region: same main mesh, overlay absent.
  - No safety-view text.
  - No forced global wireframe mode.

- [ ] **D6: Etap 3 lifecycle verification**

  Run:

  ```bash
  pnpm --dir apps/control-room exec vitest run \
    src/modules/inspector/panels/regionAuthoringInvalidation.test.ts \
    src/kernel/visualization/visualizationDisplayResolution.test.ts \
    src/modules/viewport-3d/layers/regionOverlayModel.test.ts \
    src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
    src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
  pnpm --dir apps/control-room typecheck
  CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
  ```

  `ALLOW_MISSING_SESSION=1` may be used during iteration, but release evidence
  must use a real session fixture with a successful mesh. A skipped region flow
  is not a pass.

---

## 5. Phase E: Region Bounds Enforcement Across UI/API/Import

**Goal:** Region in `frame=object` cannot be larger than or outside parent. UI, API and imported SceneDocument validation must agree. Owner AABB containment is only a first gate; production containment means the region volume is a subset of the real owner geometry, not merely its bounding box.

**Files:**

- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- `apps/control-room/src/modules/inspector/panels/RegionsListPanelModel.ts`
- Create: `apps/control-room/src/shared/domain/geometry/objectRegionContainment.ts`
- Test: `apps/control-room/src/shared/domain/geometry/objectRegionContainment.test.ts`
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- `crates/fullmag-api/src/router_v2/tests.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `crates/fullmag-authoring/src/scene.rs`
- Create: `crates/fullmag-authoring/src/region_containment.rs`
- Create: `crates/fullmag-authoring/tests/fixtures/region_containment_v1.json`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/tests/test_meshing.py`

- [ ] **E1: Centralize owner bounds resolution**

  Usun duplikacje z `ObjectRegionsPanelModel.ts` i
  `RegionsListPanelModel.ts`. Frontendowa implementacja ma byc jednym helperem
  w `shared/domain/geometry/objectRegionContainment.ts`. Autorytatywna
  implementacja Rust ma byc w `fullmag-authoring::region_containment`.

  Required v1 bounds:

  | Owner shape | Bounds rule |
  |---|---|
  | Box | exact local extents |
  | Cylinder | bounding box `[-r,r] x [-r,r] x [-h/2,h/2]` |
  | ArchWaveguide | conservative bounding box from authored dimensions |
  | Unknown/imported | no silent clamp; show `owner bounds unavailable` and reject strict save/import |

  Zachowaj jeden canonical geometry-containment contract:

  ```text
  region authored shape
      -> transform from region frame to owner-local frame
      -> cheap owner AABB reject/clamp
      -> owner-shape containment check
      -> canonical clamped/rejected result
  ```

  The TypeScript helper may mirror the Rust algorithm for immediate UX, but
  Rust authoring validation is authoritative. Put shared frontend math in one
  `shared/domain/geometry` helper; do not keep copies in
  `ObjectRegionsPanelModel.ts` and `RegionsListPanelModel.ts`.

  Oba helpery musza zwracac ten sam typed wynik:

  ```text
  inside
  clamped { canonical_shape, changed_axes }
  rejected { code, message }
  unsupported { capability_id, message }
  ```

  Nie zwracaj samego `bool`, poniewaz API musi odroznic bezpieczna
  kanonikalizacje CRUD od niebezpiecznego rewrite importu.

- [ ] **E2: Clamp UI drafts on every shape edit**

  Clamp these operations:

  - create default region,
  - change shape kind,
  - edit center,
  - edit size/radius/height,
  - duplicate region,
  - apply patch.

  Required test examples:

  ```ts
  // parent bounds size [100e-9, 50e-9, 4e-9]
  // cylinder radius 80e-9 -> radius <= 25e-9
  // center x 80e-9 with radius 25e-9 -> center x <= 25e-9
  // height 10e-9 -> height <= 4e-9
  ```

  Add:

  ```text
  rotated cylinder axis [1,1,0] remains inside owner
  translated owner + object-frame region resolves correctly
  world-frame region is transformed before validation, not skipped
  sphere inside cylinder owner is rejected/clamped when it enters AABB corner outside cylinder
  region inside arch-waveguide AABB but outside physical arch body is rejected
  ```

- [ ] **E3: API create/patch/duplicate enforces same rule**

  Production rule:

  - UI may clamp optimistically.
  - API must not trust UI.
  - API CRUD may clamp deterministically and return the clamped scene.
  - Direct import/SceneDocument validation should reject impossible bounds, because silently rewriting imported science is risky.

  Add tests for create, patch and duplicate.

  API response must make canonicalization visible. If CRUD clamps a shape,
  return the clamped scene and a stable informational diagnostic:

  ```text
  code: object_region_shape_clamped_to_owner
  ```

  Do not silently alter imported SceneDocument data. Import/replace-scene uses
  validation failure because rewriting scientific input without an explicit
  authoring action is unsafe.

- [ ] **E4: Scene/import validation catches bypasses**

  Add test:

  ```rust
  // scene object box 100 nm x 50 nm x 4 nm
  // region cylinder radius 1 um
  // validation emits error mentioning region outside owner bounds
  ```

  Required diagnostic phrase:

  ```text
  object region exceeds owner bounds
  ```

  If current validation framework uses codes, define code:

  ```text
  object_region_exceeds_owner_bounds
  ```

  Add a distinct diagnostic for AABB-contained but shape-outside-owner:

  ```text
  object_region_exceeds_owner_geometry
  ```

- [ ] **E5: Define supported containment algorithms**

  | Owner geometry | Required v1 check |
  |---|---|
  | Box | exact analytic extents |
  | Cylinder | exact analytic radial/axial containment for box/sphere/cylinder region support points |
  | Ellipsoid | exact normalized quadratic check for region support points |
  | ArchWaveguide | analytic point predicate `abs(y)<=width/2` i `abs(z-(z0+arch_height*sin(pi*(x/length+1/2))))<=height/2` dla `x` w zakresie; containment primitive regionu uzywa certyfikowanego adaptive boundary subdivision |
  | Imported closed mesh | robust point-in-mesh/inside predicate po jego jawnej implementacji; do tego czasu strict authoring rejection z `owner containment unavailable` |
  | Arbitrary CSG | use canonical CSG predicate; if unavailable, capability-block create/import |

  Dla nontrivial region shapes sprawdzenie tylko center i AABB corners jest
  zabronione. Uzyj:

  - analytic support extents dla box/sphere wewnatrz box/cylinder/ellipsoid;
  - osi cylindra znormalizowanej przed obliczeniem support;
  - adaptive subdivision powierzchni regionu dla ArchWaveguide, z maksymalnym
    bledem przestrzennym `min(owner_min_extent, region_min_extent) * 1e-6` i
    absolutnym floor `1e-15 m`;
  - tego samego JSON fixture w Rust i TypeScript;
  - finalnego Gmsh OCC containment/fragment testu jako build-time guard dla
    wspieranej FEM conformal sciezki.

  Adaptive test nie jest dowodem dla arbitrary imported mesh ani CSG. Te
  geometrie pozostaja `unsupported` i blokowane przed zapisem/importem.

- [ ] **E6: Bounds verification**

  Run:

  ```bash
  pnpm --dir apps/control-room exec vitest run \
    src/shared/domain/geometry/objectRegionContainment.test.ts \
    src/modules/inspector/panels/ObjectRegionsPanelModel.test.ts \
    src/modules/inspector/panels/RegionsListPanelModel.test.ts
  cargo test -p fullmag-api router_v2 --no-fail-fast
  cargo test -p fullmag-authoring --no-fail-fast
  ```

  Add one shared JSON fixture consumed by Rust and TypeScript tests so both
  layers agree on accepted/rejected/clamped shapes. Compare SI values within a
  documented tolerance.

---

## 6. Phase F: Etap 3 Actual Region Mesh-Policy Proof

**Goal:** Region mesh policy changes the realized mesh, not only authored descriptors.

**Files:**

- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
- `packages/fullmag-py/tests/test_meshing.py`
- `packages/fullmag-py/tests/test_api.py`
- `crates/fullmag-ir/src/mesh_assets.rs` if report schema changes
- `crates/fullmag-api/src/schemas/mesh.rs` if report is exposed through API

- [ ] **F0: Freeze executable semantics of every RegionMeshPolicy field**

  Current implementation overclaims two fields:

  - `minimum_element_size` is copied into descriptor metadata but not consumed
    by the Gmsh region field;
  - `order` is copied into descriptor metadata while geometric topology is
    intentionally generated with `Mesh.ElementOrder=1` and FE order is global.

  Zastosuj wiazace rozstrzygniecie z sekcji 0.3.1. W tym rollout nie
  implementujemy regionalnego floor ani lokalnego p-refinement:

  | Field | v1 production semantics |
  |---|---|
  | `maximum_element_size` | local target size inside region; executable |
  | `transition_distance` | distance over which target returns to parent size; executable |
  | `minimum_element_size` | `null` oznacza brak lokalnego floor; non-null blokuje mesh build przed Gmsh z capability ID `mesh.region.local_hmin` i statusem `rejected` |
  | `order` | `null` albo wartosc rowna globalnemu FE order daje status `inherited_global`; inna wartosc blokuje build z capability ID `mesh.region.local_order` |

  Required tests:

  ```text
  setting hmin returns capability mesh.region.local_hmin before Gmsh generation
  setting local order=2 on global order=1 returns capability mesh.region.local_order
  local order equal to global order is normalized to inherited_global
  old SceneDocument payload containing hmin/order round-trips unchanged but build is rejected when semantics are unsupported
  ```

  Nie usuwaj pol ze SceneDocument/Python DSL w tym rollout, poniewaz zerwaloby
  to round-trip istniejacych skryptow. UI ma pokazac je jako zachowane,
  niewykonywalne ustawienia z capability diagnostic. Mesh report musi zapisac
  requested value i `rejected`, nie `applied`.

- [ ] **F1: Extract reusable actual mesh-density helpers**

  The actual density test already exists but contains inline edge-statistics
  code. Extract helpers near the region mesh-policy tests:

  ```python
  def _tet_edge_lengths(points, tet):
      edges = (
          (tet[0], tet[1]), (tet[0], tet[2]), (tet[0], tet[3]),
          (tet[1], tet[2]), (tet[1], tet[3]), (tet[2], tet[3]),
      )
      return [float(np.linalg.norm(points[a] - points[b])) for a, b in edges]

  def _element_centroids(points, elements):
      return np.asarray([points[np.asarray(tet, dtype=int)].mean(axis=0) for tet in elements])

  def _median_edge_length_for_mask(points, elements, mask):
      lengths = []
      for tet in np.asarray(elements, dtype=int)[mask]:
          lengths.extend(_tet_edge_lengths(points, tet))
      if not lengths:
          raise AssertionError("expected at least one tetrahedron in measurement mask")
      return float(np.median(lengths))
  ```

- [ ] **F2: Harden the existing skyrmion-core actual mesh test**

  Keep `test_arch_waveguide_skyrmion_core_refinement_actual_mesh_density`; do
  not add a duplicate. Fix these weaknesses:

  - pass the declared `per_object_recipes` instead of constructing it and then
    passing `None`;
  - measure core, transition shell and far bulk separately;
  - exclude tetrahedra whose centroid/edges straddle the region boundary from
    the strict core metric;
  - verify build report and `_gmsh_status`;
  - include a relative ratio so the test is robust to small Gmsh variation;
  - record element/node counts and quality minima for failure diagnostics.

  Required scenario:

  - Parent arch/film bulk hmax around `18e-9` to `20e-9`.
  - Region cylinder radius around `35e-9` centered at skyrmion core.
  - Region mesh policy hmax around `3e-9`,
    `minimum_element_size=None`, `order=1` equal to global order, transition
    distance around `35e-9`.

  Required assertions:

  ```python
  self.assertLess(core_median, 6e-9)
  self.assertGreater(bulk_median, 10e-9)
  self.assertLess(core_median, bulk_median * 0.65)
  self.assertEqual(report.authored_regions_count, 1)
  self.assertEqual(report.realized_regions_count, 1)
  self.assertEqual(region_field["_gmsh_status"], "applied")
  self.assertEqual(region_field["params"]["RegionId"], "waveguide:skyrmion_core")
  ```

  If Gmsh output requires threshold adjustment, adjust geometry/hmax first. Do
  not weaken this into descriptor-only proof. A skipped test due missing Gmsh
  is not release evidence; the release environment must install the
  repo-declared Python meshing dependencies.

- [ ] **F3: Replace the coarse disabled test with a paired invariance test**

  The current test only asserts that one disabled build has a coarse median.
  Build the same deterministic geometry twice:

  1. no regions,
  2. same region with `enabled=False` and mesh policy.

  Required assertion:

  ```python
  self.assertEqual(region_size_fields_disabled, [])
  self.assertEqual(disabled_report.authored_regions_count, 0)
  self.assertEqual(disabled_report.realized_regions_count, 0)
  self.assertEqual(disabled_mesh.elements.shape, baseline_mesh.elements.shape)
  self.assertEqual(disabled_mesh.nodes.shape, baseline_mesh.nodes.shape)
  ```

  Because Gmsh reproducibility options are fixed in `_apply_mesh_options`, exact
  counts should match. If topology ordering is not stable across supported
  Gmsh versions, compare sorted quality/edge histograms with a documented
  tolerance instead of weakening to `median >= 10 nm`.

- [ ] **F4: Add region identity and executable parameter provenance to every field**

  Every emitted region field descriptor must contain:

  ```python
  {
      "Source": "region_mesh_policy",
      "RegionId": "waveguide:skyrmion_core",
      "OwnerObject": "waveguide",
      "Requested": {
          "maximum_element_size": 3e-9,
          "minimum_element_size": None,
          "transition_distance": 5e-9,
          "order": 1,
      },
      "Effective": {
          "maximum_element_size": 3e-9,
          "minimum_element_size": None,
          "transition_distance": 5e-9,
          "order": 1,
          "order_status": "inherited_global",
      },
  }
  ```

  Keep Gmsh-only parameters separate from authored request metadata. This lets
  reports explain normalization/rejection without reverse-engineering a MathEval
  expression.

- [ ] **F5: Every region size field has a terminal Gmsh status**

  In `_gmsh_fields.py`, every region mesh-policy field must report:

  ```python
  field["_gmsh_status"] = "applied"
  ```

  or:

  ```python
  field["_gmsh_status"] = "rejected"
  field["_gmsh_reason"] = "region local minimum_element_size is not executable"
  field["_gmsh_capability_gate"] = "mesh.region.local_hmin"
  ```

  Normalize legacy `ignored` into:

  - `degraded` only when an explicit, documented fallback was applied;
  - `rejected` when authored semantics were not realized.

  No enabled authored region mesh policy may be silently ignored. A required
  rejected field fails the mesh build before solver start.

- [ ] **F6: Verify object-frame transforms**

  Add descriptor and actual-mesh tests for:

  - translated owner,
  - rotated owner,
  - non-unit owner scale, jezeli publiczny kontrakt transformacji na nia pozwala; w przeciwnym razie stabilne odrzucenie,
  - arbitrary cylinder axis,
  - world-frame region.

  `frame=object` must use the same full transform contract as geometry and
  viewport overlays. Adding only `owner_center` is insufficient for rotation.
  If non-rigid scale is unsupported, reject it with a stable diagnostic.

- [ ] **F7: Mesh report provenance**

  Ensure report exposes:

  - `authored_regions_count`,
  - `realized_regions_count`,
  - region IDs with mesh policy,
  - field kind/source per applied region policy,
  - rejection reason per unsupported shape/policy,
  - descriptor-only vs Gmsh-applied status.
  - requested versus effective `hmax/hmin/transition/order`,
  - `mesh_generation_id` and source scene revision,
  - per-region core/transition element statistics where available.

  `realized_regions_count` must count unique region IDs, not raw size-field
  descriptors. One region may legitimately lower into multiple Gmsh fields.

- [ ] **F8: Degenerate/quality gate attributes failures to region source**

  When tetra quality or degenerate-element validation fails, report:

  ```text
  region_id
  owner_object
  Gmsh field id/kind
  requested/effective policy
  minimum volume / quality metric
  failure phase
  ```

  Do not silently retry without the region field. A fallback that changes
  authored refinement requires explicit `degraded` status and user-visible
  provenance.

- [ ] **F9: Etap 3 mesh verification**

  Run:

  ```bash
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
    packages/fullmag-py/tests/test_meshing.py \
    -k "RegionMeshPolicy or region_mesh_policy or skyrmion_core_refinement or disabled_policy" -vv
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_api.py -q
  cargo test -p fullmag-plan --no-fail-fast
  ```

  Etap 3 mesh-policy verdict must include measured values:

  ```text
  core median edge:
  transition median edge:
  bulk median edge:
  core/bulk ratio:
  authored region count:
  realized region count:
  Gmsh status:
  minimum tetra quality:
  ```

---

## 7. Phase G: Etap 4 Material Field Planning, Conflict Semantics and Provenance

**Goal:** Material parameter fields have deterministic planning summaries, conflict handling and API/UI lifecycle diagnostics before backend execution.

**Files:**

- `crates/fullmag-ir/src/model.rs`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-authoring/src/adapters.rs`
- `packages/fullmag-py/src/fullmag/model/problem.py`
- `crates/fullmag-ir/src/plan.rs`
- `crates/fullmag-plan/src/material.rs`
- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/fem.rs`
- `crates/fullmag-plan/src/tests.rs`
- `crates/fullmag-api/src/schemas/authoring.rs`
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- `crates/fullmag-api/src/router_v2/tests.rs`
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionDiagnosticsPanel.tsx`

- [ ] **G1: Nadaj planom i aktywom jednoznaczna tozsamosc**

  Obecne laczenie zasobu API z `LatestFields` po samej nazwie parametru jest
  niepoprawne. Dwa assignmenty `Aex` w roznych regionach nie moga przejmowac
  nawzajem statystyk ani statusu realizacji.

  Rozszerz plan tylko o metadane potrzebne do diagnostyki i korelacji. Nie
  umieszczaj pelnych tablic w planie:

  ```rust
  pub struct MaterialFieldPlan {
      pub plan_id: String,
      pub object_id: String,
      pub parameter: MaterialParameterNameIR,
      pub source_kind: MaterialFieldSourceKind,
      pub source_refs: Vec<MaterialFieldSourceRefIR>,
      pub source_region_ids: Vec<String>,
      pub realization_location: MaterialFieldLocationIR,
      pub requires_sampling: bool,
      pub requires_mesh_revision: bool,
      pub warnings: Vec<String>,
      pub sample_count: Option<u64>,
      pub min: Option<f64>,
      pub max: Option<f64>,
      pub mean: Option<f64>,
      pub realization_status: MaterialFieldRealizationStatusIR,
      pub capability_gate: Option<String>,
      pub mesh_generation_id: Option<String>,
  }

  #[serde(tag = "kind", rename_all = "snake_case")]
  pub enum MaterialFieldSourceRefIR {
      Assignment {
          assignment_id: String,
      },
      RegionOverride {
          region_id: String,
          parameter: MaterialParameterNameIR,
      },
  }
  ```

  Uzyj istniejacego wspolnego enumu statusu, a jesli go nie ma, dodaj jeden
  kanoniczny typ uzywany przez planner, OpenAPI i UI:

  ```rust
  pub enum MaterialFieldRealizationStatusIR {
      AuthoredPending,
      PlannedSampled,
      RealizedAssetAvailable,
      BlockedByCapability,
      Rejected,
  }
  ```

  `plan_id` musi byc deterministyczny dla tego samego ProblemIR. Zalecany
  format:

  ```text
  material-field-plan:{object_id}:{parameter}:{stable_hash(source_refs)}
  ```

  Nie uzywaj UUID generowanego podczas planowania. Sortuj
  kanoniczne `source_refs` i `source_region_ids` przed hashowaniem oraz
  serializacja. `RegionOverride` ma stabilna tozsamosc
  `region_override:{region_id}:{parameter}`; walidacja musi gwarantowac najwyzej
  jeden inline override danego parametru w jednym regionie. Nie dodawaj
  losowego `override_id` tylko po to, aby uzyskac provenance.

  Realized asset musi wskazywac:

  ```text
  plan_id
  source_refs
  object_id
  parameter
  location
  sample_count
  mesh_generation_id albo grid_generation_id
  ```

  Jezeli istniejacy runtime asset nie ma miejsca na te dane, rozszerz jego
  typed IR/provenance. Nie zapisuj ich w niekontrolowanym `serde_json::Value`.

- [ ] **G2: Rozdziel authored assignment, zlozony plan i realized asset**

  Zdefiniuj jawnie trzy poziomy:

  | Poziom | Tozsamosc | Zawartosc |
  |---|---|---|
  | Authored assignment | `assignment_id` | region/obiekt, parametr, pole, priority, conflict policy |
  | Inline region override | `region_id + parameter` | lokalny override zapisany bezposrednio w regionie |
  | Material field plan | `plan_id` | uporzadkowany zestaw assignmentow skladajacy jeden parametr obiektu |
  | Realized asset | `asset_id` + `plan_id` | tablica cell/node oraz statystyki i generation ID |

  Jeden plan moze skladac wiele assignmentow tego samego parametru. Endpoint
  listujacy authored assignments powinien zwracac status wynikajacy z planu,
  ktory jawnie zawiera jego `assignment_id`. Endpoint planow/aktywow moze
  zwracac rekord zagregowany, ale nie wolno podszywac go pod pojedynczy
  assignment. Region resource laczy inline override przez typowany
  `RegionOverride`, nie przez heurystyke parametru.

  Wlasciciele danych:

  | Dane | Warstwa |
  |---|---|
  | Plan i male statystyki | typed execution-plan/provenance control plane |
  | Asset manifest | session/artifact catalog resource |
  | Pelna tablica values | binary/data-plane field store lub artefakt Zarr |
  | Inspector status | material-field resource z revision i linkiem do assetu |

  `latest_fields` nie jest rejestrem material assets. Moze nadal obslugiwac
  kompatybilne quantity preview, ale nie jest zrodlem statusu ani provenance
  assignmentu.

  Rejestruj realized material array w istniejacym field store jako scalar
  quantity:

  ```text
  quantity_id = material_field.<first_16_hex_chars_of_plan_hash>
  component_count = 1
  location = cell | node
  ```

  `MaterialFieldAssetIR` oraz `MaterialParameterFieldResource` przechowuja ten
  `quantity_id`. Values sa pobierane przez:

  ```text
  GET /v2/sessions/current/data/fields/{quantity_id}/meta
  GET /v2/sessions/current/data/fields/{quantity_id}/samples/vector?format=bin
  ```

  Nie tworz nowej rodziny endpointow tylko dla material fields. Rozszerz
  istniejacy scalar-field codec, jezeli `component_count=1` nie jest jeszcze
  obslugiwany przez `samples/vector`.

- [ ] **G3: Oblicz statystyki przez istniejacy resolver**

  Reuse `resolve_spatial_parameter`. Do not add a second evaluator.

  Required summary behavior:

  | Situation | Summary |
  |---|---|
  | No mesh/grid sample points | `sample_count=null`, status `authored_pending`, warning says sampling not available yet. |
  | Cell/grid sampled FDM | `sample_count=cell_count`, min/max/mean finite, status `planned_sampled`. |
  | Node sampled FEM | `sample_count=node_count`, min/max/mean finite, status `planned_sampled`. |
  | Backend gate blocks | status `blocked_by_capability`, warning includes capability gate. |

  Po probkowaniu wykonaj ponowna walidacje wartosci:

  | Parametr | Warunek wszystkich aktywnych probek |
  |---|---|
  | `Ms` | finite i `> 0` |
  | `Aex` | finite i `>= 0` |
  | `alpha` | finite i `>= 0` |

  Blad musi zawierac `assignment_id`, `region_id`, parametr, indeks probki i
  wadliwa wartosc. Nie wolno dopuscic `NaN`, infinity ani `Ms=0` do backendu.

- [ ] **G4: Ujednolic transformacje probkowania**

  `frame=object` musi uzywac pelnej transformacji obiektu, tej samej co
  geometria, overlay i meshing: translacja, rotacja oraz dozwolona skala.
  Wywolanie resolvera z `[0,0,0]` jako zastepcza translacja nie jest
  produkcyjne.

  Dodaj kanoniczny transform do `MagnetIR`, poniewaz aktualny `MagnetIR`
  przechowuje tylko `name`, `region`, `material` i initial magnetization:

  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  pub struct ObjectTransformIR {
      #[serde(default)]
      pub translation: [f64; 3],
      #[serde(default = "identity_rotation_quat")]
      pub rotation_quat: [f64; 4],
      #[serde(default = "unit_scale")]
      pub scale: [f64; 3],
      #[serde(default)]
      pub pivot: [f64; 3],
  }
  ```

  `MagnetIR.object_transform` ma `#[serde(default)]`, aby stare ProblemIR byly
  identity-compatible. Zasady migracji:

  1. SceneDocument `SceneObject.transform` jest zrodlem prawdy.
  2. Python lowering zapisuje transform do `MagnetIR.object_transform`.
  3. Legacy `GeometryEntryIR::Translate` jest czytany tylko jako fallback dla
     starych IR bez jawnego transformu.
  4. Jawny non-identity transform oraz legacy Translate w tym samym obiekcie
     nie moga zostac zastosowane podwojnie; normalizer sklada je raz i zapisuje
     provenance `legacy_geometry_translate_normalized`.
  5. Niejednorodna skala jest odrzucana dla region/material-field sampling z
     capability ID `regions.object_frame.nonuniform_scale`.

  Utworz jeden planner helper:

  ```rust
  pub(crate) fn world_to_object_point(
      transform: &ObjectTransformIR,
      world: [f64; 3],
  ) -> Result<[f64; 3], String>
  ```

  Kolejnosc inverse transform:

  ```text
  world
    -> subtract translation
    -> translate around pivot
    -> inverse normalized quaternion rotation
    -> divide by uniform positive scale
    -> restore object-local pivot
  ```

  `resolve_spatial_parameter` przyjmuje `&ObjectTransformIR`, nie sama
  translacje. `evaluate_parameter_field` i `point_in_region_shape` dostaja juz
  punkt w odpowiedniej ramce; nie moga ponownie odejmowac translacji.

  Dodaj testy plannerow FDM i FEM dla:

  - przesunietego obiektu,
  - obroconego obiektu,
  - regionu `frame=object`,
  - regionu `frame=world`,
  - niedozwolonej nierownomiernej skali.

  Te same fizyczne punkty musza otrzymac te same wartosci niezaleznie od lane.

  Dodaj rowniez round-trip test:

  ```text
  SceneObject.transform
    -> ProblemIR MagnetIR.object_transform
    -> planner sampling
    -> exported Python
  ```

  Quaternion w fixture musi byc niebanalny, np. obrot 90 stopni wokol osi Z.

- [ ] **G5: Zamknij semantyke konfliktow**

  Add planner/IR tests:

  | Case | Expected |
  |---|---|
  | same parameter, same priority, same value, overlapping support | error |
  | same parameter, same priority, different value, overlapping support | error |
  | same parameter, same priority, disjoint support | allowed |
  | same parameter, different priority | higher priority wins |
  | different parameter in overlapping regions | allowed |
  | disabled region with override | ignored, no plan blocker |

  Test both `material_overrides` and `material_parameter_fields` if both can express the case.

  Nie porownuj wartosci, aby zalegalizowac equal-priority overlap. Zgodnie z
  masterplanem sam fakt dwoch aktywnych wlascicieli tej samej property na tym
  samym priority jest niejednoznaczny i blokuje. Konflikt musi byc rozstrzygany
  przed backendem i raportowac oba `assignment_id` albo typed
  `RegionOverride` source refs.

  Obecne walidacje SceneDocument/ProblemIR rozpoznaja przede wszystkim support
  object-wide oraz ten sam `region_id`. Rozszerz je o rzeczywisty overlap
  roznych region shapes:

  1. dla wspieranych analytic shapes (`box`, `sphere`, `cylinder`) uzyj
     kanonicznego shape-overlap predicate z tolerancja geometryczna;
  2. dla CSG albo owner transform, ktorego predicate nie obsluguje, nie uznawaj
     regionow za rozlaczne na podstawie roznych IDs; zwroc capability
     `regions.overlap_resolution_unavailable`;
  3. planner sampling wykonuje dodatkowy punktowy guard i blokuje, jezeli dwie
     equal-priority definicje sa aktywne w tej samej probce.

- [ ] **G6: API material field resources wystawiaja prawdziwy lifecycle**

  Material field endpoint must expose:

  ```json
  {
    "parameter": "Ms",
    "owner_object_id": "film",
    "source_region_id": "film:core",
    "realization_status": "planned_sampled",
    "realization_location": "cell",
    "sample_count": 64,
    "min": 760000.0,
    "max": 800000.0,
    "mean": 790000.0,
    "capability_gate": null
  }
  ```

  If values are not available, use `null` and `authored_pending`. Do not invent statistics.

  Handler API nie moze wyszukiwac pola przez `parameter` alone. Korelacja:

  ```text
  assignment_id -> MaterialFieldPlan.source_refs[kind=assignment]
                -> realized asset.plan_id
  ```

  Dodaj test z dwoma assignmentami `Aex` w roznych regionach, gdzie tylko
  jeden jest czescia zrealizowanego planu. Drugi musi pozostac
  `authored_pending`, a nie odziedziczyc statystyk pierwszego.

  OpenAPI musi miec typowane pola `plan_id`, `assignment_id` albo
  `region_override` source ref,
  `source_region_id`, status, location, stats i capability gate. Po zmianie
  uruchom generator i sprawdz, ze frontend nie dodaje recznych duplikatow typow.

  Usun tymczasowy blok `REDO ETAP 4` z
  `crates/fullmag-api/src/session.rs::apply_current_live_metadata`. API nie
  moze parsowac `metadata.execution_plan` jako dowolny JSON ani kopiowac
  pelnych tablic materialowych do `latest_fields`.

  Zastap go typed publication:

  ```text
  runner/planner
    -> MaterialFieldAssetIR lub typed asset manifest
    -> session artifact/resource registry
    -> /v2/sessions/current/model/material-fields (status + stats + asset ref)
    -> /v2/sessions/current/data/fields/{quantity_id}/samples/vector
  ```

  Wybierz istniejacy field-store/artifact pipeline. Nie tworz nowego transportu
  tylko dla regionow. Duze arrays nie moga trafic do thin status ani execution
  metadata.

- [ ] **G7: UI pokazuje lifecycle bez zgadywania**

  Region magnetic panel must show for every local override/field:

  - authored pending,
  - planned sampled on cells/nodes,
  - blocked with capability message,
  - realized asset available.

  Diagnostics panel groups by:

  - Authoring,
  - Mesh,
  - Material Fields,
  - Couplings,
  - Backend Capability.

  UI renderuje status zwrocony przez zasob. Nie wyprowadza statusu z obecnosci
  meshu, nazwy backendu ani lokalnego draftu. Po zmianie revision zasob jest
  uniewazniany przez centralny resource/realtime path.

- [ ] **G8: Testy planowania i provenance**

  Dodaj testy:

  ```text
  deterministic_plan_id_is_stable_across_replanning
  material_field_plan_lists_all_typed_source_refs
  duplicate_inline_override_for_same_region_parameter_is_rejected
  api_does_not_cross_assign_statistics_between_same_parameter_assignments
  sampled_ms_zero_is_rejected_before_backend
  sampled_nan_is_rejected_before_backend
  object_frame_sampling_honors_owner_rotation
  realized_asset_generation_id_must_match_current_domain
  session_metadata_does_not_copy_material_arrays_into_latest_fields
  material_field_resource_resolves_typed_asset_manifest_by_plan_id
  material_field_values_are_fetched_through_existing_data_plane
  ```

- [ ] **G9: Etap 4 planning/provenance verification**

  Run:

  ```bash
  cargo test -p fullmag-ir --no-fail-fast
  cargo test -p fullmag-plan --no-fail-fast
  cargo test -p fullmag-api router_v2 --no-fail-fast
  pnpm --dir apps/control-room generate:api
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room exec vitest run \
    src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.test.tsx \
    src/modules/inspector/panels/region/ObjectRegionDiagnosticsPanel.test.tsx \
    src/kernel/resources/geometryLifecycleResources.test.ts
  ```

---

## 8. Phase H: Etap 4 FDM CPU Physics Oracle

**Goal:** FDM CPU reference is the trusted physics oracle for spatial `Ms_i`, `A_i`, `alpha_i` and region exchange semantics.

**Files:**

- `crates/fullmag-engine/src/fdm/shared/problem.rs`
- `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- `crates/fullmag-runner/tests/physics_validation.rs`
- existing engine tests

- [ ] **H1: Audit all local material getters**

  Run:

  ```bash
  rg -n "saturation|Ms|ms_at|exchange_stiffness|a_at|alpha_at|damping|MU0|mu0|anisotropy|DMI|demag" crates/fullmag-engine/src/fdm
  ```

  Required:

  - Exchange denominator uses local `Ms_i`.
  - Exchange pair stiffness uses harmonic `A_ij`.
  - Exchange field and exchange energy use the same pair rule.
  - LLG damping uses local `alpha_i`.
  - Any term still uniform is capability-gated or documented as unsupported for spatial parameter.

- [ ] **H2: Wyodrebnij jedna implementacje reguly parowej**

  Use one helper for field and energy:

  ```rust
  fn pair_exchange_stiffness(ai: f64, aj: f64) -> f64 {
      if ai == 0.0 || aj == 0.0 {
          0.0
      } else {
          2.0 * ai * aj / (ai + aj)
      }
  }
  ```

  Do not duplicate harmonic mean logic in separate field/energy implementations.

- [ ] **H3: Wzmocnij istniejacy test Taylora**

  Test `spatial_material_fields_exchange_energy_field_taylor_consistency`
  juz istnieje. Nie dodawaj duplikatu. Sprawdz, czy rzeczywiscie przechodzi
  przez produkcyjny helper pola i energii po wyodrebnieniu H2.

  Setup:

  - grid `4 x 3 x 1`,
  - nonuniform `A_i` left/right halves,
  - nonuniform `Ms_i`,
  - normalized non-collinear `m`,
  - tangent perturbation `dm_i` with `dm_i dot m_i = 0`.

  Assertion:

  ```rust
  let eps = 1e-7;
  let finite_diff = (e_plus - e_minus) / (2.0 * eps);
  let analytic = -MU0 * cell_volume * sum_i(ms_i * h_ex_i.dot(dm_i));
  assert_relative_eq!(finite_diff, analytic, epsilon = 1e-5, max_relative = 5e-4);
  ```

  Rozszerz parametr testu o:

  - co najmniej dwie wartosci `A`,
  - co najmniej dwie wartosci `Ms`,
  - komorki na granicy regionow,
  - jawny override pair coupling,
  - przypadek `scale=0`, w ktorym energia i pole przez interfejs znikaja.

- [ ] **H4: Wzmocnij runner reachability do testu zachowania**

  Istniejacy test `spatial_material_fields_cpu_reference_reaches_oracle`
  potwierdza glownie zakonczenie wykonania. Zmien fixture na niejednorodna,
  niekolinearna magnetyzacje i porownaj z uniform baseline.

  Wymagane asercje:

  ```text
  effective field differs from uniform baseline above numerical tolerance
  one deterministic integration step differs from uniform baseline
  total exchange energy is finite
  result provenance identifies CPU reference lane and material plan_id
  ```

  Test nie moze korzystac z jednorodnego `m`, dla ktorego exchange jest
  trywialnie zerowy.

- [ ] **H5: Udowodnij lokalny damping**

  Dodaj maly test integratora z identycznym `Ms/Aex`, ale dwoma wartosciami
  `alpha`. Po jednym deterministycznym kroku komorki musza miec rozna
  skladowa tlumienia zgodna z lokalnym `alpha_i`. Oddziel ten dowod od
  exchange, aby awaria wskazywala konkretny kontrakt.

- [ ] **H6: FDM CPU verification**

  Run:

  ```bash
  cargo test -p fullmag-engine --no-fail-fast
  cargo test -p fullmag-runner spatial_material --no-fail-fast
  cargo test -p fullmag-runner physics_validation --no-fail-fast
  ```

---

## 9. Phase I: Etap 4 Native FDM CUDA and Multilayer Gates

**Goal:** Unsupported material fields are blocked before native C ABI or CUDA kernels can silently ignore them.

**Files:**

- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- `backends/fdm/api/c_api.cpp`
- `backends/fdm/tests/region_owned_abi_contract.cpp`

- [ ] **I1: Keep C ABI fail-fast as defensive layer**

  `backends/fdm/api/c_api.cpp` may reject unsupported `ms_field/a_field/alpha_field`, but it must not be the first user-facing diagnostic.

- [ ] **I2: Zweryfikuj istniejacy native CUDA preflight**

  Preflight i defensywny C API gate juz istnieja. Audytuj je i dodaj tylko
  brakujacy test jednostkowy, bez tworzenia drugiego stosu walidacji:

  ```rust
  #[test]
  fn native_fdm_cuda_rejects_cellwise_material_fields_before_c_backend() {
      let mut plan = minimal_native_fdm_plan_for_test();
      plan.material.ms_field = Some(vec![800e3; cell_count]);
      let err = reject_unsupported_cellwise_material_fields(&plan).unwrap_err();
      assert!(err.to_string().contains("does not yet support cellwise material fields"));
  }
  ```

  Use existing helper/function names. Do not invent a parallel error stack.

- [ ] **I3: Zweryfikuj gate multilayer**

  Dodaj/zweryfikuj planner albo runner test z konkretnym fixture:

  ```rust
  #[test]
  fn multilayer_planner_rejects_spatial_material_fields_until_rhs_coverage_exists() {
      let mut problem = multilayer_problem_for_test();
      problem.layers[0].material.ms_field = Some(vec![800e3; layer_cell_count(&problem, 0)]);
      let error = plan_multilayer(problem)
          .expect_err("multilayer cellwise material fields must be capability-gated");
      assert!(error
          .to_string()
          .contains("fdm.cuda.multilayer.cellwise_material_fields"));
  }
  ```

  Nazwy helperow w powyzszym fixture sa kontraktem testowym tej fazy. Jezeli
  aktualny modul ma juz odpowiedniki, rozszerz istniejace helpery zamiast
  tworzyc drugi model problemu.

  Diagnostic must mention multilayer FDM specifically.

- [ ] **I4: Wystaw capability w jednej macierzy i API**

  Planner, provenance i UI musza pokazac ten sam stabilny capability ID, np.:

  ```text
  fdm.cuda.cellwise_material_fields
  fdm.cuda.multilayer.cellwise_material_fields
  ```

  Nie koduj komunikatu UI przez dopasowanie tekstu bledu. Zaktualizuj
  kanoniczna capability matrix, planner diagnostics i odpowiedni zasob
  OpenAPI. `RequireRuntime` blokuje run; nie degraduje do uniform material.

- [ ] **I5: Native gate verification**

  Run:

  ```bash
  cargo test -p fullmag-plan multilayer --no-fail-fast
  cargo test -p fullmag-runner native_fdm_cuda_rejects_cellwise_material_fields --no-fail-fast
  ```

  Dodatkowo sprawdz, ze wywolanie z unsupported field nie dociera do mocka C
  ABI. To jest dowod polozenia gate, nie tylko tresci komunikatu.

---

## 10. Phase J: FEM Capability Boundaries Without Overclaiming Etapy 1-4

**Goal:** Etapy 1-4 korzystaja z istniejacego FEM material-field i conformal
meshing infrastructure tylko tam, gdzie istnieje dowod. Automatyczny conformal
OCC mesh dla wspieranych shapes nie oznacza jeszcze poprawnego sharp-interface
runtime. Brakujaca realizacja jest blokowana przed solverem.

**Files:**

- `crates/fullmag-ir/src/mesh_assets.rs`
- `crates/fullmag-plan/src/fem.rs`
- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-plan/src/tests.rs`
- `native/include/fullmag_fem.h`
- `crates/fullmag-runner/src/native_fem.rs`
- `backends/fem/core/fem_material_fields.*`
- `backends/fem/cpu/mfem/interactions/exchange_operator.*`
- `backends/fem/cpu/mfem/interactions/exchange_mass_projection.*`
- `backends/fem/cpu/mfem/runtime/mfem_context.*`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/tests/test_meshing.py`

- [ ] **J1: Keep region markers separated**

  Verify:

  - `FemDomainMeshAssetIR.region_markers` are object/domain markers.
  - `FemDomainMeshAssetIR.object_region_markers` are authored-region markers.
  - Strict conformal validation checks `object_region_markers`.
  - Metadata-only object-region marker does not satisfy conformal gate unless marker appears in `mesh.element_markers`.

- [ ] **J2: Verify strict nonconformal sharp field gate**

  Test must assert:

  ```text
  requires conformal boundary
  realization_policy='project'
  ```

  for sharp `Ms/Aex` without real conformal marker in strict or without explicit project policy in extended.

- [ ] **J3: Separate conformal mesh proof from conformal runtime proof**

  Mesher test must assert:

  - supported box/cylinder region creates a real
    `object_region_markers` entry;
  - marker occurs in `mesh.element_markers`;
  - region remains owned by parent object;
  - unsupported shape, overlap i out-of-owner region fail without projection
    fallback;
  - generated mesh passes the existing degenerate/quality gate.

  Planner/runtime gate test must assert:

  - marker-only sharp `Aex/Ms` path is blocked with capability ID
    `fem.region.element_coefficients_shared_m`;
  - blocker wystepuje przed native context creation;
  - region marker is not packed as a second magnet segment;
  - interface nodes are not duplicated to create separate `m` unknowns.

- [ ] **J4: Qualify projection and keep strict sharp runtime blocked**

  Final readiness report must state:

  ```text
  FEM conformal OCC meshing for supported box/cylinder authored regions:
  implemented and mesh-tested.

  FEM strict sharp Aex/Ms runtime on authored region markers:
  blocked by capability fem.region.element_coefficients_shared_m until
  element/domain coefficients operate on one shared magnetization field
  without duplicated interface DOF.

  FEM projected nodal fields:
  supported only in extended mode with realization_policy=project, explicit
  warning/provenance and successful managed runtime proof.
  ```

  Nie wolno zmienic strict gate na warning tylko po to, aby fixture doszedl do
  backendu. Poprawna implementacja strict path wymaga:

  1. element/domain `A` i `Ms` coefficient mapping,
  2. jednego wspolnego FE space dla `m`,
  3. naturalnej ciaglosci `m`,
  4. flux continuity wynikajacej z weak form,
  5. field/energy directional-derivative testu na sharp interface,
  6. managed CPU i GPU proof przed zmiana capability statusu.

- [ ] **J5: FEM verification**

  Host diagnostics:

  ```bash
  cargo test -p fullmag-plan fem_sharp_aex --no-fail-fast
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
    packages/fullmag-py/tests/test_meshing.py \
    -k "conformal and object_region" -vv
  cargo check -p fullmag-runner --no-default-features
  ```

  Native FEM runtime proof, if claimed, must use repo managed/container route:

  ```bash
  just ensure-managed-fem-runtime
  ```

  Dla projection runtime uruchom repo recipe wskazane przez `just --list`.
  Jezeli OpenMPI/PMIx nie moze utworzyc socketu w sandboxie, wynik jest
  `environment_blocked`, nie `passed`. Host `cargo`, host `cmake` ani
  bezposredni native binary nie sa finalnym FEM runtime evidence.

---

## 11. Phase K: Final Production Readiness Report for Etapy 1-4

**Goal:** Produce evidence-heavy report. `Ready` is allowed only for etapy that pass their gates.

**Files:**

- Create: `docs/reports/region-owned-etap-1-4-production-readiness-2026-06-07.md`
- Update status/evidence links in: `docs/plans/active/region-owned-production-readiness-rollout-plan-2026-06-07-pl.md`

- [ ] **K1: Backend/IR/planner/API tests**

  Run:

  ```bash
  cargo test -p fullmag-authoring --no-fail-fast
  cargo test -p fullmag-ir --no-fail-fast
  cargo test -p fullmag-plan --no-fail-fast
  cargo test -p fullmag-engine --no-fail-fast
  cargo test -p fullmag-runner --no-fail-fast
  cargo test -p fullmag-api router_v2 --no-fail-fast
  ```

  Jezeli pelny `fullmag-runner` wymaga zewnetrznego runtime, uruchom
  repo-deklarowany `just` target i opisz host test jako diagnostyczny, nie
  dowod produkcyjnego native runtime.

- [ ] **K2: Python DSL/meshing tests**

  Run:

  ```bash
  PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py packages/fullmag-py/tests/test_meshing.py -q
  ```

- [ ] **K3: Frontend gates**

  Run:

  ```bash
  pnpm --dir apps/control-room generate:api
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room lint
  pnpm --dir apps/control-room test
  pnpm --dir apps/control-room check:api-hygiene
  pnpm --dir apps/control-room check:architecture-hygiene
  ```

  Przed `generate:api` zapisz checksumy trzech generated artifacts, uruchom
  generator, zapisz kontrolowany diff, a nastepnie uruchom generator drugi raz.
  Drugi run nie moze zmienic checksum. Nie uzywaj
  `git diff --exit-code` jako testu pierwszego runu w brudnym worktree, bo
  prawidlowy update kontraktu sam tworzy oczekiwany diff.

  Dodatkowo:

  ```bash
  git diff --check -- apps/control-room/src/kernel/api/generated
  git diff -- apps/control-room/src/kernel/api/generated
  rg -n "fetch\\(" apps/control-room/src/modules apps/control-room/src/kernel \
    -g '*.ts' -g '*.tsx'
  rg -n '"/v2/|`/v2/' apps/control-room/src/modules \
    -g '*.ts' -g '*.tsx'
  ```

  Pierwsza komenda musi pokazac, ze wygenerowany kontrakt byl juz aktualny
  albo kontrolowany diff jest czescia zmiany. Dwie ostatnie nie moga ujawnic
  nowego bezposredniego fetch ani recznie skladanej sciezki poza API facade.

- [ ] **K4: Viewport proof**

  Najpierw uruchom kanoniczna sesje z poprawnym latest-successful mesh oraz
  osobny frontend na wolnym porcie. Nie przejmuj ani nie zabijaj serwera,
  ktorego ten proces nie uruchomil. Przed wyborem recipe:

  ```bash
  just --list | rg "arch-waveguide|interactive|control-room"
  ```

  Uzyj odpowiadajacego aktualnemu repo managed recipe. Zapisz w raporcie
  dokladna komende, session ID, API URL, workspace URL i mesh generation ID.
  Nastepnie uruchom:

  ```bash
  CONTROL_ROOM_URL=http://localhost:3101/workspace \
    pnpm --dir apps/control-room smoke:viewport-3d
  CONTROL_ROOM_URL=http://localhost:3101/workspace \
    CONTROL_ROOM_SCREENSHOT_SCENES=fdm,fem,object \
    pnpm --dir apps/control-room screenshot:viewport-3d
  ```

  Report must explicitly answer:

  ```text
  Add Region did not switch main mesh to edge-only safety view; existing mesh remained visible and region overlay appeared: yes/no
  ```

  Gate musi pracowac na realnej sesji z opublikowanym successful mesh. Flagi
  `ALLOW_MISSING_SESSION=1` nie sa dopuszczalnym dowodem wydania.

- [ ] **K5: Write readiness report**

  Required report structure:

  ```markdown
  # Region-Owned Etap 1-4 Production Readiness Report

  ## Verdict

  | Etap | Verdict | Evidence | Remaining risk |
  |---|---|---|---|
  | 1 | ready/not ready | command outputs and file refs | exact unresolved contract risk or none |
  | 2 | ready/not ready | command outputs and screenshot refs | exact unresolved UI risk or none |
  | 3 | ready/not ready | mesh density metrics and viewport proof | exact unresolved mesh risk or none |
  | 4 | ready/not ready | physics/backend tests | lane-specific unresolved risk or none |

  ## Mesh Lifecycle Proof

  - Before screenshot:
  - After Add Region screenshot:
  - Smoke command:
  - Safety-view string absent: yes/no

  ## Backend Support Matrix

  | Backend/lane | Region mask | Mesh policy | Ms/Aex/Alpha fields | Runtime proof | Verdict |
  |---|---|---|---|---|---|

  ## Deferred Work

  - FDM CUDA kernel support for cellwise material fields; etap 4 wymaga pre-runtime gate, nie implementacji kerneli.
  - Arbitrary FEM conformal region CSG split; etap 4 obejmuje tylko wspierane box/cylinder OCC meshing.
  - Realized membership viewport overlay; authored shape overlay pozostaje zakresem etapow 1-4.
  - RKKY runtime execution; coupling pozostaje poza zakresem etapow 1-4.
  ```

- [ ] **K6: Final hygiene**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Every changed line must trace to this plan. Do not stage or revert unrelated dirty work.

- [ ] **K7: Werdykt musi byc lane-specific**

  Nie wolno napisac ogolnego `Etap 4 ready`, jezeli:

  - FDM CPU jest gotowy,
  - FDM CUDA jest capability-blocked,
  - FEM projection nie ma managed runtime proof,
  - FEM strict sharp runtime jest zablokowany mimo istniejacego conformal
    meshera.

  Poprawny format:

  ```text
  Etap 4 semantic contract: ready
  FDM CPU reference: ready
  FDM CUDA cellwise fields: blocked by declared capability, no silent fallback
  FEM conformal OCC meshing for supported box/cylinder regions: mesh-qualified
  FEM projected nodal fields: ready only after managed runtime proof
  FEM strict sharp region coefficients with shared m: blocked by capability fem.region.element_coefficients_shared_m
  ```

---

## 12. Non-Goals for Etapy 1-4

Do not silently pull these into scope:

1. Full FDM CUDA kernel support for `ms_field/a_field/alpha_field`. If not implemented, gate it clearly.
2. Arbitrary FEM conformal CSG split.
3. Realized membership viewport overlay from node/element membership API.
4. RKKY runtime execution.
5. Surface selector runtime resolution beyond diagnostics/capability gate.
6. Spatial fields for `Ku1/Ku2/Dind/Dbulk/Kc*` unless explicitly implemented and tested.
7. Nested regions inside regions.

---

## 13. Final Acceptance Checklist

Etapy 1-4 are production-ready only if every checked item is true:

- [ ] Region create/patch/read contracts are typed in Rust schemas, OpenAPI, generated TS and ControlRoomApi.
- [ ] Raw JSON boundaries are documented and tested as extension/import/merge-patch boundaries only.
- [ ] Python -> SceneDocument -> UI resource -> Python export preserves region IDs, mesh policy, material overrides and texture override.
- [ ] Every `object.region.*` semantic node resolves to a dedicated inspector contribution.
- [ ] Region physical scalar inputs accept `1e-9`, `1 nm`, `800 kA/m`, `13 pJ/m`.
- [ ] Region magnetic panel never fabricates parent material values from edit defaults.
- [ ] Region nested-regions panel states v1 unsupported semantics clearly.
- [ ] Region panels have no inline React style objects in changed files.
- [ ] Region authoring invalidates model resources but not mesh topology/current/latest-successful resources.
- [ ] Add Region does not show `Mesh topology is stale; rendering an edge-only safety view`.
- [ ] Existing mesh remains visible after Add/Patch/Delete Region until explicit Build Mesh.
- [ ] Region overlay appears after Add Region without forcing global wireframe mode.
- [ ] Region shapes are clamped/rejected to parent bounds in UI, API and import validation.
- [ ] Bounds enforcement sprawdza rzeczywista geometrie parenta, nie tylko jego AABB, dla kazdego owner shape deklarowanego jako wspierany.
- [ ] `frame=object` i `frame=world` maja identyczna, testowana semantyke transformacji w UI, API, meshingu i material sampling.
- [ ] Region mesh policy changes actual final mesh density in a skyrmion-core test.
- [ ] Disabled region mesh policy contributes no Gmsh size field and does not change mesh.
- [ ] Kazde pole region mesh policy ma jawna semantyke: `hmax/transition` sa wykonane, `hmin` jest odrzucone przez stabilny capability gate, a lokalny `order` jest dziedziczony albo odrzucony.
- [ ] Mesh report liczy unikalne region IDs i pokazuje requested/effective/status dla kazdej policy.
- [ ] `Ms/Aex/Alpha` material fields resolve priority conflicts deterministically.
- [ ] Material plan i realized asset sa laczone przez `plan_id` oraz typed `source_refs`, nigdy przez sama nazwe parametru.
- [ ] Sampled `Ms/Aex/alpha` przechodza post-sampling finite/range validation przed backendem.
- [ ] FDM CPU reference consumes spatial `Ms_i/A_i/alpha_i`.
- [ ] Exchange field and exchange energy use the same harmonic `A_ij` pair rule.
- [ ] Taylor consistency test passes for spatial `A(x)` and `Ms(x)`.
- [ ] Runner-level test pokazuje nietrywialna roznice pola/kroku wzgledem uniform baseline.
- [ ] Lokalny `alpha_i` ma osobny test zachowania integratora.
- [ ] Native FDM CUDA material fields are either implemented or blocked before C ABI.
- [ ] Multilayer FDM spatial material fields sa osobno capability-gated.
- [ ] FEM region material field support is not overclaimed beyond tested planner/runtime proof.
- [ ] Material field API resources distinguish `authored_pending`, `planned_sampled`, `realized_asset_available`, `blocked_by_capability`.
- [ ] Material field API nie przypisuje statystyk miedzy roznymi assignmentami tego samego parametru.
- [ ] Session API nie parsuje material arrays z `metadata.execution_plan` i nie uzywa `latest_fields` jako rejestru material assets.
- [ ] Pelne material arrays sa dostepne przez istniejacy data plane/artifact store, a control plane zwraca tylko typed manifest, statystyki i asset reference.
- [ ] Full frontend `typecheck`, `lint`, `test`, API hygiene i architecture hygiene przechodza.
- [ ] Browser smoke przechodzi na realnej sesji bez `ALLOW_MISSING_SESSION`.
- [ ] Final readiness report exists with command evidence and mesh-density/browser proof.

## 14. Recommended Execution Order

1. Phase A: baseline audit and guardrails.
2. Phase B: final typed authoring contract proof and round-trip.
3. Phase C: region inspector correctness, dedicated visualization contribution,
   shared scalar parser and CSS/token cleanup.
4. Phase D: mesh lifecycle and browser proof for Add Region regression.
5. Phase E: bounds enforcement across UI/API/import.
6. Phase F: actual mesh-policy density proof.
7. Phase G: material field plan/provenance/API diagnostics.
8. Phase H: FDM CPU physics oracle.
9. Phase I: native FDM CUDA and multilayer gates.
10. Phase J: FEM boundaries without overclaiming.
11. Phase K: final readiness report.

Do not claim production readiness after only fixing UI. Etap 3 needs actual mesh-density evidence. Etap 4 needs physics/backend evidence.

### 14.1 Zaleznosci blokujace

```text
Phase A
  -> Phase B
  -> Phase C
  -> Phase D
  -> Phase E
  -> Phase F

Phase B + Phase E
  -> Phase G
  -> Phase H
  -> Phase I
  -> Phase J

Phase C + Phase D + Phase F + Phase G + Phase H + Phase I + Phase J
  -> Phase K
```

Nie rozpoczynaj UI lifecycle dla material fields przed ustabilizowaniem
`plan_id/source_refs`, bo wymusiloby to drugi kontrakt migracyjny.
Nie zatwierdzaj bounds UI przed testem parity z Rust validation. Nie zatwierdzaj
mesh reportu przed zamknieciem semantyki `hmin/order`.

### 14.2 Granice reviewowalnych zmian

Zalecany podzial PR/commit:

| Zmiana | Zakres |
|---|---|
| 1 | Typed authoring/OpenAPI/round-trip bez UI polish |
| 2 | Dedicated region inspectors, shared scalar parser, CSS/token cleanup |
| 3 | Mesh lifecycle + viewport smoke/screenshot instrumentation |
| 4 | Shared bounds/containment fixtures i API/import parity |
| 5 | Region mesh-policy executable semantics i actual mesh proof |
| 6 | Material plan/asset identity, sampling validation, API provenance |
| 7 | FDM CPU pair helper, Taylor/runner/local-alpha physics proof |
| 8 | CUDA/multilayer capability vocabulary and gates |
| 9 | FEM constrained support gates and managed proof |
| 10 | Final generated contracts, full gates and readiness report |

Kazda granica musi byc reviewowalna niezaleznie. Generated OpenAPI diff nalezy
do zmiany kontraktu, nie do pozniejszego UI commitu.
