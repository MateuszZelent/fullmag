# Results mode-sweep UI — PR1 implementation plan

> Plan wykonawczy dla pierwszego wdrażalnego wycinka audytu z 2026-09-01.
> Praca pozostaje na bieżącym `master`; plan nie autoryzuje stage, commit,
> merge ani push.

**Cel:** przekazać pełny typed `eigen/field_sweep.v1` od writer-a przez API do
Results Navigator i Field Sweep Inspector, zachowując stable IDs, source
revisions, jednostki, topologię, execution provenance oraz legalne opcjonalne
referencje pól.

**Zakres:** Faza 0 (ADR i fixture contract) oraz Faza 1/PR1 z audytu. Fazy
dataset index, wspólnej `analysis-result` selection, server paging/
virtualization, Analysis, FFT/DSF, multi-axis geometry i browser qualification
pozostają osobnymi zmianami.

## Założenia i kryteria sukcesu

- API nie gubi pól wymaganych przez UI do `extra`.
- Minimalny stary payload nadal się deserializuje, lecz bez brakujących danych
  nie jest awansowany do pełnej gotowości.
- Field Sweep jest jedynym źródłem listy sweep samples i mode records, gdy
  typed payload jest dostępny.
- Join spectrum/branches odbywa się po stable ID oraz source revision; przy
  konflikcie nie ma fallbacku do indeksu.
- 15-punktowy fixture daje 15 fizycznych etykiet, a każdy legalny mode ma
  `modal-mode` selection i pole tylko przy zweryfikowanej referencji.
- Zmienione moduły nie wykonują `fetch`, nie czytają unknown transport body i
  nie tworzą prywatnego store.

## Kroki TDD

### 1. Kontrakt backendu i fixture

**Pliki:**

- `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`;
- `crates/fullmag-api/src/router_v2/tests.rs`;
- `crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs` tylko dla
  warunku publikacji field refs;
- `docs/adr/0029-analysis-result-dataset-and-slice-selection.md`.

- [ ] Dodać failing test pełnego fixture API z axis/conversions, counts,
      topology, execution, cross refs i nested modes.
- [ ] Dodać failing test odrzucający niekompletne/duplikowane stable IDs oraz
      niespójne pary field ID/resource key.
- [ ] Uruchomić `cargo test -p fullmag-api frequency_domain -- --nocapture` i
      potwierdzić RED.
- [ ] Dodać typowane payload structs z opcjonalnością wyłącznie dla
      backward-compatible starych artefaktów.
- [ ] Powiązać publikację field refs z istniejącą walidacją Cartesian complex
      `real/imag`; brak payloadu pozostaje `spectrum-only`.
- [ ] Regenerować OpenAPI v2/types/client repozytoryjnym pipeline.

### 2. Typed frontend adapter

**Pliki:**

- `apps/control-room/src/modules/results-navigator/resultsNavigatorTypes.ts`;
- `apps/control-room/src/modules/results-navigator/resultsNavigatorModel.ts`;
- `apps/control-room/src/modules/results-navigator/ResultsNavigatorModule.tsx`;
- `apps/control-room/src/modules/results-navigator/resultsNavigatorModel.test.ts`.

- [ ] Dodać `navigatorFieldSweepFromResource` wyłącznie na generated types.
- [ ] Zachować axis, display conversions, vector coordinates, status,
      topology, execution, source/revisions, branch IDs i field refs.
- [ ] Użyć stable IDs w node IDs i selection; indeksy pozostają metadata.
- [ ] Budować Samples z field sweep, fizycznie formatować projekcję bias field,
      a spectrum/branches łączyć tylko przy zgodnej rewizji.
- [ ] Dodać test 15 samples, field refs, reorder stability i revision conflict.

### 3. Realny Field Sweep Inspector

**Pliki:**

- `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainFieldSweepInspectors.tsx`;
- `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainFieldSweepPanel.tsx`;
- focused test Inspectora lub modelu.

- [ ] Usunąć placeholder `unsupported until typed A2...`.
- [ ] Pokazać requested/completed, status, axis/unit/conversions, selected
      sample coordinates, branch tracking, topology i field availability.
- [ ] Zachować resource binding/revision/last-valid i jawny partial/stale.
- [ ] Nie aktywować pola bez legalnych typed refs.

### 4. Weryfikacja cross-layer

- [ ] Focused Rust API tests.
- [ ] Focused Vitest Results/Inspector tests.
- [ ] `pnpm --dir apps/control-room typecheck`.
- [ ] `pnpm --dir apps/control-room lint`.
- [ ] `pnpm --dir apps/control-room run check:architecture-hygiene`.
- [ ] `pnpm --dir apps/control-room run check:api-hygiene`.
- [ ] `npx react-doctor@latest --verbose --scope changed`.
- [ ] Review diff oraz potwierdzić brak zmian w istniejącym dirty worktree.
- [ ] Live 15-point FEM/browser/WebGL proof oznaczyć `NOT VERIFIED`, jeśli
      brak kwalifikowanego runtime/artifact receipt; nie wyprowadzać parity z
      testów source/API.

## Definition of done dla tego patcha

Patch jest ukończony tylko, gdy testy kontraktu/API, adaptera i drzewa są
zielone, generated types odpowiadają OpenAPI, Inspector nie jest placeholderem,
a wynik końcowy rozdziela dowód source/test od runtime/browser qualification.
Pełny refaktor z Fazy 2–10 nie jest częścią tego DoD.
