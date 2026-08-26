# Naprawa przygotowania symulacji i diagnostyki — plan implementacji

> **Dla agentów wykonawczych:** wymagane są `test-driven-development`, `systematic-debugging`, `capability-matrix-check`, `resource-first-api-check`, `react-doctor` i `verification-before-completion`.

**Cel:** Odrzucać znane nielegalne mixed-P1 przed Gmsh, skrócić legalny pipeline siatki oraz zapewnić ciągły, prawdziwy postęp i pełną bezpieczną diagnostykę w Control Room.

**Architektura:** Planner zachowuje obecny zakwalifikowany zakres mixed-P1 i współdzieli jedną listę predykatów między preflightem a walidacją materialized mesh. Python usuwa zbędne serializacje i publikuje indeterminate subphases. Istniejący HTTP-authoritative preparation resource przenosi szczegół błędu do kernelowego dialogu bez zmiany OpenAPI.

**Stos:** Rust, Python/NumPy/Gmsh, React/TypeScript, Vitest/Testing Library.

## Ograniczenia globalne

- Zachować zakwalifikowany zakres mixed-P1: exchange + demag + opcjonalna jednorodna anizotropia jednoosiowa Ku1/Ku2; nadal odrzucać anizotropię kubiczną, pola materiałowe i pozostałe niezakwalifikowane interakcje.
- Nie usuwać anizotropii ani nie zmieniać fizyki skryptu użytkownika.
- Nie dodawać endpointu ani pola OpenAPI.
- Nie wymyślać procentu ani ETA dla operacji bez mianownika.
- Zachować finalną walidację Rust i certyfikat mixed mesh.
- Nie commitować, nie stashować i nie czyścić współdzielonego drzewa.

---

### Zadanie 1: Fail-fast i dokładne predykaty mixed-P1

**Pliki:**
- Modyfikuj: `crates/fullmag-plan/src/mesh.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfejsy:**
- Produkuje: uporządkowane identyfikatory naruszeń authored scope i materialized scope.
- Zachowuje: istniejący publiczny błąd planera oraz końcową walidację certyfikatu.

- [ ] Dodać test, że authored `swept_prism + pyramid_to_tetrahedra` z brakującym exchange i anizotropią kubiczną jest odrzucany przed wymaganiem mesh asset.
- [ ] Uruchomić test i potwierdzić RED: obecny planner przechodzi do materializacji albo nie zawiera obu identyfikatorów.
- [ ] Wyodrębnić kolektor predykatów i wywołać preflight tylko dla jednoznacznego authored mixed intent.
- [ ] Zachować pełne sprawdzenie certyfikatu po materializacji.
- [ ] Uruchomić targeted testy `fullmag-plan` i potwierdzić GREEN.

### Zadanie 2: Naprawa kosztu i zagęszczenia meshingu

**Pliki:**
- Modyfikuj: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`
- Test: właściwy test ProblemIR/asset pipeline znaleziony przy implementacji.

**Interfejsy:**
- Produkuje: raport mixed mesh bez raportowego `to_ir()`; jedno kanoniczne mesh IR; boundary extension wyłączone.
- Zachowuje: Rust `validate_mesh_ir`, topology certificate i progi jakości.

- [ ] Dodać test spy, że raport mixed mesh nie wywołuje `to_ir()` dla nieobsługiwanych statystyk.
- [ ] Dodać test fake-Gmsh, że gałąź size fields ustawia `Mesh.MeshSizeExtendFromBoundary=0`.
- [ ] Uruchomić oba testy i potwierdzić RED.
- [ ] Zbudować statystyki bezpośrednio tylko dla wspieranej topologii i przekazać raz utworzony mesh IR do ProblemIR.
- [ ] Ustawić boundary extension na 0 po source-surface mesh.
- [ ] Uruchomić targeted Python testy oraz mały realny mixed mesh certificate test.

### Zadanie 3: Heartbeat i prawdziwe podfazy Python/Gmsh

**Pliki:**
- Modyfikuj: `packages/fullmag-py/src/fullmag/_progress.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

**Interfejsy:**
- Produkuje: context manager emitujący `mesh_build_phase` start/heartbeat/complete bez odczytu Gmsh z wątku.
- Payload: `phase`, `progress_kind=indeterminate`, `progress_percent=null`, `progress_label`, `message`.

- [ ] Dodać testy deterministycznego zegara/stop event i payloadu bez procentu.
- [ ] Potwierdzić RED.
- [ ] Dodać bounded helper heartbeatów z gwarantowanym zatrzymaniem w `finally`.
- [ ] Owinąć repair, optimize, extraction oraz postprocessing/serialization poprawnymi fazami.
- [ ] Uruchomić targeted Python testy i sprawdzić brak pozostających wątków.

### Zadanie 4: Szczegół błędu i korelacja w preparation resource

**Pliki:**
- Modyfikuj: `crates/fullmag-cli/src/orchestrator.rs`
- Modyfikuj: `crates/fullmag-cli/src/python_bridge.rs`
- Test: istniejące moduły testowe w obu plikach.

**Interfejsy:**
- Produkuje: `failure.detail` z bounded sanitizer oraz `diagnostics_correlation_id`.
- Zachowuje: stabilne `error_code`, summary, 200-elementowy log i HTTP-authoritative resource.

- [ ] Dodać testy RED dla zachowania planner detail/korelacji i mapowania meshing/postprocessing subphase.
- [ ] Przekazać bezpieczny detail do funkcji fail stage i wygenerować korelację.
- [ ] Mapować komunikat i label strukturalnego heartbeatu bez sztucznego procentu.
- [ ] Uruchomić targeted testy `fullmag-cli`.

### Zadanie 5: Model, raport i dialog błędu w Control Room

**Pliki:**
- Modyfikuj: `apps/control-room/src/kernel/layout/simulationPreparationModel.ts`
- Modyfikuj: `apps/control-room/src/kernel/layout/simulationPreparationDiagnostics.ts`
- Utwórz: `apps/control-room/src/kernel/layout/SimulationPreparationFailureDialog.tsx`
- Modyfikuj: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`
- Modyfikuj właściwy plik stylów `apps/control-room/src/design/styles/*`
- Test: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.test.tsx`

**Interfejsy:**
- Konsumuje: istniejący snapshot preparation i serializer.
- Produkuje: auto-open raz na `preparation_id + revision + error_code`, ręczne ponowne otwarcie, copy report, fallback detail.

- [ ] Dodać testy RED dla mapowania/serializacji detail, auto-open once, reopen, copy success/failure i zachowania startup gate.
- [ ] Rozszerzyć model oraz serializer bez nowego transportu.
- [ ] Zbudować dialog ze wspólnego `@/shared/ui/Dialog` i klasami `fm-*`.
- [ ] Podłączyć dialog oraz `View error details` do overlayu.
- [ ] Uruchomić targeted Vitest, typecheck i React Doctor.

### Zadanie 6: Weryfikacja zintegrowana

- [ ] Uruchomić pełny zestaw targeted testów Rust/Python/React.
- [ ] Sprawdzić brak zmiany wygenerowanego kontraktu OpenAPI.
- [ ] Uruchomić browser smoke dialogu, jeżeli lokalny Control Room jest dostępny.
- [ ] Sprawdzić `git diff --check`, pełny diff i brak ingerencji w pliki użytkownika.
- [ ] Raportować osobno: CONFIRMED source/tests, NOT VERIFIED duży runtime, BLOCKED tylko dla faktycznej niedostępności środowiska.

