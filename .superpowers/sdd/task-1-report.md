# Task 1 — bramka publikacji fizyki monitorów planarnych

## Status

`DONE_WITH_CONCERNS`

Po review naprawiono cztery braki publikacyjne w osobnym fixupie: zapis
MathJax tabeli symboli, dokładne target/carrier/extent capability, terminalny
kontrakt empty-bin wraz z jawną rozbieżnością implementacji oraz kompletność
source-map/public API. Między pierwotnym commitem Task 1 `c3ecccaa0` a fixupem
pojawił się niezależny commit `e442b8971`; nie został zmieniony ani cofnięty.
Fixup trzech ścieżek dokumentacji Task 1 ma hash
`68780427fc4c867cf53d7431bca74bee2b1ced7a`.

Drugi review wykazał trzy dalsze luki: wspólny post-target resolver wszystkich
FDM dynamic extents, code spans w kolumnie SI tabeli parametrów oraz pominięte
publiczne direct dataclass constructors. Poprawiono je w kolejnym osobnym
fixupie bez zmiany runtime/API.

Trzeci review skorygował trzy precyzyjne błędy publikacyjne po commicie
`4b7bedca4`: nieistniejący root export `fm.StudyMonitorRegistry`, typy
deklarowane trzech pól `PlanarFrame` oraz zbyt słaby wiersz source index dla
wspólnego resolvera extent. Użyto rzeczywistej publicznej ścieżki
`fullmag.model.StudyMonitorRegistry.add_planar.*` z normalnym wywołaniem przez
`study.monitors`, typów `Vector3` i statusu `PM-N12 + PM-N13 RED`.

Kontrakt naukowy, source-map i dokładny fragment macierzy możliwości zostały
zaktualizowane. ADR 0020 pozostaje bez zmian: decyzja o jednym
`PlanarMonitor`, jednym samplerze i oddzieleniu prezentacji nie zmieniła się;
zmienił się wyłącznie udokumentowany stan implementacji i kwalifikacji.

## Zmienione pliki

- `docs/physics/0970-planar-monitor-sampling-and-projection.md`
- `docs/physics/0970-planar-monitor-sampling-and-projection.source-map.json`
- `docs/specs/capability-matrix-v0.md`
- `.superpowers/sdd/task-1-report.md`

Nie zmodyfikowano `docs/adr/0020-planar-field-map-and-monitor.md`.

## Zakres kontraktu

- Dodano komplet wymaganych etykiet MyST terminalnej strony naukowej.
- Formalnie rozdzielono support plane/slab/depth/surface, rekonstrukcję i
  integrację oraz prezentację.
- Zdefiniowano grubość pełnego slab, occupied measure, empty-bin policy,
  składowe `u/v/normal`, kolejność redukcji wektora i jednostki SI.
- Dodano kompletny przykład stage-first, mapowanie Python → `ProblemIR`,
  walidację, round-trip, requested intent, resolved execution i błędy
  unsupported combinations.
- Dodano cztery osobne pasy źródłowe FDM CPU/GPU i FEM CPU/GPU, każdy z
  legalnością, urządzeniem samplera i stanem kwalifikacji.
- Skorygowano wcześniejsze nadmierne twierdzenia capability:
  FDM surface jest unsupported, FEM surface obsługuje wyłącznie
  `object_boundary`, FDM `mesh_part`/`airbox` są unsupported, a browser nie
  jest zakwalifikowany.
- Utrwalono granicę: GPU-source konsumowany przez sampler CPU nie jest GPU
  samplingiem.
- Tabela symboli i jednostek używa MyST inline MathJax `$...$`; nie używa
  code spans do zapisu matematyki.
- FDM `object` jest jawnie warunkowy: bieżąca maska wybiera wszystkie aktywne
  komórki i jest błędna dla ogólnego multi-object grid.
- FEM dopuszcza wyłącznie kompletny full-mesh Tet4/P1 nodal carrier; target i
  runtime scope ograniczają elementy dopiero po załadowaniu całego pola.
- Wszystkie dynamiczne FEM extent tags używają globalnego `fem.nodes`, więc
  scoped extents są błędne i niezakwalifikowane; poprawnym obejściem jest
  explicit extent.
- Terminalny kontrakt wyklucza occupancy `empty` z extrema/range, lecz bieżące
  `include_air_as_zero` zapisuje `0.0`, a `meta_resource` filtruje jedynie
  wartości niefinitywne. Ten tor jest jawnie RED do czasu occupancy-aware gate.
- Wszystkie FDM dynamic extent tags współdzielą bounds z post-target mask;
  wypisano błędne kombinacje, dodano PM-N13 RED i wymóg explicit extent.
- Wszystkie komórki SI obu tabel używają MathJax `$...$`.
- Source-map i tabela obejmują 43/43 unikalne parametry: 26 parametrów
  bezpośrednich konstruktorów eksportowanych klas oraz 17 factory/add params,
  z dokładnymi defaultami i słabszą walidacją direct construction.

## Zweryfikowane symbole źródłowe

- Python:
  - `packages/fullmag-py/src/fullmag/model/planar_monitor.py`:
    `class PlanarMonitor` oraz publiczne target/frame/extent/operator registry;
  - `packages/fullmag-py/src/fullmag/runtime/script_builder.py`:
    `_render_planar_monitors`.
- ProblemIR:
  - `crates/fullmag-ir/src/planar_monitor.rs`:
    `PlanarMonitorIR`, `MonitorTargetIR`, `PlanarFrameIR`,
    `PlanarExtentIR` i `PlanarOperatorIR`;
  - `crates/fullmag-ir/src/validation.rs`:
    `validate_planar_monitors`.
- Sampler:
  - `crates/fullmag-api/src/planar_sampling/frame.rs`: `try_from_ir`;
  - `contract.rs`: `sample_fdm`, `sample_fem` i `apply_component`;
  - `fdm.rs`: `sample`;
  - `fem.rs`: `sample`;
  - `geometry.rs`: `integrate_clipped_tetra`;
  - `reduction.rs`: `finish`;
  - `surface.rs`: `sample_boundary`.
- API:
  - `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`:
    `resolve_dynamic_extent`, `resolve_component` i `meta_resource`;
  - schematy `PlanarMonitorSchema`, `PlanarFieldQuery` i
    `PlanarFieldMetaResource`.
- UI:
  - `buildFieldMapDataPlan`;
  - `usePlanarFieldMetaResource`;
  - `PlanarSurface`.

Wszystkie symbole wpisane do source-map zostały ponownie rozpoznane przez
validator path + stable symbol.

## Dowód Task 0

Zweryfikowano dokładne źródło
`5138078f7fd7b65dfc231faa4aa11c02d8ebf52d`. Managed
`just run-viewport-2d-planar-monitor-smoke fdm cpu` wygenerował science report
z wszystkimi zapisanymi bramkami `true`. Ten sam przebieg zakończył się
`exit 1` po 180000 ms oczekiwania na widoczny
`.fm-field-map__canvas`. Stary `browser-report.json` z `pass: true` nie jest
dowodem tego przebiegu.

Wniosek: akceptowany jest wąski managed FDM CPU science gate. Żaden pas nie ma
bieżącej kwalifikacji browserowej, pełnej runtime ani produkcyjnej.

## Walidacja

- `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-planar-monitor-sampling-and-projection.source-map.json --repo-root .`
  — `exit 0`.
- `python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'`
  — 22 testy, `OK`.
- `PYTHONPATH=packages/fullmag-py/src python3 -m unittest packages/fullmag-py/tests/test_planar_monitor.py packages/fullmag-py/tests/test_script_builder_roundtrip.py`
  — 39 testów, `OK`.
- `python3 scripts/check_public_doc_examples.py --root public_docs/site`
  — public documentation Python examples passed.
- `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/resources/planarFieldResources.test.ts src/modules/field-map/model/fieldMapDataPlan.test.ts src/modules/field-map/model/fieldMapRenderModel.test.ts src/modules/field-map/renderer/PlanarSurface.test.tsx`
  — 4 pliki, 20 testów, wszystkie przeszły.
- `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/planar-doc-task1 CARGO_INCREMENTAL=0 cargo test -p fullmag-ir planar_monitor -- --nocapture`
  — 5 testów planar monitor, wszystkie przeszły.
- `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/planar-doc-task1 CARGO_INCREMENTAL=0 cargo test -p fullmag-api --bin fullmag-api planar_sampling -- --nocapture`
  — 16 testów, wszystkie przeszły.
- `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/planar-doc-task1 CARGO_INCREMENTAL=0 cargo test -p fullmag-api --bin fullmag-api planar_ -- --nocapture`
  — 28 testów sampler/API/OpenAPI, wszystkie przeszły; istniejące ostrzeżenia
  `unused_mut`/`dead_code` pozostają poza zakresem.
- `python3 -m json.tool docs/physics/0970-planar-monitor-sampling-and-projection.source-map.json`
  — `exit 0`.
- `git diff --check` — `exit 0`.

Po review uruchomiono ponownie validator source-map, jego 22 testy,
changed-page gate, kontrolę JSON, lokalne asercje kompletności MathJax,
contract types i wszystkich 43 publicznych parametrów oraz `git diff --check`.

Po drugim review automatyczny signature-vs-manifest gate potwierdził 43/43
parametry (w tym 26 direct-constructor), 41/41 symbol-unit oraz 43/43
parameter-unit cells jako MathJax i 144 węzły matematyczne po parsowaniu MyST.

Po trzecim review runtime-export gate potwierdził, że root `fullmag` nie
eksportuje `StudyMonitorRegistry`, moduł `fullmag.model` go eksportuje, a
`PlanarFrame` deklaruje `Vector3` dla `origin`, `normal` i `u_axis`. Dokładny
export/signature-vs-manifest gate ponownie wymaga 43/43 parametrów.

- `validate_changed_scientific_docs.py --base c3ecccaa0 --head HEAD --repo-root .`
  — `exit 0` na fixupie `68780427f`.
- `validate_changed_scientific_docs.py --base 5138078f7fd7b65dfc231faa4aa11c02d8ebf52d --head HEAD --repo-root .`
  — `exit 0` dla całego zakresu Task 1, mimo niezależnego commitu
  `e442b8971` pomiędzy commitami Task 1.

## Nieudane polecenia diagnostyczne

- Pierwsze `cargo test -p fullmag-ir ...` użyło domyślnego `target/`, którego
  właścicielem jest `nobody:nogroup`, i zakończyło się permission denied.
  Poprawne powtórzenie użyło trwałego widoku
  `/tmp/fullmag-zfn2-build/cargo-targets/planar-doc-task1`.
- `cargo test -p fullmag-api planar_sampling --lib` zakończyło się
  `no library targets found`. Poprawna bramka użyła
  `--bin fullmag-api`.

## Self-review

- Każda zmieniona linia poza raportem dotyczy kontraktu naukowego, jego mapy
  źródeł albo dokładnego planar capability block.
- Nie zmieniono Python, IR, API, samplera, UI, OpenAPI ani generated types.
- Nie zmieniono ADR, ponieważ nie powstała nowa decyzja kontraktowa.
- Nie naruszono niezależnych zmian w `progress.md`, CSS, Explorer,
  FooterTelemetry, ribbon ani `external_solvers/3`.
- Source-map obejmuje cztery pasy, wszystkie równania, symbole użyte przez
  równania, publiczne parametry oraz stabilne path + symbol dla Python, IR,
  FDM, FEM, API i UI.

## Concerns i dalsze bramki

- Kod klipowania używa absolutnych progów około `1e-13 m` i `1e-24 m²`.
  Fixture nanometrowe przechodzą, ale niezależność od skali wymaga osobnego
  sweepu i progów zależnych od skali.
- `PlanarFieldMetaResource` nie publikuje source backend/device/precision,
  dlatego sam planar response nie kwalifikuje GPU-source.
- FDM object target w aktualnym membership sprawdza identity obiektu, ale
  wybiera wszystkie aktywne komórki; generalny multi-object target jest błędny,
  a nie tylko nieudowodniony. Rozdzielenie object IDs wymaga naprawy runtime i
  osobnej bramki.
- FDM `target_bounds`, `magnetic_domain` i `universe` nie mają niezależnych
  resolverów: wszystkie dziedziczą target mask. Explicit extent jest wymagany
  do czasu przejścia PM-N13.
- FEM carrier jest wyłącznie full-mesh Tet4/P1 nodal; scoped/local carrier nie
  jest wspierany. Dynamic FEM extents używają wszystkich węzłów niezależnie od
  target/scope, więc wymagają naprawy przed kwalifikacją.
- `include_air_as_zero` włącza puste zera do metadata min/max. Terminalny
  kontrakt wymaga wykluczenia ich przez occupancy mask; ten gate jest RED.
- Aktualny browser smoke pozostaje RED na visible canvas. Nie wolno promować
  żadnej ścieżki do browser/runtime/production-qualified przed świeżym,
  niezależnym dowodem każdego pasa.
