# Task 1 — bramka publikacji fizyki monitorów planarnych

## Status

`DONE_WITH_CONCERNS`

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

Pełna bramka
`validate_changed_scientific_docs.py --base 5138078f7fd7b65dfc231faa4aa11c02d8ebf52d --head HEAD --repo-root .`
jest uruchamiana po utworzeniu commitu, ponieważ walidator czyta wyłącznie
obiekty Git, a nie niezacommitowany working tree.

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
  wybiera wszystkie aktywne komórki; rozdzielenie wielu object IDs wymaga
  dalszego kontraktu/artifactu.
- Aktualny browser smoke pozostaje RED na visible canvas. Nie wolno promować
  żadnej ścieżki do browser/runtime/production-qualified przed świeżym,
  niezależnym dowodem każdego pasa.
