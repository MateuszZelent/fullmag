# Domeny anteny i ferromagnetyka — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Udostępnić wspólną, niezmienną siatkę próbki dla pola anteny i LLG, niezależne otoczenie demag oraz opcjonalne domeny obserwacji anteny w publicznym przepływie Python → ProblemIR → runtime → archiwum → UI.

**Architecture:** Jedno Universe opisuje scenę; jawne domeny wskazują istniejące obiekty i moduły fizyczne. Przewodnik ma własną siatkę V/J, próbka jeden współdzielony mesh docelowy, a demag i obserwacja osobne otoczenia. Pole na całej aktywnej próbce jest obowiązkowe dla konsumenta LLG; mapa w powietrzu jest opcjonalna.

**Tech Stack:** Python DSL i Gmsh, Rust ProblemIR/planner/runtime/API v2, istniejący FEM CPU/MFEM i zachowawczy RT0, Next.js 16/React/TypeScript, kontenerowe receptury `just` w WSL.

**Spec:** `.superpowers/brainstorm/2026-11-02-antenna-magnetic-domains/design.md`, zatwierdzony przez użytkownika 02.11.2026; commit projektu `476dff6b993d436b2f3daeaf18b10bf495a8b13f`.

## Global Constraints

- Wspólnym rdzeniem ma być siatka ferromagnetyka, a nie oba Airboxy.
- Jedno Universe pozostaje układem współrzędnych i sceną fizyczną.
- Powietrze nie otrzymuje sztucznej magnetyzacji.
- Missing H na aktywnym celu LLG jest błędem pokrycia, nie zerowym polem.
- Wyłączenie mapy w powietrzu nie usuwa wymuszenia działającego na próbkę.
- Wynik inspection-only pozostaje niekwalifikowany do LLG i kwalifikowanego FFT.
- Nie wymagamy zawierania jednego Airboxa w drugim.
- Bez nowych równań RF, sprzężenia zwrotnego, promienia odcięcia pola, ukrytego CPU fallback ani zmiany tolerancji po obejrzeniu wyniku.
- Pierwszy nowy przepływ: FEM CPU, double, Tet4. FDM CPU, FDM GPU i FEM GPU mają osobne jawne statusy odmowy dla nowego kontraktu, bez ograniczania ich istniejących przepływów.
- Nowe API i formaty poniżej są **propozycją do przeglądu planu**, nie istniejącym kodem. Nie wdrażać przed przeglądem.
- Kompilacja i uruchomienie natywne wyłącznie przez bieżący skill `fullmag-docker-build` i `justfile`; bez lokalnej kompilacji testów Rust/native. Wymagane testy kompilowane w zatwierdzonym CI; niedostępne logowanie GitHub oznacza otwartą bramkę, nie PASS.
- Zachować sesję użytkownika, wyniki, pozostałe wpisy indeksu Git i zasoby innych grup. Nie restartować obliczeń tylko dla kontroli prezentacji.

## Review Focus

1. Dwa Airboxy z tą samą nazwą nie mogą współdzielić wyboru, quantities ani cache: T8 `same_label_distinct_domain_identity`.
2. Ta sama geometria z inną kolejnością węzłów nie jest tą samą reprezentacją H/LLG: T3/T5 `permuted_core_requires_explicit_map`.
3. Mały ROI nie może ukryć brakujących próbek wymuszenia: T5/T9 `roi_does_not_clip_magnetic_forcing`.
4. Zmiana otoczenia nie może przetriangulować rdzenia lub ponowić transportu: T3/T6 `airbox_change_preserves_core_and_current`.
5. Archiwum ze starym/obcym źródłem, mapą lub częściowym H ma zostać odrzucone także po restarcie: T7 `cold_load_rejects_foreign_or_incomplete_binding`.

---

## Zakres i kolejność

To zależny plan integracyjny, a nie drugi model anteny. Trzy odbieralne części to: T1–T4 domeny i mesh; T5–T7 wynik pola i odtwarzanie; T8–T10 UI i odbiór. Nie wydzielamy niezależnych implementacji tych samych identyfikatorów.

Plan uzupełnia E4–E8 i E12 w `docs/superpowers/plans/2026-10-11-antenna-transport-e2e-implementation.md`. Nie zamyka E1/BORIS, E9 odpowiedzi fal spinowych ani całego E0–E12. Odtworzenie publikacji Sushruth wymaga późniejszej kwalifikacji źródła i rzeczywistego Run; nie wystarczy mapa H.

Baza audytu: `cc830b9b17c5115d2456ab878d0962715dfb6721`, master zintegrowany: `d037fd6b499cd074bf507b775e83f65a1d72c9ed`; istnieją lokalne zmiany anten, których nie należy nadpisywać. Wykonawca zapisuje nowy pełny SHA przed rozpoczęciem, bez arbitralnego aktualizowania wersji kontraktu.

## Mapa plików i własności

W tabeli `nowy` oznacza plik proponowany; pozostałe ścieżki sprawdzono w worktree.

| Zadanie | Pliki / symbole właścicieli | Odpowiedzialność |
|---|---|---|
| T1 | nowy `crates/fullmag-ir/src/study_domains.rs`; `lib.rs::ProblemIR` i `study_v04.rs`; nowy `packages/fullmag-py/src/fullmag/model/study_domains.py`; `world.py::StudyUniverseHandle`; `__init__.py` | Jeden kanoniczny kontrakt i DSL. |
| T2 | ten sam moduł IR; `lib.rs::migrate_problem_ir_json_value`; `crates/fullmag-api/src/script.rs`; `router_v2/handlers/persistence/script_project.rs`; `packages/fullmag-py/src/fullmag/runtime/run_config_export.py` | Jawna migracja i round-trip publicznego skryptu. |
| T3 | `meshing/asset_pipeline.py::_extract_frozen_magnetic_submesh`, `_merge_frozen_magnetic_submesh_with_air_mesh`; nowy `meshing/_shared_core_identity.py`; `crates/fullmag-ir/src/mesh_assets.rs::FemSharedDomainBuildReportIR` | Jeden zasób rdzenia i sprawdzalne mapy indeksów. |
| T4 | `meshing/_gmsh_airbox.py`, `_airbox_grading.py`, `_airbox_feature_fields.py`; `crates/fullmag-ir/src/mesh_policy.rs::FemMeshPolicyIR`; `crates/fullmag-plan/src/mesh.rs` | Osobne otoczenia, istniejące reguły zagęszczania. |
| T5 | `crates/fullmag-plan/src/antenna_field_solve.rs::resolve_field_sampling`; nowy `src/study_domains.rs` w tym crate; `crates/fullmag-api/src/live_scene_preparation/antenna_domain.rs` | Przypięcie H do rzeczywistej siatki magnetycznej, pełne pokrycie. |
| T6 | `crates/fullmag-runner/src/antenna_field_solution.rs`; nowy `antenna_field_solution/domain_binding.rs`; `crates/fullmag-plan/src/antenna_projection.rs`; `crates/fullmag-runtime-control/src/study_inspection_integrity.rs` | Accepted J → H celu/ROI, unieważnianie i gotowość konsumenta. |
| T7 | `crates/fullmag-session/src/archive_document.rs`, `archive_source.rs`, `accepted_provenance.rs`; `crates/fullmag-api/src/quantity_data_plane.rs` | Archiwum, source affinity i publiczny odczyt quantity. |
| T8 | `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `apiPaths.ts`; nowy `kernel/resources/studyDomainResources.ts`; `modules/explorer/builders/airboxExplorerNodes.ts`; `modules/inspector/inspectorRouteCatalog.tsx` i istniejące panele `panels/airbox/`; `kernel/visualization/visualizationTargetIdentity.ts` | Typowany dostęp, domenowe ID, odrębne Inspectory. |
| T9 | `apps/control-room/src/modules/footer/AuthoredAntennaTelemetry.tsx`, `FooterTelemetry.tsx`; nowe `DomainExecutionTelemetry.tsx` i test; istniejący viewport i `scripts/docker_dev_browser_qa.py` | Prawdziwy postęp i odbiór dwóch domen w 3D. |
| T10 | nowy `examples/fem_antenna_shared_magnetic_domains.py`; nowy `scripts/verify_antenna_magnetic_domains.py`; `justfile`; kanoniczne noty 0100/0102/0107/0950 oraz istniejący plan E0–E12 | Publiczny scenariusz, dowody i ograniczenia. |

## Kontrakty przekazywane między zadaniami

Nazwy w tym rozdziale są zarezerwowaną propozycją planu; implementacja nie może zmienić ich tylko w jednym języku.

- `StudyDomainRoleIR`: `conductor_source | magnetic_core | demag | antenna_observation`. Rola opisuje domenę; moduły fizyki pozostają jawne na obiektach i etapach.
- `StudyDomainIR`: `domain_id: String`, `name: String`, `role: StudyDomainRoleIR`, `members: Vec<FieldTargetIR>`, `core_domain_id: Option<String>`, `bounds: Option<StudyDomainBoundsIR>`, `mesh_policy: Option<FemMeshPolicyIR>`. `StudyDomainBoundsIR` ma `center_m: [f64;3]`, `size_m: [f64;3]` we wspólnym układzie sceny; finite, rozmiary > 0. Dla pierwszej realizacji tylko pudełko; inne kształty jawnie unsupported.
- `StudyDomainStageBindingIR`: `stage_id: String`, `conductor_domain_id: Option<String>`, `magnetic_domain_id: Option<String>`, `demag_domain_id: Option<String>`, `observation_domain_ids: Vec<String>`. To przypisanie istniejących etapów, nie nowy rodzaj dynamiki.
- `StudyDomainCatalogIR`: `schema_version: "study_domains.v1"`, `domains: Vec<StudyDomainIR>`, `stage_bindings: Vec<StudyDomainStageBindingIR>`. W ProblemIR pole `study_domains: Option<StudyDomainCatalogIR>`; brak zachowuje stary przepływ.
- Izolacja wersji: opt-in wire `ir_version="0.3.0+study-domains.1"` **tylko** dla dokumentów z katalogiem. Zwykłe dokumenty zachowują `0.3.0`. Nowy parser dodaje dokładny wariant do dozwolonego odczytu i walidacji metadata; stary parser odmawia nieznanej wersji zamiast ignorować domeny. Nie promować stagingowego `ProblemIRV04` ani nie zmieniać jego znaczenia. Wymagany test odrzucenia przez przypięty parser sprzed rozszerzenia. Ten wariant wymaga akceptacji w przeglądzie planu przed zmianą formatów.
- `SharedMagneticCoreBindingIR`: `domain_id`, `mesh_asset_id`, `mesh_revision`, `geometry_digest`, `topology_digest`, `dof_layout_digest`, `transform_digest` — niepuste String; digests pełne SHA256. Jednostki współrzędnych m, położenie `node`, reprezentacja Tet4/P1 wektor XYZ; bez domyślnego przejścia na centra.
- `SharedCoreIndexMapIR`: `core_to_domain_nodes: Vec<u64>`, `core_to_domain_cells: Vec<u64>`, `core_binding: SharedMagneticCoreBindingIR`. Musi być iniektywna i odtwarzać oryginalne połączenia, orientację i współrzędne; mapa odwrotna jest wyprowadzana, nie dopasowywana najbliższym punktem.
- `ResolvedStudyDomainIR`: `domain_id: String`, `mesh_asset_id: String`, `core_binding: Option<SharedMagneticCoreBindingIR>`, `core_map: Option<SharedCoreIndexMapIR>`. Żądanie i realizacja są osobne; resolved nie nadpisuje recepty użytkownika.
- `AntennaDomainFieldBindingIR`: `source_solution_digest: String`, `domain_id: String`, `core_binding: Option<SharedMagneticCoreBindingIR>`, `carrier_digest: String`, `quantity_id: String`, `unit: String`, `normalization_current_a: Option<f64>`. Używa istniejących artifact/source pins; nie zastępuje nimi weryfikacji zaakceptowanej próby.
- Quantity IDs i jednostki pochodzą z istniejącego katalogu: raw H w A/m, baza w 1/m; Iref finite, niezerowy, ze znakiem zaakceptowanego wyniku. Nazwa domeny nie generuje field ID.

## Wspólna procedura weryfikacji

Polecenia poniżej są wzorcami wykonywanymi z katalogu worktree w WSL. `SRC` oznacza jego ustaloną ścieżkę, nie nowy checkout. Przed każdym buildem przeczytać bieżący `justfile` i skill; wymienione receptury sprawdzono w bazie planu.

- Python: w już istniejącym backendzie, z `PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src`, `python3 -B -m pytest -p no:cacheprovider <plik>`. Artefakty testów skierować do prywatnego control volume. To nie kompiluje testów Rust/native.
- Frontend: w istniejącym kontenerze, katalog `/state/development/workspace/apps/control-room`, `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source pnpm exec vitest run <plik> --maxWorkers=1`. Lint/types/full suite kolejno, bez równoległego zużywania RAM.
- Build: dobrać recepturę do istniejącej sesji przed uruchomieniem. `just docker-dev-build "$SRC"` jest aliasem uruchamiającym usługi, nie poleceniem build-only; nie używać go w ciemno wobec zapisanej sceny na 3203. Dla tej sceny użyć `just docker-dev-restart-saved-authoring "$ATTEMPT" "$CONFIG_SHA256" "$SRC" "$CHECKPOINT" "$CHECKPOINT_SHA256" 3203`, gdzie wszystkie piny pochodzą z bieżących receiptów i zweryfikowanego checkpointu, nie z przykładowych wartości. Wymagane puste okno, natywny drain i zachowane archiwum; odmowa nie upoważnia do usunięcia sesji. Zamrozić źródła na czas buildu i zachować snapshot, obraz, receipt oraz exit code. Nowa grupa bez zapisanej sesji może użyć zwykłego docker-dev-build. Nie używać zamrożonej alternatywnej ścieżki runtime jako obejścia codziennego docker-dev.
- Publiczny skrypt: `just fullmag-dev-container examples/fem_antenna_shared_magnetic_domains.py "$SRC" 3203`. Uruchomienie dozwolone dopiero po przejściu bramek; nie liczyć kolejnego wariantu tylko dlatego, że obserwacja poprzedniego się urwała.
- Kod generowany API: `just docker-dev-codegen "$SRC"`; nie dopisywać ręcznie nieistniejącego endpointu.
- Browser: istniejący `just docker-dev-browser-qa "$SRC" 3203` po dodaniu scenariusza T9. Wcześniejsza blokada dostępu przeglądarkowego pozostaje blokadą; żadnej zmiany narzędzia/originu w celu obejścia. Jeśli dotyczy również tej kontroli, raportować brak dowodu i uzyskać odblokowanie.
- Każdy commit: osobne `git diff --cached --name-only`, następnie selektywny commit własnych ścieżek; zachować zastany indeks. Proponowane tematy commitów podano przy zadaniach.

Pierwszy profil obserwacji wykonuje mapę raz na jawny stage. Przekrój UI korzysta z tej mapy; nie oznacza wdrożenia dowolnego nośnika Region/point cloud ani periodycznej obserwacji przy każdym kroku LLG. Takie warianty pozostają jawnie poza pierwszym profilem. Nie ogranicza to obowiązkowego H na całej próbce.

Typy `SharedMagneticCoreBindingIR`, `SharedCoreIndexMapIR` i `ResolvedStudyDomainIR` należą do `mesh_assets.rs`; katalog i stage bindings do nowego `study_domains.rs`; `AntennaDomainFieldBindingIR` do istniejącego `antenna.rs`. Publiczne DTO `StudyDomain`, `StudyDomainStageBinding`, `StudyDomainBounds` należą do nowego Python `model/study_domains.py`, eksportowanego przez istniejące `model/__init__.py` i `fullmag/__init__.py`. Bez osobnego równoległego systemu BC: binding demag wskazuje istniejącą konfigurację danego etapu. Nowy profil odmawia niespójnej roli/method zamiast kopiować BC z observation.

## T1. Kanoniczny katalog domen i publiczny DSL

**Files:** właściciele T1 z mapy; nowe testy `packages/fullmag-py/tests/test_study_domains.py` i `scripts/test_study_domains_wire.py`; testy IR w nowym module.

**Interfaces:** consumes `FieldTargetIR`, `FemMeshPolicyIR`; produces typy katalogu i `StudyUniverseHandle.domains.add(domain: StudyDomain) -> StudyDomain`, `StudyUniverseHandle.domains.bind_stage(binding: StudyDomainStageBinding) -> None`; publiczne immutable DTO mają te same pola snake_case co IR, `to_ir() -> dict[str, object]`. Rejestr nie aktywuje fizyki.

**Test command:** `python3 -B -m pytest -p no:cacheprovider packages/fullmag-py/tests/test_study_domains.py scripts/test_study_domains_wire.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Napisać `test_catalog_roundtrip_and_role_validation`: dwie domeny o nazwie `Airbox` zachowują różne ID; duplicate ID, dangling core, cykl, niezgodna rola bindingu, NaN bounds i nieznana wersja są błędami. Powietrze nie tworzy m/Ms/σ. Test `legacy_reader_rejects_domains_wire` używa dokładnego starego parsera w CI.
- [ ] Uruchomić nowy test Python/wire przed zmianą; oczekiwany RED: brak modułu/obsługi wersji. Rust testy dopisać, uruchomić wyłącznie w zatwierdzonym CI.
- [ ] Wdrożyć powyższe DTO/lowering i parser wersji opt-in, z `deny_unknown_fields`, bez zmiany bezdomenowych dokumentów. Domyślnie brak katalogu; dla demag/observation bounds wymagane, dla core/source zabronione; core_id tylko na demag/observation. Members muszą rozwiązywać istniejące stabilne selektory; nie tworzą regionów materiałowych.
- [ ] Uruchomić testy Python/wire; GREEN wymaga semantycznego round-trip i zachowania istniejącego `FieldTarget.object(...).to_ir()`. Zaktualizować notę 0100 i jej source-map według scientific-documentation-contract, bez claimu runtime.
- [ ] Commit `feat(ir): define explicit study domain catalog` po oddzielnej kontroli indeksu.

Testy natywnego parsera w CI: `cargo test -p fullmag-ir study_domains::tests`; snapshot starego parsera pochodzi z pełnego SHA bazy powyżej, a nie z parsera zmodyfikowanego w T1. Ten rozkaz jest wyłącznie dla zatwierdzonego CI, nigdy lokalnym obejściem zakazu.

## T2. Jawna migracja pojedynczego Airboxa i round-trip

**Files:** właściciele T2; nowe `scripts/test_study_domain_migration.py`, `packages/fullmag-py/tests/test_study_domain_export.py`.

**Interfaces:** consumes katalog T1; produces `migrate_legacy_study_domains(value: &serde_json::Value, assignment: &StudyDomainCatalogIR) -> Result<serde_json::Value, String>` w `study_domains.rs`. Zwraca kopię; nie nadpisuje pliku źródłowego. Assignment zawiera kompletny jawny wybór ról, nie heurystykę nazwy.

**Test command:** `python3 -B -m pytest -p no:cacheprovider scripts/test_study_domain_migration.py packages/fullmag-py/tests/test_study_domain_export.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać `test_legacy_airbox_requires_explicit_assignment`: brak assignment odmawia konwersji; jeden stary Airbox nie staje się dwiema domenami; dwa jawne przypisania dają dwa ID; zachowane obiekty, materiały, stage IDs i stary artifact. `test_export_import_preserves_domain_bindings` porównuje kanoniczne IR, nie formatowanie skryptu.
- [ ] Uruchomić testy przed implementacją; oczekiwany RED na migracji/eksporcie katalogu.
- [ ] Podłączyć migrację do istniejącego importu projektu i eksportu publicznego Python. Stare projekty nadal otwierają się starym przepływem; upgrade jest jawną operacją z podglądem. Niejednoznaczność zatrzymuje upgrade, nie otwarcie zachowanych wyników. Bez downgrade nowego wire do starego IR przez odrzucenie pola.
- [ ] Sprawdzić import → eksport → ponowny import oraz odmowę nowego wire w starym pakiecie; do czasu wykonania CI nie raportować zgodności starego binarium.
- [ ] Commit `feat(authoring): migrate explicit domain assignments`.

## T3. Niezmienny rdzeń i jawne mapy podsiatek

**Files:** właściciele T3; nowy `packages/fullmag-py/tests/test_shared_core_identity.py`.

**Interfaces:** consumes `SharedMagneticCoreBindingIR`; produces w nowym helperze `validate_shared_core_map(core: MeshData, extended: MeshData, node_map: Sequence[int], cell_map: Sequence[int]) -> None`, zgłaszający ValueError. `MeshData` pochodzi z istniejącego `_gmsh_types.py`. Mapy powstają podczas rozszerzania, a nie z wyszukiwania najbliższych punktów.

**Test command:** `python3 -B -m pytest -p no:cacheprovider packages/fullmag-py/tests/test_shared_core_identity.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Napisać `test_permuted_core_requires_explicit_map`, `test_airbox_change_preserves_core_and_current` oraz przypadki dwóch bliskich, różnych węzłów, nieiniektywnej mapy, obróconej komórki i nieaktualnej transformacji. Porównanie rdzenia obejmuje bajty współrzędnych/connectivity i jawne permutacje, nie sam bounding box.
- [ ] Uruchomić test: RED dla brakującego kontraktu/raportu map.
- [ ] Wyodrębnić zamrożony mesh próbki raz; rozszerzać go istniejącą ścieżką meshing. Obecne kwantowanie współrzędnych 1e-12 m w merge nie jest dowodem tożsamości: nowa ścieżka wymaga dokładnych map i odmawia kolizji. Zapisać core_binding/map w build report; nie zmieniać pozostałych generatorów bez potrzeby.
- [ ] GREEN wymaga dwóch różnych otoczeń z identycznym rdzeniem, dodatniej orientacji, zgodnych interfejsów i zachowania markerów. Test wykonuje realne Gmsh w kontenerze; fixture samego helpera nie zalicza budowy.
- [ ] Commit `feat(mesh): preserve immutable magnetic core bindings`.

## T4. Osobne otoczenia i lokalne zagęszczanie

**Files:** właściciele T4; rozszerzyć `packages/fullmag-py/tests/test_airbox_feature_refinement.py` i `test_shared_domain_body_hmax.py`.

**Interfaces:** consumes katalog i mapy T3; produces `ResolvedStudyDomainIR` dla każdego requested domain oraz osobne fingerprinty polityk w istniejącym raporcie. Domena demag i obserwacyjna mają niezależne bounds/policy, ten sam core ID tylko jeśli rozszerzają rdzeń.

**Test command:** `python3 -B -m pytest -p no:cacheprovider packages/fullmag-py/tests/test_airbox_feature_refinement.py packages/fullmag-py/tests/test_shared_domain_body_hmax.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać `test_demag_and_observation_bounds_are_independent`, `test_coarse_air_does_not_coarsen_core`, `test_unrelated_domain_policy_does_not_change_core_digest`; mieszane/pryzmatyczne unsupported refinement nadal odmawia.
- [ ] Uruchomić testy: RED na jedynym globalnym Airboxie.
- [ ] Zastosować istniejącą kompozycję pól rozmiaru Gmsh dla zakresu wybranej domeny. Zachować max/min finite >0, min<=max oraz 1<growth<=2.5. Nie dodawać fikcyjnej przewodności/Ms powietrza ani globalnego założenia zawierania obu pudełek.
- [ ] GREEN: mesh realizuje requested/realized politykę; zmiana observation hmax/bounds nie zmienia core ani operatora demag. Przekroczenie budżetu odmawia z kosztem, bez automatycznego zmniejszania jakości próbki. Uzupełnić noty 0102/0107 i walidację source-map.
- [ ] Commit `feat(mesh): scope air refinement to study domains`.

## T5. Planner: H na całej siatce magnetycznej

**Files:** właściciele T5; nowe `scripts/test_antenna_domain_sampling_contract.py`; testy w module planera.

**Interfaces:** consumes katalog, `ResolvedStudyDomainIR` i existing `AntennaFieldSamplingPlanIR`; produces `resolve_study_domain_sampling(problem: &ProblemIR, stage_id: &str) -> Result<AntennaFieldSamplingPlanIR, String>` w nowym module planera. Używa dokładnego core asset; istniejący selector legacy zachowuje dotychczasowe znaczenie.

**Test command:** `python3 -B -m pytest -p no:cacheprovider scripts/test_antenna_domain_sampling_contract.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać `roi_does_not_clip_magnetic_forcing`: próbka wychodząca poza małe okno obserwacji nadal ma H w każdym aktywnym węźle; usunięty węzeł/inna kolejność bez mapy/inny DOF blokuje wykonanie. Dodać odmowy nowego workflow dla FDM CPU/GPU, FEM GPU i non-Tet4, bez zmiany starych lane.
- [ ] Uruchomić kontrakt przed zmianą: RED na braku domenowego sampling; natywne testy planera tylko CI.
- [ ] Rozdzielić cele obowiązkowe magnetic_core i opcjonalne observation. Sprawdzić module-authored magnetyczność, geometrię, transformacje, wszystkie aktywne obszary oraz pokrycie nośnika; nazwa/presentation type nie wystarczają. Region nadal odmawia, dopóki nie ma realnego nośnika, zamiast przyjmować pustą listę.
- [ ] GREEN wymaga publicznego prepare z tym samym mesh/core signature co LLG. Udokumentować P1→punkty kwadratury istniejącego operatora: jawna mapa i test stałego/liniowego pola, bez ponownego siatkowania próbki.
- [ ] Commit `feat(plan): bind antenna targets to magnetic core mesh`.

Testy Rust planera w zatwierdzonym CI: `cargo test -p fullmag-plan study_domains::tests`; brak wykonanego CI pozostawia bramkę NOT_RUN.

## T6. Accepted J, niezależne mapy H i gotowość LLG

**Files:** właściciele T6; nowe `scripts/test_antenna_domain_field_binding.py` i testy modułu runnera.

**Interfaces:** consumes `AntennaDomainFieldBindingIR`, source verified przez `study_inspection_integrity::load_saved_inspection`; produces `validate_antenna_domain_binding(field: &AntennaDomainFieldBindingIR, target: &SharedMagneticCoreBindingIR) -> Result<(), String>` w nowym `domain_binding.rs`. Nowe obliczenie H używa zatwierdzanego osobno dodatku retained-current H-only; nie tworzyć drugiego integratora.

**Test command:** `python3 -B -m pytest -p no:cacheprovider scripts/test_antenna_domain_field_binding.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać testy foreign accepted-state, raw-H-as-basis, Iref=0, zmiany samego I(t), zmiany targetu i zmiany σ. Liczniki transport/H muszą pokazywać: waveform nie przelicza obu; nowy ROI przelicza tylko jego H; zmiana przewodnika unieważnia J i zależne H.
- [ ] RED: nowy binding nie istnieje albo obecny globalny cache nie rozróżnia domen. Dla testów natywnych najpierw CI; nie kompilować ich lokalnie.
- [ ] Zintegrować przygotowany H-only dopiero po kontroli zgodności jego manifestów z bieżącym HEAD, wspólnym canonical source loaderem i pełnym przepływem publicznym. Native wrapper zwraca `SurfaceRt0Snapshot` bez niepotrzebnego prywatnego typu; zachować profile/observer, budżety i zakazy niekwalifikowanego źródła.
- [ ] Publikować H próbki i opcjonalne H ROI jako oddzielnie przypięte wyniki tego samego accepted J. Osobne zależności cache: source J; core H; ROI H; operator demag. Nie zamieniać direct-volume na surface operator bez jawnego provenance i dowodu zgodności.
- [ ] GREEN: publiczny H-only z zachowanego zaakceptowanego J, zero nowego transportu i zero LLG dla inspection-only. Kwalifikowane fixture źródła sprawdza zero/sign/2×/superpozycję, waveform w podkrokach wszystkich wspieranych integratorów i DC Relax; raw GSG nadal ma blokadę. Nie odblokowywać realnego GSG LLG tym commitem.
- [ ] Commit `feat(antenna): bind retained fields to explicit domains`.

Testy Rust bindingu w zatwierdzonym CI: `cargo test -p fullmag-runner antenna_field_solution::domain_binding::tests`; wymagany profil native ustala istniejący workflow kontenerowy, nie host. Zwykły source-contract Python nie zastępuje tych testów.

## T7. Archiwum, quantities i odczyt po restarcie

**Files:** właściciele T7; nowy `scripts/test_antenna_domain_archive.py`; rozszerzyć istniejące testy archiwum w CI.

**Interfaces:** consumes katalog, resolved domains, mapy i `AntennaDomainFieldBindingIR`; produces odtwarzalny manifest z tymi samymi pinami oraz canonical quantity availability po cold-load. Bez drugiego magazynu wyników.

**Test command:** `python3 -B -m pytest -p no:cacheprovider scripts/test_antenna_domain_archive.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać `cold_load_rejects_foreign_or_incomplete_binding`: obce mesh revision, brak mapy, uszkodzony carrier payload, niezgodna normalizacja, foreign session/epoch i brak jednej części H są błędami. Stary wynik bez nowego katalogu nadal czytelny jako legacy.
- [ ] Uruchomić testy: RED na zgubieniu bindingu w archiwum.
- [ ] Rozszerzyć istniejące closure walkers, source proof i canonical field-store; nie wkładać obcego run do single-run accepted_provenance. Przechowywać mesh/map/payload/digests, requested/resolved backend i kwalifikację. Import nie przywraca autoryzacji wykonania ani lease.
- [ ] GREEN wymaga zapis → kontrolowany restart własnej instancji w pustym oknie → publiczne HTTP metadata/binary → te same digests i wartości. Kontrola tylko pamięci procesu nie zalicza cold-load. Quantity catalog nie reklamuje H demag/m/frozen_spins na obserwacji anteny.
- [ ] Commit `feat(storage): archive study domain field bindings`.

## T8. Explorer i stabilne Inspectory dla każdej domeny

**Files:** właściciele T8; nowe `studyDomainResources.test.ts`, `modules/explorer/studyDomainNodes.test.ts`, `modules/inspector/panels/airbox/StudyDomainInspectors.dom.test.tsx`.

**Interfaces:** consumes generated DTO od canonical scene/runtime resources T1–T7; produces `studyDomainVisualizationTargetId(domainId: string): string` w istniejącym module identity, kodowanie `domain:${encodeURIComponent(domainId)}`. Ten sam resolver w drzewie, wyborze, cache i rendererze; legacy `airbox` tylko dla legacy wyniku.

**Test command:** `pnpm exec vitest run src/kernel/resources/studyDomainResources.test.ts src/modules/explorer/studyDomainNodes.test.ts src/modules/inspector/panels/airbox/StudyDomainInspectors.dom.test.tsx --maxWorkers=1`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać `same_label_distinct_domain_identity`: identyczna nazwa, różne ID, niezależna widoczność/quantity; nie wysyła żądań frozen_spins dla powietrza. Dodać SSR=first-client, zmianę sesji w locie i brak request storm.
- [ ] Uruchomić Vitest: RED na kolizji `model:airbox`/`airbox`.
- [ ] Rozszerzyć canonical scene/API schemas i wykonać codegen; jeden typed client, resource layer i owner subskrypcji. Utworzyć logiczne drzewo według sekcji 12 projektu. Każdy semantyczny child ma własny detail view, współdzieląc szablon zamiast kopiować logikę pól.
- [ ] Panele pokazują role, stage owner, bounds, mesh ID/revision, wspólny rdzeń, liczności i readiness. Edycja przez canonical authoring command z revision check; pending per pole/transakcja. Quantity opcje pochodzą z carrier/catalog, nie z roli nazwanej przez UI.
- [ ] GREEN: test zachowuje root identity, focus, draft i scroll przez pending/ACK; zero niepowiązanych disabled/opacity i animacji opacity; najwyżej jeden owner subskrypcji na zasób. Uruchomić także istniejące Object/Airbox regresje, lint/types.
- [ ] Commit `feat(ui): distinguish antenna and demag domains`.

## T9. Postęp etapów i rzeczywisty viewport

**Files:** właściciele T9; nowy `DomainExecutionTelemetry.test.tsx`; scenariusz w istniejącym managed browser QA i jego testach.

**Interfaces:** consumes bieżący session/epoch/run/stage i istniejące wykonawcze liczniki; produces `DomainExecutionTelemetry({stageId, domainId, phase, completed, total, elapsedSeconds}: Props)`; phase `mesh | transport | field | publication | llg`, `Props` ma `stageId: string`, `domainId: string`, `phase` według tego enum, `completed: number | null`, `total: number | null`, `elapsedSeconds: number | null`; unknown nigdy nie znaczy 0% ani 100%.

**Test command:** `pnpm exec vitest run src/modules/footer/DomainExecutionTelemetry.test.tsx --maxWorkers=1`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Dodać testy authored-not-started, aktywny stage innego run, ukończony transport przy trwającym H, brak total i skok do nowej fazy. ETA tylko z monotonicznej pracy bieżącej fazy; reset po zmianie scope/phase; bez czasu fikcyjnego kroku LLG.
- [ ] Uruchomić testy: RED na pomyleniu faz/domen lub braku szczegółów.
- [ ] Zintegrować instrumenty z istniejącym Footer i actual progress producer; nie tworzyć UI polling loop równoległego do stage resource. Jeśli etap nie publikuje licznika, uzupełnić jego istniejący event/provenance kontrakt, bez szacowania x/N z liczby odświeżeń.
- [ ] Dodać realny browser scenariusz: wybór obu domen, H źródła/legendy, wyłączenie wireframe przed glyphs, przekrój i camera rotate. Wymagane screenshoty before/after; canvas visible, buffer >0, `gl.isContextLost() == false`; niezerowe, czytelne glyphs z prawdziwego payloadu.
- [ ] GREEN: quantities nie mieszają się między domenami, zmiana widoczności/kamery nie uruchamia Solve, inspector focus/scroll stabilne, brak request storm i redraw w idle. Sama etykieta data-ready ani test DOM nie zaliczają pola. Zablokowana przeglądarka pozostawia tę bramkę otwartą.
- [ ] Commit `feat(ui): observe domain compute phases and fields`.

## T10. Odbiór publicznego scenariusza i naukowe bramki

**Files:** właściciele T10; nowe `scripts/test_verify_antenna_magnetic_domains.py` i raport `docs/superpowers/plans/2026-11-02-antenna-magnetic-domains-validation.md`.

**Interfaces:** consumes rezultaty T1–T9; produces verifier `python3 -B scripts/verify_antenna_magnetic_domains.py --bundle <wynik.zarr> --report <report.json>` odczytujący finalny bundle oraz jego stage artifacts. Raport zawiera pełne SHA źródeł, receipt runtime, source/mesh/carrier pins, liczniki solves, bramki PASS/FAIL/NOT_RUN i powód.

**Test command:** `python3 -B -m pytest -p no:cacheprovider scripts/test_verify_antenna_magnetic_domains.py`; uruchomienie w kontenerze zgodnie ze wspólną procedurą. Dla nowego testu przed implementacją oczekiwany RED, po implementacji exit 0 i wszystkie przypadki PASS.

- [ ] Napisać test verifiera odrzucający bundle bez core map, częściowe H i fałszywy status kwalifikacji. RED przed dodaniem weryfikatora, później GREEN; verifier nie uruchamia solvera.
- [ ] Przygotować płaski skrypt `study` według repo patterns: jawny FEM CPU/double, pełna zaakceptowana GSG, magnetyczny target i oba otoczenia. Fizykę próbki z publikacji przepisać wyłącznie z kompletnej tabeli źródłowej i noty 0951; uzupełnić brakujące parametry przed Run, bez zgadywania z obrazka.
- [ ] Uzupełnić kanoniczne noty 0100/0102/0107/0950: parametry/defaulty/walidacja, Python→IR, source-map path+symbol, wszystkie cztery lane i jawne bramki. Focused validator, contract tests i changed-page; publiczna publikacja dodatkowo Sphinx/rendered HTML. Nowy plan nie zastępuje tych not.
- [ ] Zbudować przez recepturę dobraną we wspólnej procedurze: dla naszej zapisanej sceny zarządzany restart saved-authoring z dokładnymi pinami; zwykły docker-dev-build tylko dla odpowiedniego stanu grupy. Po przejściu bramek uruchomić powyższy publiczny skrypt do końca, zapisać sibling `.zarr` i zweryfikować przez publiczne API oraz cold-load. Nie nadpisywać jawnego output path. Build bez wykonania skryptu nie zalicza runtime.
- [ ] Przeprowadzić osobną zbieżność transportu, pola na próbce i meshu magnetycznego; co najmniej trzy poziomy dla każdego deklarowanego zakresu. Użyć dotychczasowych tolerancji/budżetów zapisanych w notach przed oceną; jeśli brak granicy błędu, nie kwalifikować tego zakresu. Wykonana wcześniej kontrola trzech punktów GSG nie kwalifikuje całej mapy.
- [ ] Jeśli źródło nie spełnia pełnych gates 0950, zakończyć field inspection z jawną odmową LLG; status tej części pozostaje nieukończony. Po spełnieniu gates wykonać DC Relax/AC Run z shared core, potwierdzić brak nowych transport solves i pełne pokrycie; m(k,ω) i porównanie publikacji pozostają osobnym E9, a nie FFT H nazwanym wzbudzoną falą.
- [ ] Uruchomić końcowe lint, types, pełne testy frontend kolejno, wymagane CI i browser QA. Raport rozdziela: kod, fixture, real runtime, qualification, UI E2E; nie sumować ich do jednego procentu done.
- [ ] Commit `test(antenna): qualify shared-domain public workflow`; aktualizacja starego E0–E12 zawiera linki do dowodów oraz nadal otwarte E1/E9 i pozostałe wymagania.

## Kontrola planu i warunki przekazania

Self-review 02.11.2026: sekcje projektu 1–6 → T1/T2; meshing 7 → T3/T4; realizacje 8 → T5/T10; API/IR 9–10 → T1/T2/T5; błędy/cache/archive 11 → T5–T7; UI 12 → T8/T9; validation i limitations 14–16 → T10. Wszystkie pięć Review Focus ma nazwany przypadek w zadaniu właściciela. Interfejsy downstream używają tych samych nazw pól co kontrakt. Nie ma implementacyjnego dowodu nowego workflow w tym dokumencie.

Do przeglądu przed wykonaniem: kompletność planu, proponowany opt-in wire i metoda wykonania. Rekomendowana metoda: **subagent-driven**, zadania kolejno po granicach kontraktów, z oddzielnym review każdego; bez równoległych edycji tych samych ownerów. Koszt błędu mapy meshu/normalizacji jest naukowy, dlatego niezależne review ma tu większą wartość niż dla zmian czysto wizualnych.

Przygotowanie planu nie uruchamia Solve, migracji danych ani nowego buildu. Bieżące testy wcześniejszych poprawek UI mają własny receipt i nie są dowodem implementacji T1–T10.
