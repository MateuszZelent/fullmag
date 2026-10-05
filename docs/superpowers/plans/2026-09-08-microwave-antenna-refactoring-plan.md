# Plan implementacji refaktoryzacji modułu anten mikrofalowych

> **Dla wykonawcy:** realizuj zadania kolejno przy użyciu `executing-plans`; jeśli praca zostanie jawnie rozdzielona na agentów, stosuj `subagent-driven-development`. Każda pozycja `- [ ]` wymaga rzeczywistego wykonania i dowodu. Nie oznaczaj jej jako zakończonej na podstawie samego kodu.

**Cel:** usunąć wszystkie problemy wskazane w [audycie z 2026-09-08](../../audits/2026-09-08-microwave-antenna-worktree-audit.md), a następnie domknąć reprodukowalny przepływ przewodnik 3D → prąd → baza pola → relaksacja bez RF → LLG z RF → wyniki w Python i Control Room.

**Architektura:** wspólne obiekty, geometria, materiały i CurrentTransport są właścicielami fizyki. Antena wiąże terminale w porty, uruchamia niezależny solve pola i dostarcza immutable wektorową bazę na amper. LLG, frontend i analizy konsumują ten sam wynik przez jawne projekcje i wersjonowane kontrakty.

**Stos technologiczny:** Python DSL, Rust IR/planner/runner/API, MFEM/hypre CPU, istniejące konserwatywne RT0 i adaptacyjne Biot–Savart, natywne realizacje FEM/FDM, Next.js 16/React, generowany OpenAPI v2, istniejący facade i resource hooks, Vitest/Playwright oraz kontenerowe recipes `just`.

**Status na 2026-09-20:** częściowo zaimplementowany, bez końcowego odbioru produkcyjnego. Punkt wznowienia: HEAD `d95ddb72a193ef6bcd06a5624f144e6c2f8c5cf8`. Czytaj najpierw [stan i kolejkę dalszej pracy](../../validation/antenna/continuation-2026-09-20.md), następnie odpowiednie zadania T00–T18. Wpisy implementacyjne z 2026-09-09–12 dokumentują postęp; pozostałe propozycje plików, funkcji i testów nadal wymagają sprawdzenia w źródłach.

**Jak czytać checklistę:** `[x]` oznacza zamknięcie podanego zakresu, a `[ ]` brak pełnego odbioru danej pozycji; część takich pozycji ma już implementację lub historyczny wynik testu. Nie wyliczać procentu ukończenia z liczby checkboxów. Dopiski o pozytywnych testach nie zamykają automatycznie całego zadania ani innych backendów. Wynik historyczny wymaga wskazania rewizji i zakresu; zmiana właściciela kodu wymaga ponownej weryfikacji.

Pierwotna podstawa planowania: dirty snapshot audytu, HEAD `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5`, lokalny master `7faa259c5597ba447c413f2aea0ff66d6110b297`. Późniejszą integrację opisuje [punkt bazowy](../../validation/antenna/integration-baseline.md). Nie jest to potwierdzenie synchronizacji z najnowszym zdalnym masterem na 2026-09-20.

Rozpoczęcie: 2026-09-08. Ukończenie dokumentu: 2026-09-09. Nazwa pliku zachowuje datę rozpoczęcia wspólnego audytu i planowania.

## Ograniczenia globalne

- Najpierw naprawić semantykę, następnie integrację i ergonomię. Nie promować niezweryfikowanego feature flagiem UI.
- Pozostawić Tier 1 jako jednokierunkowy model DC/quasistatic; nie dopisywać do niego S-parametrów, dBm ani impedancji bez osobnej fizyki.
- Nie wracać do 2.5D dla taperów/przewężeń. Nie zastępować źródła przewodnikowego regionalną maską.
- `object_id`, nazwa, typ prezentacyjny i aktywowane moduły fizyczne pozostają osobnymi pojęciami. Typ `antenna` nie uruchamia fizyki.
- Wszystkie istotne parametry muszą przejść Python → IR → planner → runtime → artefakt → OpenAPI → UI/export.
- Zachować `H_ant` w A/m i bazę `H_ant_basis` na amper. `mu0 H` jest transformacją jednostki prezentacji.
- MFEM/hypre/RT0/Oersted pozostają w `backends/fem`; runner nie dostaje nowego solvera FEM ani numeryki portów.
- Nie dodawać fizyki do `Context` ani `mfem_bridge.cpp`. Zachować wyłączony domyślnie profiler solvera.
- Native build i runtime proof wykonuje kontenerowe `just`. Host `cargo`/`cmake` nie stanowią finalnego dowodu FEM.
- Windows: Docker Desktop Linux engine i istniejące zarządzane launchery; build/cache/pnpm/Playwright poza checkoutem. Nie kopiować linuxowych ścieżek mountów do Windows bez ich weryfikacji.
- Jedna scena, jeden ribbon i wspólna ścieżka viewportu. HTTP v2 jest źródłem stanu; websocket tylko zdarzenia i invalidation.
- Zachować Next.js 16, `fm-` w klasach CSS, tokeny `--fm-*`, wspólne primitives i import-only `app/globals.css`.
- Zachować poprawki master dla mixed meshes, frozen spins i wymuszonego GPU. Nie nadpisywać całych plików jedną wersją gałęzi.
- Test RED musi przejść przez wadliwą granicę: mock DTO nie zastępuje transakcji, zgodne moduły FFT nie zastępują zgodnej fazy, hash pliku nie zastępuje aktualności modelu.
- Każdy commit obejmuje tylko zadanie. Bezpośrednio przed commitem osobno wykonać `git diff --cached --name-only`; nie łączyć tego polecenia z `git commit`.

(plan-problem-statement)=
## 1. Mapa problemów na zadania

| Problem lub luka z audytu | Zadania | Warunek zamknięcia |
|---|---|---|
| F01: utrata kompozycji sceny | T03, T04, T15 | Prawdziwa transakcja i round-trip zachowują wszystkie referencje |
| F02: znaki i niewykonywany kontrakt prądowy | T02, T05, T06 | Podpisane prądy zgadzają się z portem i są rzeczywistymi ograniczeniami solve |
| F03: RF podczas Relax | T07, T13 | Domyślna antena nie wpływa na równowagę |
| F04: stale artifact | T08, T12 | Konsument porównuje aktualne zależności, nie tylko bajty |
| F05: maska targetu za późno | T09 | Węzły poza targetem nie wymagają danych |
| F06: brak walidacji waveform/activation | T07 | Rust odrzuca nieprawidłowy JSON i stage IDs |
| F07: missing sample udaje outside-domain | T09, T10 | Brak interpolacji nigdy nie jest fizycznym zerem |
| F08: faza FFT | T10 | Structured FFT i direct DFT zgadzają się zespolenie |
| F09: brak zgodnego Inspectora/workflow | T04, T14, T15 | Użytkownik może zbudować i uruchomić antenę bez surowego JSON |
| F10: schema-less DTO i OpenAPI drift | T03, T14 | Wszystkie pięć kolekcji oraz zasoby wyników są typowane |
| F11: nadpisywanie fazy/draftu i transakcje | T15 | Edycja zachowuje pozostałe parametry i pracę użytkownika |
| F12: pozorny lifecycle | T12, T14 | Postęp i anulowanie odpowiadają rzeczywistemu wykonaniu |
| F13: milion par źródło–target | T11 | Preflight, jawny koszt i kwalifikowane wykonanie bez ukrytej redukcji jakości |
| Brak pełnego 3D taper authoring | T04, T06 | Geometria, terminale, siatka i pole zmieniają się fizycznie |
| Brak stage-first Python / ręczne hashe | T03, T12, T13 | Stage/output rozwiązuje runtime; skrypt działa od pustego katalogu wyników |
| FDM i frequency response odrzucone | T16, T17 | Każda ścieżka osobno kwalifikowana albo jawnie unavailable |
| Diagnostyka ważności modelu | T02, T11, T14 | Pasmo i ograniczenia są widoczne przy solve i zmianie waveform |
| Brak fixture `4.5GHz_fem.py` | T01 | Publiczny test ma śledzony, reprodukowalny fixture |
| Cztery błędy source-map 0950 i nieaktualne API | T02, T18 | Pełna dokumentacja bieżącej implementacji i wykonane przykłady |
| Rozjazd z master / brak kwalifikacji | T00, T01, T18 | Udokumentowany wynik integracji, testy mixed mesh/constraints i runtime receipts |

Kolejność podstawowa: `T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18`. T07 i naprawa zachowania parametrów w T15 mogą być niezależnymi małymi patchami po ustaleniu kontraktu T02. Nie wykonywać równolegle zmian tych samych struktur IR/ABI/sceny.

(plan-governing-equations)=
(plan-symbols-and-si-units)=
(plan-assumptions-and-validity)=
## 2. Decyzje fizyczne i wybór rozwiązania

Równania, symbole i SI pozostają w kanonicznej notatce 0950; audyt wyjaśnia zakres ich poprawności. Plan nie wprowadza drugiego właściciela równań. T02 i T05 uzupełniają tam kontrakt terminali, a T11 diagnostykę pasma i budżetu.

**Porty:** docelowo wybrać integral-current/equipotential przez terminalową macierz przewodności istniejącego solve H1. Alternatywa to dobieranie napięć ręcznie i odrzucanie niezgodnych proporcji. Jest prostsza, lecz nie realizuje obiecanych wag portu i powoduje kłopoty przy zmianie geometrii. Nie zostaje rozwiązaniem docelowym.

**Projekcja:** najpierw naprawić identity+mask, następnie dodać rzeczywiste point location/interpolację P1 oraz możliwość bezpośredniego obliczenia pola na nowych punktach z zachowanego RT0. Bezpośrednia ewaluacja jest dokładniejszą kontrolą błędu próbkowania; interpolacja jest szybsza przy wielu odczytach. Obie mają osobne identyfikatory realizacji i kryteria użycia.

**Zakres EM:** najpierw zamknąć Tier 1. Import zespolonego pola i harmoniczne MQS to osobny późniejszy projekt. Brak pełnego Maxwella nie blokuje przydatnego wzbudzenia LLG; nie wolno jednak użyć tej decyzji jako pretekstu do pominięcia skin/proximity warnings.

(plan-implementation-mapping)=
## 3. Mapa własności plików

`Istniejący` oznacza plik odczytany w audycie; może nadal być nieśledzony przez Git. `Nowy` oznacza proponowany plik, który ma powstać dopiero podczas realizacji.

| Właściciel | Pliki istniejące do zmiany | Nowe pliki planowane |
|---|---|---|
| Fizyka/ADR | `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`, jej source-map, `docs/adr/0017-staged-antenna-field-basis-workflow.md`, `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md` | Raporty kwalifikacji pod `docs/validation/antenna/` |
| Python | `packages/fullmag-py/src/fullmag/model/antenna.py`, `model/problem.py`, `world.py`, `model/geometry.py`, eksporty `__init__.py` | `packages/fullmag-py/tests/test_antenna_stage_workflow.py`, `test_antenna_layout.py` |
| IR | `crates/fullmag-ir/src/antenna.rs`, `validation.rs`, `plan.rs`, `lib.rs` | `crates/fullmag-ir/src/field_drive_validation.rs` |
| Scena/export | `crates/fullmag-authoring/src/scene.rs`, `builder.rs`, `adapters.rs` | `crates/fullmag-authoring/tests/antenna_roundtrip.rs` |
| Planner | `crates/fullmag-plan/src/antenna_composition.rs`, `antenna_field_solve.rs`, `antenna_projection.rs`, `util.rs`, `spin_transport.rs`, `mesh.rs` | `crates/fullmag-plan/src/antenna_preflight.rs` |
| Native charge | `backends/fem/cpu/mfem/transport/steady_transport.cpp`, `.hpp`, `_c_api.cpp`, `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys/src/lib.rs`, `crates/fullmag-engine/src/fem.rs` | `backends/fem/cpu/mfem/transport/terminal_current_constraints.hpp`, `.cpp`, `backends/fem/tests/antenna_terminal_current_contract.cpp` |
| Native projection | Istniejący właściciel `oersted/direct_tetra_quadrature.*` | `backends/fem/cpu/mfem/transfer/antenna_field_projection.hpp`, `.cpp`, `backends/fem/tests/antenna_field_projection_contract.cpp` |
| Artefakty/runtime | `crates/fullmag-runner/src/antenna_field_solution.rs`, `antenna_stage.rs`, `antenna_fields.rs`, `antenna_spectrum.rs`, `native_fem/charge_transport.rs`, `native_fem.rs` | `crates/fullmag-runner/src/antenna_validity.rs` |
| CLI | `crates/fullmag-cli/src/orchestrator.rs`, `step_utils.rs`, `types.rs` | `crates/fullmag-cli/src/antenna_workflow.rs` |
| API | `crates/fullmag-api/src/schemas/authoring.rs`, `router_v2/handlers/model/authoring.rs`, `router_v2/handlers/data/artifacts.rs`, `router_v2/handlers/data/fields.rs` | `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` |
| Frontend transport | `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `kernel/resources/ResourceInvalidationController.ts`, `kernel/api/generated/openapi-v2*` | `apps/control-room/src/kernel/resources/antennaResources.ts`, `.test.ts` |
| Frontend authoring | `kernel/authoring/geometryLifecycleCommandContributions.ts`, `modules/explorer/builders/objectExplorerNodes.ts`, `modules/ribbon/ribbonContributions.tsx`, `modules/inspector/panels/AntennaObjectPanel*` | Podkatalog `modules/inspector/panels/antenna/` z panelami opisanymi w T15 |
| Gates i scenariusze | `justfile`, `backends/fem/CMakeLists.txt`, `scripts/run_fem_cpu_only_contract.sh`, istniejące skrypty Windows i definicje compose | `scripts/verify_antenna_contracts.sh`, `scripts/windows/verify_antenna_contracts.ps1`, `tests/antenna/`, `apps/control-room/scripts/smoke-antenna-workflow.mjs` |

Nie przenosić całych monolitów tylko z powodu liczby linii. Wydzielić wyłącznie nowe obowiązki antenowe z CLI i numerykę portu/projekcji z wrapperów; zachować sprawdzone istniejące operatory.

## T00. Ustabilizować punkt startowy i integrację z master

**Wejście:** inwentarz 77 plików audytu oraz dwa pełne SHA. **Wyjście:** nazwany snapshot roboczy i dziennik integracji bez utraty zmian.

- [ ] Odczytać `AGENTS.md`, status, staged paths i aktualne SHA. Porównać hashe z inwentarzem raportu; jeśli plik się zmienił, ponownie sprawdzić związany z nim finding przed edycją.
- [ ] Utrwalić wszystkie pliki modułu, również `??`, jako izolowany snapshot. Nie stage’ować całego współdzielonego worktree przez `git add .`; explicit file list ma pochodzić z audytu i statusu.
- [ ] W osobnym worktree integracyjnym połączyć snapshot z master. Nie wykonywać merge/reset/stash nad nieutrwalonymi zmianami innych zadań.
- [ ] Rozwiązać najpierw `plan.rs` i publiczne struktury, następnie konstruktory/adaptery, a na końcu execution. W `project_regional_field_drive_bases` zachować jednocześnie branch preprojected i kontrole mixed-mesh z master.
- [ ] Utworzyć `docs/validation/antenna/integration-baseline.md` z SHA, listą konfliktów, decyzjami i wynikami bazowych testów. Commit integracji nie może zawierać późniejszych poprawek fizyki.

Polecenia diagnostyczne wykonywać oddzielnie:

```powershell
git status --short
git diff --cached --name-only
git rev-parse HEAD master
git merge-base HEAD master
git diff --name-only HEAD master
git diff --check
```

**Test zamknięcia:** żaden z 77 audytowanych plików nie zniknął bez udokumentowanej migracji; mixed-mesh global uniform i frozen-spins regression z master pozostają w zestawie uruchamianych testów.

## T01. Przygotować powtarzalne bramki i naprawić fixture testowe

**Pliki:** `justfile`, `scripts/run_fem_cpu_only_contract.sh`, nowe dwa skrypty verification z mapy, `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`; nowy `packages/fullmag-py/tests/fixtures/gaussian_plane_wave_fem.py`.

- [ ] Utworzyć recipe **nowe** `verify-antenna-contracts group="all"`. Przyjmuje wyłącznie grupy z poniższej listy; nie przyjmuje dowolnego tekstu polecenia shell.
- [ ] Wykorzystać istniejący container entrypoint. Na Windows użyć Docker Desktop Linux engine i walidacji bezwzględnych zewnętrznych rootów ze skryptów Windows; bez named volumes, WSL exec i lokalnego `target/`.
- [ ] Zdefiniować wewnątrzkontenerową listę programów/testów dla każdej grupy. Host nie wywołuje bezpośrednio natywnego Cargo/CMake. Grupa ma zwracać błąd, jeśli filtr uruchomił zero wymaganych testów.
- [ ] Wszystkie wyniki zapisywać do zewnętrznego katalogu raportu z commit SHA, hashami dirty źródeł, komendą, exit code, liczbą testów i urządzeniem. Skipped GPU oznacza `not_qualified`, nie PASS.
- [ ] Odtworzyć brakujący fixture na podstawie oczekiwań `test_fem_counterpart_preserves_geometry_gradient_and_antenna_contract`: zachować FEM, geometrię, gradient i parametry GaussianPlaneWave. Przenieść test na śledzony fixture w pakiecie. Nie usuwać asercji i nie oznaczać testu skip tylko dlatego, że prywatny `tests/vlad` nie jest dostępny.
- [ ] Uruchomić dotychczasowe cztery suites Python i bazowe bramki `just`; zapisać rzeczywiste wyniki przed dalszą implementacją.

Wartości grup nowego recipe:

```text
model
authoring
native-current
native-field
artifact
projection
spectrum
budget
lifecycle
fem-llg
fdm-cpu
fdm-gpu
fem-gpu
frequency-response
browser
all
```

Istniejące polecenia, od których należy zacząć:

```text
just --dry-run verify-fem-charge-transport-abi-contract
just verify-fem-charge-transport-abi-contract
just verify-fem-solved-antenna-drive-contract
just verify-fem-oersted-oet0-cpu-contract
```

Po dodaniu wrappera pozostałe zadania używają `just verify-antenna-contracts <grupa>`. Każde takie polecenie w planie jest **nowym kontraktem do wykonania T01**, nie istniejącym dowodem działania.

## T02. Zamknąć fizyczny kontrakt portów i migrację

**Pliki:** 0950 i source-map, ADR 0017, capability matrix, `crates/fullmag-ir/src/antenna.rs`, `packages/fullmag-py/src/fullmag/model/antenna.py`.

**Decyzja:** gałąź ma dwa jawne terminale i kierunek od inlet do outlet. Dodatnia waga oznacza prąd zgodny z tym kierunkiem. Współrzędne świata i lokalna orientacja muszą być zapisane; nie wnioskować kierunku z nazwy `signal` ani numeru markera.

- [ ] Zastąpić niejednoznaczną pojedynczą referencję terminalu **nowym wersjonowanym** kontraktem gałęzi. Nie zmieniać interpretacji starych zapisanych JSON w miejscu.
- [ ] Wprowadzić dokładnie pola poniższego projektu. Wagi dodatnie muszą sumować się do 1, wszystkie do 0; każda gałąź ma niezerową wagę, dwa różne niepuste selektory i dodatnie pole terminali. Sprawdzić, że terminale należą do wskazanego przewodnika i są elektrycznie sensowne.
- [ ] Nadać portowi discriminator `schema_version="antenna_port_mode.v2"`. W bieżącym kanonicznym `AntennaPortModeIR.branches` używać `AntennaPortBranchV2IR`; stare dekodowanie wyizolować w importerze. Brak discriminator w starym dokumencie nie uprawnia do odgadnięcia par terminali.
- [ ] Zaktualizować port/stage/plan tak, aby przenosiły tę samą parę terminali, a nie redukowały jej z powrotem do pojedynczego ID.
- [ ] Stary kontrakt z jednym terminalem zachować wyłącznie w importerze compatibility. Jeśli nie ma jednoznacznej pary i zamknięcia, zwrócić `antenna_port_migration_requires_terminal_pairs`. Nie wybierać „drugiej ściany” heurystycznie.
- [ ] Rozdzielić definicję portu od ConservativeCurrentView: pierwszy ustala wymuszenie i orientację, drugi przechowuje zachowawczy prąd oraz zamknięcie. Sprawdzać zgodność obu; suma wag nie zastępuje dowodu zamknięcia.
- [ ] Dodać negatywne testy obu wersji IR: powtórzone terminale, brak powrotu, nieznany obiekt, niezgodne domain, suma dodatnia 2 zamiast 1, zero, NaN, pusty ID.

Projekt nowego typu, do zadeklarowania w T02:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortBranchV2IR {
    pub id: String,
    pub inlet_terminal_ref: String,
    pub outlet_terminal_ref: String,
    pub signed_weight: f64,
}
```

Nie dodawać jednocześnie kopii geometrii, przewodności ani materiału do tego typu. Dla CPW stosować trzy gałęzie `(1, -0.5, -0.5)`, każdą z własną parą końców. `normalization_current_a` pozostaje dokładnie 1 A.

**Bramka:** `just verify-antenna-contracts model`. Błędne porty mają być odrzucone w modelu, zanim powstanie natywny solver. Dokumentacja otrzymuje kompletną tabelę nowych parametrów z SI i mapowaniem Python → IR; wszystkie zmiany publiczne pozostają oznaczone jako niekwalifikowane do T18.

## T03. Zachować model w SceneDocument, builderze i Python stage API

**Pliki:** `scene.rs`, `builder.rs`, `adapters.rs`, API schema/authoring handler, `model/problem.py`, `world.py`, istniejący test composition; nowe `antenna_roundtrip.rs` i `test_antenna_stage_workflow.py`.

**Wejście:** wersjonowane typy port/stage/projection/drive/spectrum. **Wyjście:** scena i builder przechowują wszystkie kolekcje, a publiczny workflow nie wymaga ręcznego JSON ani hashy.

- [ ] Najpierw dodać test RED rzeczywistego `apply_scene_merge_patch`: scena minimalna + pięć niepustych kolekcji → deserializacja → serializacja. Oczekiwać zachowania każdego ID; obecny kod zgubi dane.
- [ ] Dodać typowane pola do `SceneDocument` i `ScriptBuilderState`, wraz z serde default dla starych scen. Te same typy wykorzystać w `SceneResource`, bez `Vec<Value>`.
- [ ] Przenieść kolekcje we wszystkich kierunkach adapterów, także eksport/import i rewrite overrides. Nie wystarczy adapter tylko scene → DTO.
- [ ] W `world.py` dodać **nowe** metody `StudyStagesBuilder.add_antenna_field_solve` i `StudyBuilder.add_solved_antenna_drive` z dokładnie określonymi argumentami poniżej. Rejestracja solve zwraca symboliczną referencję stage/output, nie już istniejący digest.
- [ ] Wytworzyć pipeline node o istniejącym zamiarze `antenna_field_solve`; nie tworzyć drugiej listy etapów o odrębnej kolejności. Uporządkować relację `StudyIR` i `StudyPipelineDocument` w ADR 0017.
- [ ] Lowering do runnera zachowuje requested execution oddzielnie dla precompute i późniejszego LLG. Wersja authoring reference nie zawiera fizycznych ścieżek lokalnych.
- [ ] Dodać test API transakcji → GET → export → loader → IR, korzystając z rzeczywistej warstwy authoring zamiast mocka `commitTransaction`.

Pola do włączenia w kanonicznych właścicielach, z finalnymi wersjami typów T02:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_port_modes: Vec<fullmag_ir::AntennaPortModeIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_field_solve_stages: Vec<fullmag_ir::AntennaFieldSolveStageIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_target_projections: Vec<fullmag_ir::AntennaTargetProjectionRefIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub solved_antenna_drives: Vec<fullmag_ir::SolvedAntennaDriveIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_spectrum_requests: Vec<fullmag_ir::AntennaSpectrumRequestIR>,
```

Projekt publicznych argumentów nowych metod:

| Metoda | Argumenty | Wynik |
|---|---|---|
| `study.stages.add_antenna_field_solve` | keyword-only `id: str`, `definition: AntennaFieldSolveStage` | `AntennaStageOutputRef` z `stage_id`, `output_id`; zgłosić błąd, gdy brak dokładnie jednego żądanego H_ant_basis output |
| `study.add_solved_antenna_drive` | keyword-only `drive: SolvedAntennaDrive`, `projection: AntennaTargetProjection` | Zarejestrowany drive; ID musi być unikalne |

Nowy `AntennaStageOutputRef` to authoring intent. `AntennaFieldSolutionRef` z asset/digest pozostaje resolved reference po wykonaniu. T08/T12 definiują ich kontrolowane rozwiązanie; nie udawać, że hash pierwszego solve można znać podczas pisania skryptu.

Definicja nowej referencji authoringu w `model/antenna.py`:

```python
# %% Projekt nowego typu do wdrożenia w T03; bez wykonywania solve
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class AntennaStageOutputRef:
    stage_id: str
    output_id: str

    def __post_init__(self) -> None:
        if not self.stage_id.strip() or not self.output_id.strip():
            raise ValueError("stage_id and output_id must be non-empty")

    def to_ir(self) -> dict[str, str]:
        return {
            "kind": "stage_output",
            "stage_id": self.stage_id,
            "output_id": self.output_id,
        }
```

`AntennaTargetProjection.solution` ma podczas authoringu przyjmować tę referencję; resolved plan zawiera istniejącą pełną `AntennaFieldSolutionRefIR`. Dla jawnie zaimportowanych gotowych assetów dopuścić drugi discriminator `kind="resolved_asset"` i sprawdzanie T08. W scenie zachować autorską symboliczną referencję, nie zastępować jej trwale hashami po każdym runie. Golden tests mają chronić oba typy referencji i eksportować je bez utraty intencji.

**Bramka:** `just verify-antenna-contracts authoring`; Python tests stage workflow muszą przejść także na scenie bez anten i na imporcie starego regional drive. Commit: `fix: preserve antenna composition through scene round trips`.

## T04. Dokończyć rzeczywistą geometrię 3D i jej wygodne tworzenie

**Pliki:** istniejący `model/geometry.py`, `model/antenna.py`, odpowiednie geometry variants w IR, `crates/fullmag-plan/src/mesh.rs`, frontendowa komenda; nowe `test_antenna_layout.py` i `tests/antenna/scenarios/cpw_constriction.py`.

- [ ] Umieścić opis stacji szerokości jako parametr współdzielonej geometrii, nie w `SolvedAntennaDrive`. Port odwołuje się do obiektu z tą geometrią.
- [ ] Zdefiniować dla microstrip: długość, grubość, ordered stations `(s, signal_width_m)` i jawny obiekt return. Dla CPW: station posiada także left/right gaps oraz ground widths. `s` jest bezwymiarowe, od 0 do 1.
- [ ] Walidować skończoność, ścisły porządek, końce 0/1, dodatnie wymiary, brak nakładania metalu, niezerowe end faces i zgodność terminali po transformacji.
- [ ] Generować skończone bryły 3D i markery inlet/outlet ze wspólnego geometry pipeline. Nie tylko rysować taper w Three.js. Stacje wyznaczają piecewise-linear loft; rigid transform stosuje się do wszystkich przewodników i terminali razem.
- [ ] Tworzyć `object_id` raz; edycja nazwy lub geometrii nie nadaje nowego ID. Zmiana geometrii podbija geometry revision i podpisy zależności T08.
- [ ] Domyślny kreator ma tworzyć komplet sygnał + returns + terminal pairs + current module + port; brak targetu oznacza `incomplete`, nie `ready`. Nie dodawać automatycznie magnetyzacji do miedzi.
- [ ] Testować eksport parametrów, nie tylko triangulacji; po export/reimport użytkownik nadal może edytować stacje.

Fixture geometrii do zamrożenia w teście:

```json
{
  "length_m": 0.00001,
  "thickness_m": 0.0000001,
  "stations": [
    {"s": 0.0, "signal_width_m": 0.000001},
    {"s": 0.4, "signal_width_m": 0.000001},
    {"s": 0.48, "signal_width_m": 0.0000002},
    {"s": 0.52, "signal_width_m": 0.0000002},
    {"s": 0.6, "signal_width_m": 0.000001},
    {"s": 1.0, "signal_width_m": 0.000001}
  ]
}
```

Powyższy JSON jest specyfikacją testowego kształtu, nie deklaracją obecnego top-level konstruktora. CPW test dopisuje jawne stałe dodatnie gap/ground widths w każdym wierszu. Wymagać trzech przekrojów: szeroki, wejście taperu, przewężenie, oraz tego samego wolumenu po obrocie.

**Bramka:** `just verify-antenna-contracts model` i `authoring`. Test pola po zmianie stacji należy do T06; test samej bryły nie kwalifikuje current crowding.

## T05. Wykonać integral-current i naprawić znak normalizacji

**Pliki:** nowe native `terminal_current_constraints.*`, istniejący steady transport i ABI, sys/engine wrappers, planner binder i runner `measured_port_current`; nowy native contract test.

**Zależność ujawniona 2026-10-01 (przykład publiczny T18):** bieżący
`AntennaFieldSolveStage.conservative_current_view_ref` jest autorskim
łańcuchem, lecz `bind_resolved_antenna_field_solve` wymaga już w planie
`charge.fem_cpu_double.conservative_current_view = Some(...)`. Publiczny
`ConservativeCurrentView` zawiera identyfikatory wierzchołków, ściany,
tożsamość siatki oraz piny rewizji. Nie ma dziś dowodu, że zwykły skrypt
`fm.study(...).stages.add_antenna_field_solve(...)` może wygenerować ten
widok z geometrii przed meshingiem i wykonać solve bez ręcznie wpisanych
identyfikatorów konkretnej siatki. Testy stage-first potwierdzają authoring,
referencje symboliczne i round-trip, ale nie uruchamiają natywnego solve.
Przed publikacją skryptu 0950 jako wykonywalnego end-to-end T05/T12 muszą
udostępnić jawny, zweryfikowany mechanizm tworzenia i wiązania konserwatywnego
widoku po meshingu oraz jego provenance; alternatywnie przykład musi jawnie
korzystać z wcześniej utworzonego, zgodnego artefaktu i testować jego piny.
Nie należy zastępować tej luki fikcyjnym `cpw_closed_current_view` ani
`fm.AntennaFieldSolve` z dawnego szkicu 0950.

**Algorytm docelowy:** korzystać z liniowości H1 i terminalowej macierzy przewodności. Dla każdej składowej elektrycznie spójnej nadać jeden gauge, wyznaczyć reakcje terminalowe dla niezależnych jednostkowych potencjałów, rozwiązać mały układ terminalowy dla zadanych podpisanych strumieni, a potem odtworzyć potencjał i prąd przestrzenny. Nie pisać drugiego solve FEM w Rust.

- [ ] W teście jednostkowym portu pokazać RED: przy wagach `(1,-0.5,-0.5)` certyfikat nie może akceptować wszystkich kombinacji znaków tych samych modułów prądu. Test dotyczy jawnie zdefiniowanych outward flux na outletach.
- [ ] Dla każdej gałęzi wyznaczyć `I_in = -weight A`, `I_out = +weight A`. Sprawdzić bilans wszystkich terminali każdej składowej spójnej; izolowana składowa bez wymuszeń nie może powodować singular solve.
- [ ] Złożyć terminal response matrix przy equipotential na każdej ścianie. Reakcje mają pochodzić z tego samego dyskretnego operatora co solve, nie z niekwalifikowanego postprocessingu gradientu w narożnikach.
- [ ] Usunąć gauge row/column albo użyć jawnego constraint; wykrywać rank deficiency i niespójny net current przed iteracją. Nie stosować arbitralnej regularizacji macierzy, aby „przeszło”.
- [ ] Odtworzyć V/J dla całego portu i sprawdzić podpisany residual każdego terminalu oraz globalny bilans. Zmiana conductance returns ma zmieniać wymagane napięcia, a nie łamać autorskich wag.
- [ ] Przekazać żądanie przez nową wersję ABI z `struct_size` i `abi_version`. Zachować istniejące V1/V2 entrypoints; przed wyborem kolejnej wersji sprawdzić aktualny master. Nie reinterpretować starych wskaźników/struktur.
- [ ] `measured_port_current` zastąpić podpisanym certyfikatem: brać prąd referencyjny z ustalonej dodatniej orientacji i dokładnie jednej strony gałęzi. Nie sumować obu końców i nie naprawiać błędnej orientacji przez `abs()`.
- [ ] Zapisać requested currents, measured currents, gauge per component, terminal voltage i wersję solvera w proweniencji. Przeskalowanie do 1 A musi objąć V, J i H, zachowując znak.

Logika podpisanej kontroli, do włączenia po rozwiązaniu terminali:

```rust
fn terminal_flux_matches(measured: f64, expected: f64, atol: f64, rtol: f64) -> bool {
    measured.is_finite()
        && expected.is_finite()
        && (measured - expected).abs() <= atol + rtol * expected.abs()
}

#[test]
fn signed_terminal_flux_rejects_reversed_return() {
    assert!(terminal_flux_matches(-0.5, -0.5, 1e-12, 1e-8));
    assert!(!terminal_flux_matches(0.5, -0.5, 1e-12, 1e-8));
}
```

Tolerancje w tej funkcji są specyfikacją certyfikatu dla 1 A, nie ogólną tolerancją trajektorii. Dodać affine bar, asymetryczne returns, odwrócenie całego portu, rozłączne przewodniki, gauge invariance i podwójny prąd. **Bramka:** `just verify-antenna-contracts native-current` oraz dotychczasowy charge ABI contract. Commit: `fix: enforce signed antenna terminal currents`.

## T06. Zweryfikować prąd konserwatywny i pole 3D

**Pliki:** istniejące `conservative_current_view` i `oersted/direct_tetra_quadrature.*`, `backends/fem/tests/oersted_direct_tetra_contract.cpp`, nowy `tests/antenna/verify_field_convergence.py` oraz fixtures pod `tests/antenna/fixtures/`.

- [ ] Przeprowadzić nowy terminal solve T05 przez istniejące RT0. Sprawdzić osobno: divergence na elementach, skoki normalnego strumienia na ścianach wewnętrznych, bilans elektrod i zgodność closure interfaces.
- [ ] Użyć istniejącej adaptive tetra/Duffy realizacji. Nie zastępować jej centroidami ani smoothingiem H przy źródle.
- [ ] Przygotować analityczne/niezależne źródła: długi skończony przewodnik, zamknięta pętla, symetryczny CPW; odległości targetów muszą obejmować near-field, obszar próbki i far-field.
- [ ] Rozdzielić błąd solve J od błędu całkowania H: przy ustalonym prądzie RT0 zacieśniać kwadraturę; przy ustalonych punktach i zaostrzonej kwadraturze zagęszczać siatkę.
- [ ] Użyć co najmniej trzech poziomów siatki dla taperu T04. Mierzyć terminal currents, normy J poza ostrymi narożami oraz L2/Linf H na tych samych punktach fizycznych. Nie wymagać zbieżności punktowego J w idealnej osobliwości.
- [ ] Wyegzekwować failure przy przekroczonym błędzie kwadratury. `unconverged_pair_count > 0` nie może przechodzić jako zwykłe ready.
- [ ] Zmierzyć liniowość: pole dla 2 A ma być dwukrotne, odwrócenie prądu ma odwracać wektor, zmiana gauge nie może zmienić J/H. Zapisać surowe wektory, a nie tylko obraz.

Tabela danych obowiązkowego fixture testu znaku:

```text
case                 I_ref_A    expected_relation
positive              1.0      H_positive
double                2.0      2 * H_positive
negative             -1.0     -H_positive
shifted_gauge         1.0      H_positive
```

**Bramka:** `just verify-antenna-contracts native-field`. Raport zawiera wszystkie poziomy, błędy i wersje operatorów; brak dopasowanego testu CPU/GPU nie jest parity proof.

## T07. Ujednolicić waveform i aktywację, odciąć RF od Relax

**Pliki:** nowe `crates/fullmag-ir/src/field_drive_validation.rs`, istniejące IR validation/antenna/lib, planner util/fem, runner antenna_fields/native_fem i FDM reference.

- [ ] Przenieść obecną funkcję `validate_time_dependence` do wspólnego wewnętrznego właściciela, zachowując wszystkie reguły. Wywoływać ją dla regional i solved drive w obu wersjach IR.
- [ ] Wspólna walidacja activation sprawdza puste, powtórzone i nieistniejące stage IDs. Powiązanie z kolejnością pipeline sprawdzać tam, gdzie znana jest cała lista stage; nie udawać kompletności lokalnej walidacji singular StudyIR.
- [ ] W plannerze dodać **nową** funkcję `drive_activation_is_active(activation: &DriveActivationIR, problem: &ProblemIR) -> bool`, używaną przez oba rodzaje drive. `AllTimeEvolution` oznacza wyłącznie `StudyIR::TimeEvolution`.
- [ ] Materializować i wczytywać artefakty tylko dla aktywnych drives. Dzięki temu Relax nie wymaga przyszłej bazy anteny, której jeszcze nie wykonano.
- [ ] Native packing otrzymuje już rozstrzygnięte aktywne termy; usunąć duplikaty „AllTimeEvolution => true”. Nie próbować odtwarzać rodzaju study z parametrów timesteppingu.
- [ ] Jawnie wybrany Relax z dynamicznym waveform odrzucić według istniejących reguł minimizera. Stałe pole w Relax wymaga jawnej aktywacji; nie wynika z domyślnego RF drive.
- [ ] Dodać regresje `solve → relax → run`, `relax → solve → run`, stage-local time restart i nieaktywnego drive z brakującym przyszłym assetem.

Sedno wspólnej reguły:

```rust
match activation {
    DriveActivationIR::AllTimeEvolution {} => {
        matches!(problem.study, fullmag_ir::StudyIR::TimeEvolution { .. })
    }
    DriveActivationIR::StageIds { stage_ids } => active_stage_id(problem)
        .is_some_and(|active| stage_ids.iter().any(|stage| stage == active)),
}
```

Fragment jest ciałem projektowanej funkcji w plannerze, gdzie istnieje `active_stage_id`; nie wolno wkleić go do native Context. Test JSON: sinusoidal `frequency_hz=-1`, pusty `stage_ids`, literówka etapu i powtórzony etap muszą zostać odrzucone. **Bramki:** `model`, `fem-llg`. Commit: `fix: scope solved antenna drives to active study stages`.

## T08. Rozdzielić integralność, aktualność i rozwiązanie referencji

**Pliki:** `antenna_stage.rs`, `antenna_field_solution.rs`, `antenna_field_solve.rs`, nowe CLI `antenna_workflow.rs`; testy w modułach i grupie artifact.

**Wejście:** symbolic stage/output z T03 i aktualny model. **Wyjście:** zweryfikowany resolved asset z oczekiwanym podpisem zależności.

- [ ] Wyznaczać current signature wyłącznie z geometrii/przewodnika, materiałów, terminal constraints, mesh, gauge i operator version. Nie dodawać czasu LLG, m0 ani waveform do tego podpisu.
- [ ] Field signature obejmuje current signature, RT0/closure, realizację i tolerancje kwadratury oraz sampling coordinates/frame. Projection signature dodatkowo obejmuje rzeczywistą topologię/kolejność i scope targetu oraz metodę projekcji.
- [ ] Dodać **nowy** resolved wrapper `ExpectedAntennaSolution` z polami: `reference: AntennaFieldSolutionRefIR`, `current_solution_signature: String`, `field_solution_signature: String`. Resolver liczy oczekiwania bez wykonywania solve.
- [ ] Loader porównuje oczekiwane podpisy ze stored manifest **przed** materializacją do backendu. Digest zawartości sprawdza osobno. Błąd aktualności wymienia kategorię zmiany: geometry, material, terminal, solver, sampling lub target.
- [ ] Nie kasować starego immutable artefaktu, gdy jest stale względem bieżącej sceny. Nadal może być potrzebny do reprodukcji wcześniejszego runu. Aktualny run nie może użyć go niejawnie.
- [ ] Rozwiązać symbolic stage/output dopiero po sukcesie wcześniejszego stage. Odrzucić forward reference, cykl, failed/cancelled output i niezgodny port. Pipeline rozwiązuje wynik każdego portu pod oddzielnym ID.
- [ ] Przy remesh zachować current/field asset, jeśli jego fizyczne zależności się nie zmieniły, a unieważnić tylko projection. Dopóki nie ma nowej projekcji, LLG pozostaje zablokowane.
- [ ] Testować macierz invalidation poniżej z niezmienionym digestem starego pliku. Uszkodzenie bajtów ma dawać inną kategorię błędu niż stale.

```text
mutation                     current     field       projection
waveform or peak_current     reuse       reuse       reuse
equilibrium m0               reuse       reuse       reuse; invalidate transverse analysis
conductor geometry           stale       stale       stale
terminal current weights     stale       stale       stale
conductivity distribution    stale       stale       stale
quadrature policy            reuse       stale       stale
field sampling coordinates   reuse       stale       stale
LLG target remesh            reuse       reuse       stale
target selection             reuse       reuse       stale
```

**Bramka:** `just verify-antenna-contracts artifact`. Commit: `fix: validate antenna dependency signatures before LLG`.

## T09. Naprawić maski i wdrożyć uczciwe próbkowanie/projekcję

**Pliki:** planner `antenna_projection.rs`, runner `antenna_field_solution.rs`, native nowe `transfer/antenna_field_projection.*`, istniejący direct tetra operator, ABI i sys wrappers.

- [x] Najpierw lokalnie naprawić kolejność: utworzyć wektor zerowy pełnej długości targetu; dla `mask[i]==false` pominąć lookup. Dla aktywnego węzła brak próbki nadal zwraca błąd.
- [x] Test RED/GREEN: source posiada próbkę tylko w `[0,0,0]`; target posiada `[0,0,0]` i `[1,0,0]`; maska `[true,false]` daje pierwsze pole i zero. `[true,true]` nadal odrzuca brak danych.
- [ ] Zdefiniować trzy odrębne realizacje: `identity_coordinates_v1`, `fem_p1_interpolation_v1`, `direct_rt0_evaluation_v1`. Nie nazywać lookupu `fem_element`.
- [x] W nowej wersji field carrier zachować topology/element ordering i sampling scope potrzebne do point location. Same pozycje i H nie wystarczają do klasyfikacji wnętrza.
- [ ] Dla osobnej realizacji `direct_rt0_evaluation_v1` zachować w artefakcie RT0, mesh przewodnika i closure do ponownej ewaluacji.
- [x] Dla P1 użyć barycentrycznych współrzędnych poprawnego elementu; boundary tolerance skalować geometrią. Zdefiniować deterministic ownership dla punktów na współdzielonej ścianie. Nie używać nearest node jako interpolacji FEM.
- [ ] Zwracać rozróżnione stany `inside`, `outside_domain`, `missing_payload`, `unsupported_topology`. Tylko `outside_domain` może być objęte outside-zero. Uszkodzone dane nie mogą dać zera.
- [ ] Obliczenia numeryczne umieścić w native MFEM transfer, runner przekazuje request i zapisuje wynik. Nie powielać solwera interpolacji w React, API i Rust.
- [ ] Sprawdzić constant i affine vector fields, obroty, mikrometrowe/nanometrowe skale, interface nodes, maski regions, remesh i target FDM cell centers. Zachować błąd projection jako element proweniencji.

Projekt algorytmu pierwszej naprawy, bez zmiany interpolatora:

```text
allocate target_field[target_count] = zero
for each target index i:
    if target_mask exists and target_mask[i] is false:
        continue
    locate matching source coordinate
    if no match:
        return missing_active_target_sample(i)
    target_field[i] = source_field[matching_index]
```

**Bramki:** `projection`, `artifact`, następnie `native-field`. Nowy ABI i carrier wymagają migracji wersji, nie reinterpretacji starych manifestów. Stary point-only asset może działać tylko w identity mode.

**Uzupełnienie implementacyjne 2026-09-12:** `load_solved_antenna_drive_basis_projected`
korzysta z tego samego deterministycznego `FieldTetraBvh` co sampler FFT.
Najpierw wykonywany jest szybki lookup identycznych współrzędnych, a dla nowego
węzła — point location w zweryfikowanym `tet4_connectivity` i interpolacja
barycentryczna P1. Maska targetu jest rozstrzygana przed lookupem; nieaktywne
węzły pozostają zerowe. Podpis projekcji rozróżnia wynik interpolowany przez
realizację `p1:<digest>`. Dodano test affine P1 na tet4 oraz pełny zestaw 13
testów ładowania/projekcji; regresja FFT pozostaje 18/18. Nadal otwarte są
`direct_rt0_evaluation_v1`, transfer do natywnego MFEM, formalnie typowane
stany `inside/outside/missing/unsupported` w API oraz kwalifikacja dużych i
mieszanych topologii.

## T10. Ujednolicić analizę k, fazę i równowagę

**Pliki:** `antenna_spectrum.rs`, CLI `execute_antenna_spectrum_requests` przenoszone do `antenna_workflow.rs`, Python/IR spectrum request; testy modułu i nowe `tests/antenna/verify_spectrum.py`.

- [ ] Skorzystać z rozróżnienia missing/outside T09. Regularną płaszczyznę budować w zadanym orthonormal frame; przekazywać rzeczywiste interpolation metadata.
- [ ] Przyjąć fizyczny początek współrzędnych płaszczyzny z definicji request. Dla structured FFT skorygować przesunięcie indeksów względem początku `-L/2`; uwzględnić u i v, włącznie z ujemnymi k.
- [ ] Porównywać zespolone amplitudy regular/direct dla identycznych k. Nie ograniczać testu do normy lub pozycji pików.
- [ ] Ustalić spacing `(N-1)` dla siatki z oboma końcami oraz DFT period `N*spacing`; dokumentacja osi musi wyjaśniać tę różnicę. Nie zmieniać samej osi bez przeliczenia konwencji amplitudy.
- [ ] Sprawdzić unitary i integral_si, gain/ENBW okien oraz jednostkę pola na amper. Jeśli źródło jest na amper, jego squared spectrum nie może być prezentowane jako wynik dla dowolnego prądu bez skalowania.
- [ ] Dla `component=transverse` rzeczywiście wczytać `equilibrium_ref`, sprawdzić jego digest i zgodność targetu, projektować m0 na te same punkty. Brak równowagi oznacza błąd; nie podstawiać zer ani jednolitej osi.
- [x] `mode_basis_ref` nie może być pozornie przyjętym parametrem: do czasu osobnej zweryfikowanej analizy modalnej obie wersje walidatora IR odrzucają tę opcję z jawnym statusem unsupported. Nie przekształcać W_H w sprawność transdukcji.
- [ ] Dodać cache analizy zależny od field signature, plane, window, normalization, component i equilibrium digest; zmiana m0 nie unieważnia bazy prądowej.

**Stan implementacji 2026-09-11:** carrier artefaktu publikuje opcjonalny,
zweryfikowany payload `tet4_connectivity`; sampler Rust realizuje
`fem_p1_interpolation_v1` przez barycentryczne P1 i deterministyczny BVH, a
point-only asset działa wyłącznie jako jawne `identity_coordinates_v1`. Testy
obejmują affine vector field, integralność hasha topologii i `outside=zero`.
**Uzupełnienie 2026-09-12:** klasyfikacja i interpolacja tet4 oblicza wyznacznik
po unormowaniu krawędzi lokalnym rozmiarem elementu, więc decyzja o degeneracji
jest bezwymiarowa i nie zawiera już bezwzględnej podłogi `1 m`. Test
publicznego samplera potwierdza to samo obrócone pole afiniczne dla skali
`1 m`, `1 µm` i `1 nm`, a osobny test odrzuca zdegenerowany element
nanometrowy. Zamknięta jest część T09 dotycząca skali P1; nadal otwarte są
`direct_rt0_evaluation_v1`, transfer do native MFEM, kwalifikacja mixed
topology oraz kwalifikacja dużych siatek.
Punkt na współdzielonej ścianie ma teraz jawnego właściciela: najniższy ordinal
elementu w zapisanym `tet4_connectivity`, a test wymusza niezależność tej
decyzji od kolejności przejścia BVH.
Nowy plan anteny wymaga niepustej, wyłącznie tet4 topologii nośnika pola, a
runtime powtarza tę kontrolę przed pierwszym wywołaniem native solvera. Mieszana
lub nieobsługiwana topologia nie może już zostać zredukowana do
`identity_coordinates_v1`; stary asset bez topologii zachowuje wyłącznie
jawną ścieżkę kompatybilności point-only. Testy planera i runtime obejmują oba
przypadki. Nadal otwarte pozostają bezpośrednia ewaluacja RT0, transfer MFEM,
pełne rozróżnienie stanów HTTP w generated OpenAPI i kwalifikacja topologii
mieszanej jako osobnej capability.
Opcja `mode_basis_ref` jest teraz fail-closed w obu walidatorach IR; nie można
jej podać do ścieżki source-spectrum, która nie wykonuje analizy modalnej.
Analogicznie `component="transverse"` z dowolnym `equilibrium_ref` jest
odrzucany już na granicy IR, ponieważ runner nie ma jeszcze zweryfikowanego
ładowania i projekcji równowagi na tę samą siatkę próbkowania.
API widma rozróżnia teraz `missing_payload` (HTTP 404) od
`unsupported_topology` (HTTP 422), a metadata endpoint sprawdza obecność
wszystkich czterech binarnych payloadów przed publikacją zasobu.
Inspector opisuje widmo jako bazę pola portu znormalizowaną do `1 A`, bez
przyłożonego waveformu lub deklarowanego prądu drive, oraz wyświetla jednostkę
mocy bezpośrednio z `payloads.power.unit`. Test UI chroni zarówno tę semantykę,
jak i dokładną postać jednostki `(A/m/A)^2`.
Pozostają: bezpośrednia ewaluacja `direct_rt0_evaluation_v1`, natywny transfer
MFEM, rzeczywiste wczytanie `equilibrium_ref` dla `component=transverse`,
odświeżenie śledzonych plików generated OpenAPI po zmianie odpowiedzi oraz
kwalifikacja mieszanych topologii i dużych siatek. Sam fail-closed dla
nieobsługiwanej topologii jest zamknięty; nie oznacza to jeszcze implementacji
interpolacji mixed/native MFEM.

**Uzupełnienie 2026-09-12 (preflight T10):** oba publiczne transformatory
`compute_structured_antenna_source_spectrum` i
`compute_nonuniform_k_antenna_source_spectrum` korzystają ze wspólnej walidacji
siatki. Sprawdzane są liczności osi przed odejmowaniem `N-1`, checked product,
zgodność długości próbek, skończony i ortonormalny frame, dodatnie extenty oraz
finite dodatnie spacing. Ścieżka direct dodatkowo odrzuca pusty/niefinite
`k`-grid i checked output/operation count. Invalid request nie może wejść do
FFT/DFT ani wywołać panic przez underflow `usize`.
Manifest widma zapisuje teraz również authored `transform`, `window` i
wersjonowaną `fourier_realization`; dwa wyniki o tym samym kształcie tablic nie
mogą już wyglądać jak ten sam operator tylko dlatego, że mają identyczny
digest danych liczbowych.

**Bramka numeryczna 2026-09-12:** zestaw testów source-spectrum ma teraz 18/18
przypadków. Oprócz zgodności zespolonej structured FFT/direct DFT obejmuje
dwuwymiarowy Hann (`coherent_gain=9/64`, `ENBW=4`), Parsevala dla
`unitary_discrete` oraz relację skali `integral_si` do transformacji unitarnej
przy tym samym polu i siatce. To jest dowód konwencji i normalizacji, nie
kwalifikacja natywnego FEM ani cache analizy.

Niezależny test analityczny konwencji fazy, wykonywalny już teraz:

```python
# %% Oracle fazy; nie uruchamia Fullmag ani solvera
import cmath
import math

count = 4
spacing_m = 1.0
extent_m = (count - 1) * spacing_m
k_rad_per_m = 2.0 * math.pi / (count * spacing_m)
index_fft = 1.0 + 0.0j
physical_dft = cmath.exp(1j * k_rad_per_m * extent_m / 2.0)
corrected_fft = index_fft * cmath.exp(1j * k_rad_per_m * extent_m / 2.0)
assert abs(corrected_fft - physical_dft) < 1e-14
assert abs(index_fft - physical_dft) > 1.0
assert abs(abs(index_fft) ** 2 - abs(physical_dft) ** 2) < 1e-14
```

Test jednostkowy produkcyjnego Rust ma korzystać z tych samych wartości i okna rectangular, wywołując obie rzeczywiste funkcje transformacji. **Bramka:** `just verify-antenna-contracts spectrum`. Commit: `fix: preserve physical phase and sampling in antenna spectra`.

## T11. Wprowadzić preflight ważności modelu i kosztu

**Stan 2026-09-12:** współdzielona polityka `antenna_direct_oersted_budget.v1`
(`1_000_000` par źródło–target) jest zapisana w kanonicznym IR. Preflight
planera odrzuca przekroczenie po zbudowaniu rzeczywistego meshu przewodnika i
nośnika próbkowania, przed wywołaniem native solvera; wrapper RT0 powtarza tę
kontrolę jako zabezpieczenie runtime. Obie pętle wykonawcze charge/steady
transport sumują koszt wszystkich jednocześnie przygotowanych źródeł Oersteda
przed pierwszą ewaluacją, a kontrola pojedynczego wywołania pozostaje drugą
granicą obrony. Sprawdzone są konwersje `usize → u64`, checked multiplication,
granica dokładna, overflow oraz diagnostyka z liczbą elementów, targetów,
ewaluacji i identyfikatorem polityki. Testy planera przechodzą w `fullmag-plan`
(3/3), zestaw referencyjny anteny w `fullmag-runner` (33/33), a kod feature
`fem-gpu` przechodzi hostowy `cargo check`; nie jest to kwalifikacja natywnego
FEM. Kontenerowa recepta Windows nie wystartowała, ponieważ ogólny
`compose.yaml` używa hostowego `FULLMAG_FRONTEND_ROOT` równocześnie jako
linuksowego targetu bind mountu i Docker Desktop odrzuca go jako ścieżkę z
nadmiarowymi dwukropkami. Próba ponowiona 2026-09-12 po starcie Dockera i
udostępnieniu zatwierdzonego rootu storage zakończyła się tym samym błędem
`mount denied ... too many colons`; poprawka rozdzielająca windowsowe źródło
bindu od linuksowego celu kontenera oraz shell-local wrapper z
`MSYS_NO_PATHCONV=1` usunęły tę blokadę. Ponowiony 2026-09-12 test przez
`just verify-fem-solved-antenna-drive-contract` zbudował kontenerowy stos
MFEM/CUDA i przeszedł kontrakt `fem_zeeman_contract`, test layoutu FFI oraz
`native_pack_materializes_solved_antenna_as_preprojected_per_ampere_basis`.
Nie zamyka to pełnej bramki T11: brakuje agregacji między osobnymi blokami/retries i callbackami etapów,
budżetu pamięci i anulowania, diagnostyki pasma `eta_wave`/`eta_skin`, pomiaru
wall-time/peak-memory oraz kontenerowego benchmarku direct RT0.

**Pliki:** nowe planner `antenna_preflight.rs` i runner `antenna_validity.rs`, istniejący IR/plan, `native_fem/steady_transport.rs`, direct tetra options, manifest/DTO; nowy `tests/antenna/verify_budget.py`.

- [ ] Wyliczać przed solve liczbę elementów źródła, targetów, par i rozmiar buforów. Użyć checked multiplication; overflow jest błędem, nie ogromnym zaakceptowanym zadaniem.
- [ ] Zastąpić stałą miliona par jawnie wersjonowaną polityką wykonania. Zachować limit domyślny dopóki benchmark nie uzasadni innego; błąd preflight pokazuje oba rozmiary i koszt.
- [ ] Blokować targety dla ograniczenia pamięci i granic anulowania. Licznik globalny obejmuje wszystkie bloki, porty i retries; nie resetować budżetu dla każdego bloku, aby obchodzić limit.
- [ ] Nie zmniejszać automatycznie gęstości próbkowania. Użytkownik może jawnie zmienić target/rozdzielczość lub zatwierdzić większy budżet obliczeń w konfiguracji badania; proweniencja zapisuje decyzję.
- [x] Dodać diagnostykę `eta_wave`/`eta_skin` z 0950 dla stałej, sinusoidy i sinc/cutoff, z jawnym źródłem `f_max`; dla nieznanego pasma zwracać `validity_bandwidth_unknown`.
- [x] Dodać osobny, jawny kontrakt deklarowanego pasma dla sampled waveform; nie uznawać samego czasu próbkowania za fizyczny `f_max`.
- [ ] Prostokątny pulse i skok nie mają skończonego idealnego pasma. Nie wyznaczać `f_max` wyłącznie jako odwrotności długości impulsu. Wymagać opisania bandwidth/rise-time lub zwrócić brak oceny.
- [x] Ostrzeżenia przeliczać przy zmianie waveform, ale nie stawiać przez to bazy jako stale. Planner publikuje osobną notę dla każdego `SolvedAntennaDriveIR`.
- [x] Dla wielu aktywnych portów agregować wspólne ograniczenie pasma i wspólne źródło pola; obecna diagnostyka pozostaje per-drive.
- [ ] Zapisać measured wall time, peak memory, pairs, refined pairs, error i cancellation latency. Dopiero jeśli direct solver nie spełnia potrzeb, zaprojektować oddzielnie kwalifikowany fast operator; samo zwiększenie limitu nie jest optymalizacją.

Uzupełnienie implementacyjne 2026-09-12: `fullmag-ir` publikuje wersjonowany
`antenna_waveform_bandwidth.v1`. Klasyfikator zwraca `f_max_hz=0` dla stałego
napędu, częstotliwość autorską dla sinusoidy i `cutoff_hz` dla sinc; pulse oraz
piecewise-linear pozostają `validity_bandwidth_unknown`, bez heurystyki
`1/duration`. Planer dopisuje tę klasyfikację do provenance dla każdego
`SolvedAntennaDriveIR`, więc zmiana waveformu odświeża diagnostykę bez
unieważniania statycznej bazy pola. Obliczanie `eta_wave`/`eta_skin` z geometrii
i materiału, agregacja budżetów między blokami oraz pomiar wall-time/peak-memory
pozostają otwarte.

Uzupełnienie implementacyjne 2026-09-21: planner publikuje również wersjonowaną
notę `antenna_validity.v1`. Dla znanego pasma rozwiązuje geometrię przez
`antenna_target_projection → antenna_field_solve_stage → geometry.source_object_id`
i odczytuje `length_m`, `thickness_m` oraz `conductivity_s_per_m` wyłącznie z
`MicrostripAntenna` lub `CpwAntenna`. Obliczane są wielkości
$\eta_{wave}=L_{max}f_{max}/c$ oraz
$\eta_{skin}=t_{max}/\delta$, gdzie
$\delta=\sqrt{2/(2\pi f_{max}\mu_0\sigma)}$; próg ostrzeżenia wynosi
`0.1`, zgodnie z 0950. Brak skończonego pasma, brak geometrii lub niepoprawne
parametry pozostają jawnie `status=unknown`; nie jest używana heurystyka
`1/duration`. Jest to preflight diagnostyczny, a nie dowód poprawności
solvera ani kwalifikacja GPU. Szczegóły i ślad weryfikacyjny zapisano w
`docs/validation/antenna/validity-diagnostics-2026-09-21.md`.
Noty są dołączane także do `AntennaFieldSolvePlanIR`, więc samodzielne
obliczenie bazy anteny zachowuje te same parametry proweniencji co późniejszy
Relax/Run.

Uzupełnienie implementacyjne 2026-09-21 (deklarowane pasmo): IR publikuje
`AntennaWaveformBandwidthDeclarationIR` jako opcjonalne pole
`SolvedAntennaDriveIR.bandwidth_declaration`, a Python DSL udostępnia
`AntennaWaveformBandwidthDeclaration(f_max_hz=...)`. Dla `Pulse` i
`PiecewiseLinear` klasyfikator pozostaje `validity_bandwidth_unknown`, dopóki
autor nie poda skończonego, nieujemnego `f_max_hz`; sama długość impulsu,
odstęp węzłów, czas próbkowania ani częstotliwość Nyquista nie są używane jako
fizyczne pasmo. Zgodna nota provenance ma
`source=declared` oraz
`declaration_schema=antenna_waveform_bandwidth_declaration.v1`. Deklaracja jest
opcjonalna, kompatybilna ze starym JSON przez `serde(default)`, i nie zmienia
niezmiennej sygnatury statycznej bazy pola. Ekspozycja tego pola w zasobie
OpenAPI/Inspectorze pozostaje elementem T14.

Uzupełnienie implementacyjne 2026-09-21 (agregat wielu portów): planner
publikuje dodatkową notę `antenna_waveform_bandwidth_aggregate.v1` dla
wspólnego źródła `H_ant_basis`. Dla drive’ów potencjalnie aktywnych w danym
`StudyIR` agreguje konserwatywnie `max(f_max_hz)` i zapisuje listę drive’ów oraz
portów. `AllTimeEvolution` jest filtrowane przez rodzaj study, natomiast
`StageIds` pozostaje potencjalnie aktywne, bo pojedynczy `ProblemIR` nie zna
jeszcze konkretnego stage boundary. Jeśli choć jeden taki drive ma nieznane
pasmo, agregat ma `status=unknown` i wymienia jego ID; nie jest tworzona
fałszywa liczba z czasu próbkowania. Nota trafia zarówno do zwykłego planu
wykonania, jak i do samodzielnego `AntennaFieldSolvePlanIR`.

Kontrakt arytmetyczny testu:

```rust
#[test]
fn pair_budget_is_global_and_checked() {
    assert_eq!(1_000_u64.checked_mul(10_000), Some(10_000_000));
    assert!(10_000_000_u64 > 1_000_000);
    assert_eq!(u64::MAX.checked_mul(2), None);
}
```

Powyższy oracle uzupełnić testem rzeczywistego plannera: input 1000×10000 przy limicie 1e6 jest odrzucony **przed** wywołaniem current solve. **Bramka:** `budget`; benchmark obejmuje mały fixture oraz co najmniej jeden realistyczny target, z danymi zamiast deklaracji „szybko”.

## T12. Związać lifecycle, cache i anulowanie z wykonaniem

### Checkpoint 2026-10-05 — korekta globalnego carrieru importu FEM

Przegląd commita `c9c1d0334169529b9d374fe5c637fd7bc51717a1` wykazał,
że legalny lokalny `SampledField` magnesu nie musi mieć liczności globalnego
stanu runtime. `crates/fullmag-plan/src/fem.rs::assign_domain_initial_for_segments`
dopuszcza oba warianty authoringu; import płaskiego stanu musi być ostrzejszy.
`crates/fullmag-cli/src/step_utils.rs::validate_imported_magnetization`
sprawdza teraz dodatkowo wynikowy plan: FDM wymaga liczności
`initial_magnetization`, multilayer sumy natywnych wektorów wszystkich warstw
(nie union-grid), a FEM, FemEigen i FemFrequencyResponse całego `mesh.nodes`.
Niezgodność kończy preflight przed publikacją, bez niejawnego resamplingu.

Druga korekta w `crates/fullmag-cli/src/step_utils.rs::apply_continuation_initial_state`:
istnienie shared-domain assetu uruchamia odczyt liczności rozwiązanej siatki
także przy `mesh=None, mesh_source=Some(...)`. Poprzedni warunek zależny od
inline mesh odrzucał legalny globalny import wielu magnesów z pliku.
Kanoniczny loader nadal odpowiada za format i walidację siatki.

Regresje Rust zapisano jako
`step_utils::imported_fem_state_requires_global_nodes_not_local_initializer`
(4 lokalne wektory legalne dla authoringu, 5 globalnych wymagane przy imporcie)
oraz `step_utils::imported_fem_state_supports_multi_magnet_source_only_mesh`
(5 węzłów pliku, 8 rozwiązanych węzłów po pakowaniu interfejsu per obiekt;
import 8 akceptowany, 5 i 7 odrzucane według zapisanych oczekiwań).
Obie sprawdzają niezmienność bazowego IR. Wersjonowana siatka
`crates/fullmag-cli/tests/fixtures/import_shared_domain.mesh.json` eliminuje
potrzebę tworzenia tymczasowych plików testowych. Te testy **nie zostały
skompilowane ani wykonane**; pozostają do uruchomienia po odwołaniu zakazu.

Dowody ograniczone do źródeł: RED trzech nowych oczekiwań (2 failures,
1 error) → **26 PASS** w `scripts/test_antenna_observation_source.py`.
`just check-cli-source`: końcowy receipt `5a083d2acd1d481da2ae604000c304a8`,
**passed**, exit 0, HEAD `c9c1d0334169529b9d374fe5c637fd7bc51717a1` z WIP,
digest przed/po `05e2b4affddd5a69dde1eef1515de53885840cecdee9224efd431f400f496a15`,
`source_changed_during_run=false`. To check produkcyjnych typów CLI,
nie kompilacja testów ani wykonanie FEM/GPU. Wynik nie kwalifikuje fizyki,
import events, atomowości uploadu, spatial identity ani pełnego T00–T18.

### Checkpoint 2026-10-05 — prywatna walidacja importu przed publikacją

`crates/fullmag-cli/src/step_utils.rs::validate_imported_magnetization`
klonuje bazowe IR, stosuje istniejące `apply_continuation_initial_state`
i uruchamia kanoniczny planner na prywatnym kandydacie. Pierwsza wersja
odrzucała błędy planowania, lecz nie odróżniała lokalnego initializeru FEM
od globalnego carrieru; korektę i jej zakres opisano w checkpointcie powyżej.
Helper nie tworzy runtime, nie ładuje bazy anteny, nie uruchamia solve/LLG
i nie przepisuje zegara segmentu ani waveformu. Nie zmienia równań, jednostek,
publicznego Python ani `ProblemIR`.

`crates/fullmag-cli/src/orchestrator.rs::run_script_mode` wiąże walidację
z odczytem importu przed pierwszym Solve: failure używa istniejącej gałęzi
odmowy, bez zmiany magnetyzacji, cache i metadanych continuation.
`crates/fullmag-cli/src/interactive_runtime_host.rs::load_state` wywołuje
walidację także wtedy, gdy host nie zachowuje idle runtime; sprawdzenie
poprzedza przygotowanie/upload, generation i publikację live state.

Dowód produkcyjnych typów: `just check-cli-source`, receipt
`2883cad87f2241f0afa8091c1d1fb24f`, **passed**, exit 0,
HEAD `f5c23bbc9e9d043ee0ee63d34752387d76044ddc` z WIP, digest przed/po
`96c6be6b7910be390e7cd82a48d563dc4519024d9ab3711a5126909a1dc65075`,
`source_changed_during_run=false`. Receipt/log zachowano pod resolverowym
`storage/builds/<worktree-id>/windows-api-source-check/cli-source-check/`.
Kontrole routingu bieżącego WIP: RED trzech nowych oczekiwań → **23 PASS**;
nie jest to wykonanie eventów importu ani solvera.

`crates/fullmag-cli/src/step_utils.rs::imported_magnetization_validation_rejects_wrong_size_without_mutating_problem`
zawiera scenariusze pustego, krótkiego, długiego i poprawnego FDM carrieru
oraz porównanie pełnego IR przed/po. Test Rust **nie został skompilowany ani
wykonany**, zgodnie z zakazem kompilowania unit testów.

Granice: płaski stan bez metadanych siatki nie dowodzi zgodności przestrzennej
dwóch carrierów o tej samej liczności i nie upoważnia do niejawnego resamplingu.
To preflight wejścia, nie dowód atomowego uploadu GPU, rollbacku po błędzie
urządzenia ani pełnego recovery. Nie zmienia kwalifikacji żadnej z czterech
realizacji FDM/FEM CPU/GPU. Następne bramki: rzeczywisty import/static/sinusoidal
consumer, RF resume, natywny przewodnik 3D, cztery lane i T18/PR.

**Pliki:** `antenna_stage.rs`, native charge/field wrappers, CLI `orchestrator.rs` i nowy `antenna_workflow.rs`, standardowy stage execution read-model i artefakty.

- [ ] Przenieść antenową orkiestrację z monolitu do `antenna_workflow.rs`; publiczne wywołanie przyjmuje plan, artifact store i callback postępu/anulowania. Nie przenosić przy tym innych workflows.
- [x] Sprawdzić cache przed emisją meshing/solving. Cache hit publikuje `ready` z `reused_existing=true` bez fikcyjnego solve; zgodny model cache publikuje `Ready`, brak pliku `Missing`, a niezgodny podpis `Stale`.
- [ ] Emitować meshing, solving_current, evaluating_field, projecting_targets dopiero na rzeczywistych granicach wykonania. Jeśli mesh jest wcześniej gotowy, oznaczyć etap jako reuse/skip z przyczyną.
- [ ] Przekazać cancellation token do długich operacji i sprawdzać go między blokami pola T11. Anulowanie nie może opublikować gotowego manifestu.
- [ ] Payloady zapisywać do task-private temporary directory, weryfikować hashe, publikować manifest jako ostatni atomowy krok. Concurrent request tej samej signature deduplikuje lub weryfikuje identyczność wyniku; nie nadpisuje istniejącego assetu.
- [ ] Na failure/cancel zapisać stage stop reason i diagnostykę, zachować poprzedni poprawny immutable wynik. Cleanup usuwa wyłącznie własne niedokończone pliki, nigdy wspólny cache ani explicit output directory.
- [ ] Wykonać resolver stage/output T08; następny stage dostaje resolved reference dopiero po poprawnej publikacji.
- [ ] Zarejestrować outputy w standardowym stage/artifact catalog. Nie ukrywać jedynego wyniku w `.fullmag` historii; zwykły script launch używa publicznego sibling `.zarr` zgodnie z launcherem repo.

Sekwencje testowe:

```text
cache miss: queued -> meshing/reused_mesh -> solving_current -> evaluating_field -> projecting_targets -> ready
cache hit:  queued -> projecting_targets(reused_existing=true) -> ready
cancel:     evaluating_field -> cancelled; no ready manifest
failure:    solving_current -> failed(reason); no downstream drive
stale:      ready -> stale(reason); old immutable artifact remains readable by its old run
restart:    reload ready manifest -> verify bytes and dependencies -> resolve consumer
```

**Stan implementacji 2026-09-12:** ścieżka `execute_antenna_spectrum_requests`
publikuje każdy wynik source-spectrum w prywatnym katalogu stagingowym i
promuje kompletny katalog jednym rename. `output_id` jest ograniczony do
jednego bezpiecznego komponentu ścieżki, a manifest `spectrum.v2.json` jest
zapisywany jako ostatni plik w stagingu; niekompletny lub uszkodzony zapis nie
może pojawić się jako gotowy output. Ponowne żądanie tego samego `output_id`
porównuje dokładny zbiór plików oraz wszystkie oczekiwane payloady
bajt-po-bajcie i reużywa identyczny wynik, natomiast dodatkowy/brakujący plik,
konflikt treści albo niebezpieczny identyfikator kończy się błędem bez
nadpisania poprzedniego assetu. Dodany test CLI obejmuje pierwszą publikację,
reuse, konflikt, obcy plik i próbę wyjścia poza katalog. Nadal pozostaje test
fault-injection dla anulowania/przerwania całego batcha wielu requestów oraz
pełne spięcie z resolverem stage/output.

Uzupełnienie implementacyjne 2026-09-12: `execute_synthetic_stage` sprawdza
zweryfikowaną, niezmienną bazę przed emisją stanów `Meshing`, `SolvingCurrent`
i `EvaluatingField`. Przy trafieniu zapisuje przejścia
`Queued → ProjectingTargets` z diagnostyką `reused verified immutable field
solution` oraz `→ Ready`, a rekord etapu zawiera `reused_existing=true` i
referencję opublikowanego assetu. Przy braku trafienia zachowana jest pełna
sekwencja rzeczywistego solve'u. Regresja lifecycle wymusza oba warianty;
anulowanie między blokami, deduplikacja równoległych solve'ów i pełny resolver
stage/output pozostają otwarte.

Uzupełnienie implementacyjne 2026-09-21: loader runnera publikuje jawny stan
`AntennaFieldSolutionCacheState::{Missing, Stale, Ready}`. Zgodny manifest nadal
omija etapy solve, lecz obecny manifest z innym `asset_id` lub podpisem nie jest
już traktowany jak zwykły cache miss: lifecycle zapisuje
`Missing → Stale → Queued` z oczekiwanym i znalezionym ID oraz ścieżką manifestu,
po czym wykonuje nowy solve do nowej rewizji content-addressed. Korupcja,
niepełny manifest lub zmiana bajtów podczas odczytu nadal kończy się błędem, a
stary immutable asset nie jest usuwany ani nadpisywany. Szczegóły zapisano w
`docs/validation/antenna/cache-lifecycle-2026-09-21.md`.

Uzupełnienie implementacyjne 2026-09-21 (wyścig publikacji): po przegranym
`rename` do revisioned assetu publisher sprawdza, czy inny worker opublikował
już kompletny manifest. Identyczne bajty są zwracane jako
`reused_existing=true`, a różna treść daje jawny konflikt immutable rewizji;
żadna ścieżka nie nadpisuje ani nie scala istniejącego katalogu. Nadal brakuje
kontrolowanego fault-injection przerwania zapisu payloadu/manifestu. Dodana
regresja `concurrent_identical_publication_deduplicates_after_rename_race`
wymusza dwóch rzeczywistych workerów barierą tuż przed `rename()` i sprawdza,
że dokładnie jeden publikuje, a drugi reużywa zweryfikowany asset. To nie
zamyka jeszcze cancellation tokena native solve ani fault injection całego
batcha.

Uzupełnienie implementacyjne 2026-09-21 (granice anulowania native solve):
`fullmag_runner::execute_antenna_field_solve_plan_interruptible` przyjmuje
`AtomicBool` i sprawdza go przed/po preflight, charge transport, RT0/Oersted
oraz przed materializacją artefaktu. Pojedyncze wywołanie FFI pozostaje
niepreemptive, ale zaakceptowane anulowanie na granicy zwraca błąd przed
przekazaniem wyniku do publishera. Przekazanie sygnału przez
`orchestrator.rs`, zapis `StageStopReason::UserCancelled` i stan
`cancelled/awaiting_command` są teraz spięte dla synthetic antenna stage;
publisher sprawdza ten sam sygnał bezpośrednio przed `rename()` i usuwa
wyłącznie własny staging przy odrzuceniu. Pozostaje runtime/fault-injection
dowodzący całego batcha oraz niepreemptive granica samego `rename()`.

Uzupełnienie implementacyjne 2026-09-21 (stage/output catalog): antenowy
`synthetic` field solve zapisuje atomowo `stage_output_catalog.v1.json` po
zweryfikowanej publikacji. Katalog ma jedną wersjonowaną referencję
`stage_id → output_id → asset_id/content_digest`, względny `manifest_ref`,
quantities i informację o reuse; read-model dostaje ścieżkę katalogu jako
`artifact_ref`. Anulowanie zapisuje terminalny `cancelled` z pustym
`outputs`, a identyczny katalog jest idempotentny — odmienna treść nie może
go nadpisać. Zakres jest celowo ograniczony do antenowego synthetic stage;
pełny resolver symbolicznego stage/output i wspólny katalog wszystkich stage
pozostają otwarte. Wewnętrzny hook fault-injection po zapisie pliku
tymczasowego pozwala regresji sprawdzić cleanup przed rename.

**Bramka:** `lifecycle` i `artifact`; testy fault injection obejmują przerwanie przed/po zapisie payloadu i przed publikacją manifestu. Commit: `fix: bind antenna stage lifecycle to actual execution`.

## T13. Domknąć i zakwalifikować FEM LLG

**Pliki:** runner `native_fem.rs`, `antenna_fields.rs`, `fem_reference.rs`, native `zeeman_regional_field.*`, `crates/fullmag-engine/src/fem.rs`, scenariusze `tests/antenna/scenarios/`.

- [ ] Zachować basis H/A × peak_current A → H A/m, bez drugiej konwersji mu0. Energia używa tego samego wektora i właściwych nodal weights.
- [ ] Przebieg musi być oceniany w czasie każdego rzeczywistego RK substage, także prób odrzuconych/adaptive retry. `stage_local` odejmuje fizyczny start etapu; `absolute` nie odejmuje go.
- [ ] Dla preprojected field połączyć obsługę z master mixed-mesh checks. Sprawdzić periodic constraints i czy wspólne węzły mają właściwe wartości pola.
- [ ] Chronić frozen spins i maskę magnetyczną: pole może istnieć w przestrzeni, ale RHS constraints pozostają własnością solvera. Nie zmieniać aktywności komórek przez wybór warstwy UI.
- [ ] Przygotować minimalny macrospin reference bez demag/exchange do kontroli częstotliwości precesji i fazy, następnie mały magnet z pełnymi składnikami do kontroli energii/torque.
- [ ] Wykonać oba porządki pipeline: `relax → solve → run` oraz `solve → relax → run`. Wynik Relax musi być identyczny dla domyślnie nieaktywnego RF; różnice Run muszą zgadzać się z tym samym artefaktem i waveform.
- [ ] Testować constant, sinusoidal z niezerową phase/offset, pulse, piecewise-linear i sinc. Dla każdej wspieranej explicit RK wymagać krótkiej trajektorii, nie tylko Heun.
- [ ] Zapis `H_ant`, energy, torque i magnetization ma pochodzić z faktycznie wykonanej chwili, a nie pola przy `t=0` użytego w preview.

**Bramka:** `fem-llg` przez container, plus istniejące `verify-fem-solved-antenna-drive-contract` i odpowiednie RK gates. Raport musi nazwać każdy integrator, device i precision. Pierwszy publiczny wykonywalny przykład powstaje po tej bramce, nie wcześniej.

**Stan kwalifikacji 2026-09-12:** hostowy `cargo test --features fem-gpu` nadal
nie jest dowodem, bo `fullmag-fem-sys` nie ma kompilatora C/C++ na hoście.
Zarządzana recepta kontenerowa, uruchomiona z aktywnym Docker Desktop,
Pythonem 3.14 i zatwierdzonym `D:\git\fullmag\storage`, przeszła po naprawie
windowsowego bindu: CMake zbudował `fullmag_fem` i `fem_zeeman_contract`, a
kontrakt FFI oraz test materializacji preprojekcji zakończyły się `1 passed`.
To kwalifikuje natywny kontrakt solved-antenna→regional-Zeeman dla tej ścieżki;
pełny `fem-llg` pozostaje otwarty do czasu testów wszystkich integratorów,
waveformów, relaksacji i snapshotów wymienionych wyżej.

Uzupełnienie runtime 2026-09-12: testy `fullmag-runner` potwierdzają także
że rozwiązaną bazę można skalować `peak_current_a` i oceniać sinusoidę z
rzeczywistego czasu etapu integratora (`solved_antenna_basis_uses_peak_current_stage_clock_and_exact_term_time`),
oraz że `AllTimeEvolution` nie jest aktywne podczas relaksacji. Są to dowody
ścieżki FDM CPU/reference; nie zastępują pełnej bramki FEM LLG z tabeli powyżej.

**Uzupełnienie implementacyjne 2026-09-21 (FEM CPU `H_ant` preview):**
uzupełniono capability i materializację bezpośredniego pola anteny dla
`FemEngine::CpuNative`. Jeżeli rozstrzygnięty `FemPlanIR` zawiera
`antenna_zeeman_masks`, `solved_antenna_drive_bases` lub kompletny legacy
`mqs_2p5d_az` (`antenna` + `drive`), aktywny preview,
cache preview i terminalny cache wywołują
`compute_antenna_field_at_time(plan, source_time)` i budują wspólny
`LivePreviewField` z maską magnetyczną `H_ant`. Pole jest obserwablą preview,
nie dodatkowym termem RHS; czas i rewizja źródłowa są zapisane w metadanych
materializacji.

Nie dodano `H_ant` do natywnego katalogu snapshotów, ponieważ obecny ABI
`NativeFemPreviewObservable` nie ma tej obserwabli. FEM GPU pozostaje
fail-closed i nie dziedziczy capability CPU. Dzięki temu UI nie obiecuje
wyniku, którego backend nie potrafi jeszcze odtworzyć z urządzenia ani zapisać
w artefakcie. Ta zmiana domyka jedynie warstwę podglądu CPU; nie odhacza T13.

**Dowód builda 2026-09-21:** zarządzana recepta
`just windows-build backend=fem device=cpu frontend=dev` zakończyła kompilację
`fullmag-runner`, CLI, API i `fullmag-py-core` bez błędów. Końcowy receipt został
odrzucony przez guard tożsamości źródeł, bo build rozpoczął się na
niezatwierdzonych zmianach i worktree zmienił się w trakcie; traktujemy to jako
brak receiptu, nie jako błąd kompilacji. `rustfmt --check` i `git diff --check`
przeszły. Testów jednostkowych Rust nie uruchamiano zgodnie z blokadą sesji.

Pozostaje otwarta kwalifikacja snapshot/artifact `H_ant` (hostowa ścieżka CPU
jest zaimplementowana, natywny ABI/GPU nadal nie), FEM GPU, pełna trajektoria
LLG dla wszystkich integratorów i waveformów oraz osobne T16 dla projekcji FDM,
uploadu CUDA i parity CPU/GPU.

**Uzupełnienie implementacyjne 2026-09-21 (hostowy artifact `H_ant` FEM CPU):**
uzupełniono ścieżkę outputów native FEM CPU. `H_ant` pozostaje quantity
pochodną (`Derived`) i jest reklamowane tylko wtedy, gdy aktywny plan ma
`antenna_zeeman_masks`, `solved_antenna_drive_bases` lub kompletny legacy
`mqs_2p5d_az` (`antenna` + `drive`). Początkowy,
accepted-step, terminalny i końcowy zaplanowany output buduje hostowy
`FieldSnapshot` przez `compute_antenna_field_at_time(plan, stats.time)` w
pełnym porządku `plan.mesh.nodes`; do artefaktu trafiają rzeczywisty czas,
krok, `solver_dt` i rewizja. Streaming korzysta z istniejącego
`ArtifactPipeline`. Snapshoty `H_ant.x/y/z` zachowują istniejący payload
trójskładowy z wybraną składową i zerami w pozostałych osiach. Ścieżka GPU
pozostaje fail-closed z powodu braku `H_ant` w natywnym ABI obserwabli.

**Dowód builda 2026-09-21:** zarządzana recepta
`just windows-build backend=fem device=cpu frontend=dev` skompilowała
`fullmag-runner`, CLI, API i `fullmag-py-core`. Guard tożsamości odrzucił
końcowy receipt pierwszej próby dla niezatwierdzonego worktree. Po commicie
`c38e14692` powtórzony build z clean HEAD zakończył się `Build mode: fem-cpu`,
`Windows FEM cpu container build is ready` i kodem sukcesu. `git diff --check`
oraz formatowanie nowych fragmentów przeszły. Testów Rust nie kompilowano
zgodnie z blokadą sesji.

Ta poprawka nie odhacza T13: pozostaje dowód wartości artefaktów względem
niezależnego wzorca, RHS/LLG dla wszystkich integratorów i waveformów,
kwalifikacja GPU oraz osobna ścieżka T16 dla projekcji FDM i parity CPU/GPU.

**Uzupełnienie implementacyjne 2026-09-21 (native CPU carrier dla legacy źródeł):**
audyt wykazał, że `current_modules` wymuszały wybór CPU, ale nie były obecne w
`pack_native_regional_field_drives`; native RHS mógł więc pomijać pole widoczne
w preview. Adapter korzysta teraz z istniejącego `PREPROJECTED_NODAL`: legacy
`mqs_2p5d_az` jest wyliczane hostowo z `compute_per_unit_antenna_fields` i
skalowane przez `current_a`, a `antenna_zeeman_masks` przekazują już rozwiązany
`field_xyz`. Oba profile są w A/m, mają absolutny zegar legacy i przekazują
waveform do native ewaluacji na każdym podetapie RK. Dzięki temu ten sam
`h_drive_xyz` zasila native `H_eff`, energię i hostowy snapshot `H_ant`.

Nie promowano tej capability do GPU: selekcja `current_modules` nadal kończy
się na natywnym CPU, a GPU pozostaje fail-closed. Jest to zgodność runtime dla
legacy/maski; nie zastępuje docelowego pełnego 3D solve przewodnika. Zarządzany
`just windows-build backend=fem device=cpu frontend=dev` przeszedł w trybie
`fem-cpu` po zmianie. T13 nadal wymaga numerycznej bramki RHS/energy/torque,
wszystkich integratorów i waveformów oraz osobnej kwalifikacji GPU.

**Czysty receipt builda 2026-09-21:** po commitach `38febcef2`, `eb2559d2a`
i `780680003` ponowiono tę samą receptę na czystym HEAD
`780680003b6b21e706dfcbd49959009c10493664`. Zakończyła się kodem 0,
`Build mode: fem-cpu` oraz komunikatem `Windows FEM cpu container build is
ready`. Resolver wskazał state root
`D:/git/fullmag/storage/runtimes/microwave-antenna-latest-2026090-78aaec16ccf52671/fem-cpu`
i build root
`D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-fem-cpu`.
Jest to dowód kompilacji i tożsamości czystego źródła, nie dowód numerycznej
zgodności LLG; testów jednostkowych Rust nadal nie kompilowano.

**Kwalifikacja native FEM LLG CPU FP64 2026-09-21:** recepta
`just verify-fem-llg-time-domain-qualification` przeszła w obrazie
`fullmag/fem-gpu:local`, z executable ustawionym jawnie na lane `cpu`.
Build i wykonanie zakończyły się kodem 0, a końcowy walidator zgłosił
`FEM LLG time-domain CPU FP64 qualification artifact PASS`. Artefakt
`.fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json`
ma `status: pass`, `device: cpu`, `precision: fp64`, integrator `rk45` oraz
polityki kroku `adaptive` i `fixed`; source snapshot ma digest
`8bc150aef9007662d1ff29103f9896feb760ceff51b38f3b6d35bb398670fb21`.
Wynik obejmuje macrospin dla `alpha={0.1,1,10}`, kontrolę trybu wymiany,
odrzucone próby adaptive, bilans energii oraz `relax_to_run` z dokładnym
handoffem stanu, zerowym błędem replay i świeżymi polami endpointu.

Przed kwalifikacją dodano wyłącznie adaptery zgodności dla obrazu z PETSc
3.12.4/SLEPc 3.12.2: GMRES zachowuje domyślną tolerancję w starszej wersji,
a API macierzy preconditionera jest wybierane przez wersję biblioteki.
Brakujące w publicznym nagłówku PETSc
3.12 `PetscObjectGetId` ma lokalną deklarację eksportowanego symbolu.
`MatShellSetVecType` (dostępne od PETSc 3.13) dla starego obrazu kończy
GPU modalny jawnie `PETSC_ERR_SUP`; nie jest to cichy fallback do wektorów
hostowych. Obejście pozwoliło zbudować wspólny target bez zmiany kontraktu
CPU, lecz nie stanowi dowodu wykonania GPU.

**Kontrola wariantu bez SLEPc 2026-09-22:** recepta
`just verify-fem-mixed-p1-local-interactions-native-contract` została uruchomiona w tym
samym obrazie z `FULLMAG_FEM_WITH_SLEPC=OFF`. Zarządzany build ponownie
zbudował `fullmag_fem`, `fem_mixed_p1_contract` i `fem_mesh_contract`, a
kontrakty uruchomiono bez błędu widocznego w logu. Odczyt narzędzia nie
zachował kodu zakończenia recepty; pełny PASS wykonania pozostaje
niepotwierdzony. Jest to
potwierdzenie, że adapter CPU jest bezpiecznie odizolowany od konfiguracji
bez SLEPc; nie jest to kwalifikacja modalnego GPU ani antenowego RHS.

Ta bramka zamyka bazową kwalifikację czasowego LLG CPU FP64, ale nie odhacza
T13. Nadal brakuje antenowego RHS z niezależnym oraclem, wszystkich
wspieranych explicit RK i waveformów anteny, snapshotu `H_ant`/energii/
torque z rzeczywistego czasu oraz kwalifikacji FEM GPU i T16.

**Wzorzec trajektorii 2026-09-22:**
`scripts/antenna_macrospin_oracle.py::macrospin_from_field_impulse` oblicza
niezależny wzorzec macrospinu dla pola wzdłuż osi z, z tłumieniem Gilberta
i podpisaną całką pola H po czasie (A s/m). Funkcja
`waveform_integral` obsługuje constant, sinusoidal (phase/offset), pulse,
piecewise-linear z przedłużeniem wartości brzegowych oraz sinc_pulse.
Pierwsze cztery mają całki analityczne; sinc ma niezależną, ograniczoną
kwadraturę Simpsona z kontrolą zbieżności i limitem 128 okresów w przedziale.
Wzorzec korzysta wyłącznie z biblioteki standardowej Python i nie wykonuje
solverów produkcyjnych. Jego konsument musi uwzględnić amplitudę prądu,
bazę H/A i bias oraz przesunąć zegar dla `stage_local`.

Wykonano `python -B -m unittest discover -s scripts -p test_antenna_macrospin_oracle.py`:
7 testów, PASS. Sprawdzono znak precesji, skalę gamma, tłumienie, składanie
i odwracanie impulsów, stany przy biegunie, całki przebiegów, fazę/offset,
zegar nanosekundowy i odrzucanie niepoprawnych danych. Nie kompilowano testów
natywnych. Następny krok: podłączyć wzorzec do rzeczywistych trajektorii
FEM dla macierzy integratorów i przebiegów; sama kontrola wzorca nie zamyka T13.

**Porównanie próbek 2026-09-22:**
`scripts/antenna_macrospin_oracle.py::compare_collinear_trajectory` porównuje
zapisane `time_s` i `m` ze wzorcem, mnożąc bazę H/A przez prąd w A,
dodając bias w A/m i respektując zegar `stage_local` albo `absolute`.
Nie ufa błędom zapisanym przez producenta artefaktu. Odrzuca puste serie,
brak postępu czasu, powtórzone/cofające się czasy, NaN i przekroczenie
jawnej tolerancji wektora. Zakres obejmuje jednorodny macrospin z polami
Zeemana wzdłuż osi z; pochodzenie danych i backend wymagają osobnych dowodów.

9 kontroli Python przeszło, w tym celowo błędna amplituda, dodatkowe mu0,
znak precesji i zegar. Porównano także trzy końcowe próbki istniejącego
artefaktu CPU FP64/RK45 opisanego powyżej (ten sam source snapshot):
przy polu bias 800000 A/m, początkowym m=(0.6,0,0.8) i czasie 2 ps
maksymalny błąd wyniósł 8.006e-16 dla alpha=10. Nie wykonano nowego runu.
To niezależna kontrola istniejących endpointów pola stałego; nie dowodzi
antenowego wzbudzenia, poprawności wszystkich podkroków ani macierzy RK.

**Natywna macierz antenowa CPU 2026-09-22:**
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0.
Istniejący program `fem_llg_time_domain_qualification` otrzymał tryb
`antenna-cpu`: przekazuje pole preprojected przez publiczne ABI, wykonuje
rzeczywisty LLG CPU FP64 i zapisuje 21 próbek na przypadek. Sprawdzono
Heun, RK4, RK23/BS oraz RK45/DP54, każdy dla constant, sinusoidal
(1 GHz, faza 0.7, offset 0.2), pulse, piecewise-linear i sinc_pulse.
Łącznie 20 przypadków, 40000 kroków i 420 próbek; krok stały 0.5 ps,
czas 1 ns, alpha=0.1, baza osi z 1e6 H/A, prąd 0.02 A, bias 10000 A/m.
Wyłączono exchange i demag; sprawdzano jednorodność magnetyzacji węzłów.

Artefakt `.fullmag/reports/fem-antenna-trajectories/qualification.json`
zapisano jako `recorded_unvalidated`; dopiero niezależny
`scripts/validate_fem_antenna_trajectories.py::validate` potwierdził PASS.
Source snapshot: `06056fe3da8e43902d22de1795f3c7ce6065b1a96fcb111985602d34615488ba`.
Porównanie tożsamości źródeł przed i po wykonaniu przeszło.
Maksymalny błąd wektora: 2.733153319e-6 dla przebiegów ciągłych (próg 5e-6),
9.492702013e-4 dla prostokąta (budżet 4.378217822e-3, dwa przyrosty fazy
od zboczy proporcjonalne do dt). Nie jest to dowód zbieżności obsługi zdarzeń.
Po wykonaniu zaostrzono walidator o dokładne parametry wszystkich przebiegów
i ponownie sprawdzono ten sam artefakt. Odrzucono siedem mutacji: brak
przypadku, duplikat, inną fazę, inne urządzenie, błędny wektor, inny prąd
i cofnięty czas. Ten późniejszy walidator nie należy do powyższego snapshotu.

Zakres dowodu: natywne pobranie pola antenowego przez ABI i stałokrokowa
trajektoria CPU. Prąd jest mnożony przez bazę w fixture przed ABI, więc nie
kwalifikuje to mnożenia w runnerze ani solve/projection. Zegar ma początek 0.
Pozostają retry/adaptive, niezerowy początek etapu, frozen spins/maski,
pełne składniki energii i torque, snapshot H_ant, pipeline relaksacji,
mixed mesh/PBC, zbieżność czasowa oraz GPU. T13 pozostaje otwarte.

**Zegary i przejście etapu CPU 2026-09-22:** ta sama recepta została
rozszerzona i ponownie zakończyła się kodem 0. Artefakt ma teraz schemat
`fem_antenna_trajectory.v2` oraz 60 przypadków/1260 próbek: poprzednie
20 kombinacji dla trzech wariantów zegara. Dwa nowe warianty wykonują
500 rzeczywistych kroków bias-only (0.25 ns), wywołują publiczne
`fullmag_fem_backend_begin_stage` i
`fullmag_fem_backend_reconfigure_regional_field_drives`, a następnie
kontynuują na tym samym backendzie z `absolute` albo `stage_local`.
Stan początkowy drugiego etapu jest sprawdzany względem rozwiązania
bias-only, a jego trajektoria względem całki odpowiedniego przebiegu.

Snapshot: `6584d4ec648835d8baec7a63c9c0eb4521c78150ec56f7bb369525087f04693b`;
kontrola źródeł przed/po wykonaniu przeszła. Maksymalne błędy wektora
dla nowych zegarów wyniosły 2.708e-6 (przebiegi ciągłe), 9.493e-4
(prostokąt absolute) i 6.035e-4 (prostokąt stage_local), w niezmienionych
budżetach. Celowa podmiana trajektorii sinusoidy lokalnej na absolutną
została odrzucona: błąd 0.01242 przy pierwszej próbce po granicy etapu.
Nie kompilowano unit testów Rust; wykonano naukowy program kwalifikacyjny.
Ten wynik kwalifikuje zegary i przełączenie napędu na natywnym CPU przy
stałym kroku, także dla integratorów używających FSAL. Nie zamyka jeszcze
prób adaptive/retry, pipeline z rzeczywistą relaksacją/solve, GPU ani
pozostałych warunków T13. Poprzedni raport v1 został zastąpiony raportem v2
w tym samym lokalnym katalogu; opis v1 powyżej jest zapisem historycznym.

**Adaptacyjne próby antenowe CPU 2026-09-22:** rozszerzona recepta
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0 dla
90 przypadków/1890 próbek. Schemat `fem_antenna_trajectory.v3` zachowuje
60 przypadków stałokrokowych i dodaje 30 adaptacyjnych: RK23/BS i RK45/DP54,
pięć przebiegów, trzy warianty zegara. Heun i RK4 nie mają pary osadzonej
i nie otrzymały sztucznej etykiety adaptive.

Konfiguracja adaptive: atol=2e-10, rtol=0, dt_min=1e-20 s,
dt_max=5e-11 s, safety=0.9, growth_limit=2, shrink_limit=0.2,
max_reject=80. Po początku etapu żądany pierwszy krok wynosi 50 ps.
Następne żądania korzystają z natywnego dt_suggested; każdy krok jest
ograniczony najbliższą chwilą zapisu. Porównanie obejmuje rzeczywiście
zaakceptowane próbki co 50 ps, z kontrolą postępu i limitu liczby kroków.

Source snapshot: `3a3db3c51f82dc114e040c7b9ee31911bfc47b596415cceab7126fd64928f3ce`;
tożsamość źródeł przed/po wykonaniu zgodna. RK23: 44712 zaakceptowanych
kroków, 126 odrzuconych prób, maksymalny błąd 6.219e-10. RK45: 2625
zaakceptowanych kroków, 108 odrzuconych prób, maksymalny błąd 1.491e-8.
Liczniki dotyczą części z aktywną anteną, bez bias-only warmup. Każdy
przypadek adaptive zawierał co najmniej jedną odrzuconą próbę. Dla wszystkich
przebiegów adaptive, również pulse, zastosowano próg wektora 5e-6.
Walidator wymaga dowodu retry dla obu integratorów; raport z wyzerowanymi
licznikami odrzuceń został odrzucony. Bieżący lokalny raport v3 zastępuje v2.

Jest to dowód trajektorii z retry i obu zegarów przez natywne CPU ABI dla
opisanych warunków. Nie jest to pełny test zbieżności, izolowany dowód
niezmienności każdego bufora po odrzuceniu ani kwalifikacja runnerowego
solve/relax/run, GPU, energii/torque i snapshotów H_ant. T13 pozostaje otwarte.

**Pola, energia i torque w zaakceptowanej chwili CPU 2026-09-22:**
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0 ze schematem
`fem_antenna_trajectory.v4`. Zachowano 90 przypadków i 1890 próbek trajektorii;
1800 próbek po krokach rozszerzono o `H_eff`, `H_drive`, wektor `torque`,
energię napędu, energię zewnętrznego biasu, energię całkowitą i `max_torque_Apm`.
Snapshot źródeł:
`14355474149aba5b74c56fd75a5e8c8e020cd1fdd65f5998dc8e152af3f5052b`;
porównanie źródeł przed/po wykonaniu przeszło. Raport v4 zastępuje lokalny v3.

`backends/fem/tests/llg_time_domain_qualification.cpp::write_antenna_endpoint`
kopiuje pola przez ABI i zapisuje statystyki zwrócone przez zaakceptowany krok.
Nie wywołuje odświeżającego `snapshot_stats`; `H_eff` i torque są pobierane
przed materializacją `H_drive`, aby nie maskować nieaktualnego cache.
Sprawdzana jest również jednorodność pól i torque we wszystkich węzłach.
`scripts/validate_fem_antenna_trajectories.py::validate_endpoint` niezależnie
oblicza wartość waveformu w zapisanej chwili, sumę z biasem, energię Zeemana
na objętości pojedynczego tetraedru oraz torque z zapisanej magnetyzacji.
Obowiązują bezwzględne progi: pola i `max_torque_Apm` — $10^{-7}\,\mathrm{A/m}$,
wektor torque — $10^{-12}\,\mathrm{T}$, energie — $10^{-30}\,\mathrm{J}$.
Wektor natywnego torque jest wielkością w teslach, bez mnożnika
giromagnetycznego; nie jest bezpośrednio pochodną magnetyzacji.

Odrzucono siedem niezależnych mutacji raportu: podstawienie każdej z tych
siedmiu obserwabli z poprzedniej próbki sinusoidy `stage_local` w próbie
adaptacyjnej. Nie kompilowano testów jednostkowych Rust. Zmiana rozszerza
bramkę naukową, nie zmienia równań ani implementacji solvera.

Zakres: jednorodny macrospin, jeden napęd preprojected, FEM CPU FP64.
`H_drive` sumuje regionalne napędy; tutaj odpowiada jednej antenie. Nie jest
to kwalifikacja natywnego `H_ant` per źródło, zapisu przez publiczny pipeline
artefaktów ani airboxu. Całkowita energia fixture zawiera wyłącznie bias i
napęd; pełne oddziaływania, niejednorodne siatki, solve/relax/run, mnożenie
bazy przez prąd w runnerze oraz GPU nadal wymagają osobnych dowodów.
T13 pozostaje otwarte.

**Zamrożony spin w polu anteny FEM CPU 2026-09-30:** nowa recepta
`just verify-fem-antenna-frozen-cpu` zakończyła się kodem 0. Natywny
`fem_llg_time_domain_qualification` wykonał sześć przypadków na tej samej
siatce tet4: Heun, RK4, RK23 i RK45 przy kroku stałym oraz RK23/RK45 z
adaptacją. Węzeł 0 ma referencję $\mathbf m_0=(0,1,0)$ i maskę frozen;
trzy pozostałe zaczynają od $(0.6,0,0.8)$. Wyłączono exchange/demag,
zastosowano bias $10^4\,\mathrm{A/m}$ i sinusoidalną antenę o bazie
$10^6\,\mathrm{A/(m\,A)}$, prądzie $0.02\,\mathrm A$, częstotliwości
$1\,\mathrm{GHz}$, fazie $0.7$ oraz offsecie $0.2$.

Raport `.fullmag/reports/fem-antenna-frozen/qualification.json` ma schemat
`fem_antenna_frozen.v1`, status `recorded_unvalidated` i snapshot źródeł
`b3617dc960fc17b57f8b80747c365c8959b2ffa497a4a97b65f120ca98c00eb3`.
Porównanie tożsamości źródeł przed i po wykonaniu przeszło. Niezależny
`scripts/validate_fem_antenna_frozen.py::validate` potwierdził 21 próbek na
przypadek: zamrożony spin zachował dokładnie referencję, a swobodne spiny
zgadzały się z analityczną trajektorią z całki pola (maksymalny błąd
$1.293\times10^{-6}$, próg $5\times10^{-6}$). `H_drive` na węźle frozen i
swobodnym zgadzał się z przebiegiem w zapisanym czasie do
$10^{-7}\,\mathrm{A/m}$; `max_torque_Apm` odpowiadał wyłącznie swobodnym
węzłom do $10^{-7}\,\mathrm{A/m}$. Adaptacja miała 4 odrzucenia RK23 oraz
2 RK45. Walidator odrzucił celowo zmienioną magnetyzację frozen, pole,
magnetyzację swobodną i torque.

Jest to dowód natywnego CPU dla pojedynczej maski frozen i jednorodnego
pola preprojected. Nie sprawdza jeszcze węzłów niemagnetycznych na siatce
mieszanej, okresowych ograniczeń, pełnego pipeline ani GPU. Punkt o ochronie
frozen spins i maski magnetycznej pozostaje zatem otwarty.

**Mieszana siatka magnetyk–airbox w polu anteny FEM CPU 2026-09-30:**
`just verify-fem-antenna-mixed-cpu` zakończyła się kodem 0. Dwa konforemne
tetraedry mają wspólną ścianę, markery elementów $1$ (magnetyk) i $0$
(airbox) oraz piąty węzeł należący wyłącznie do powietrza. Preprojected
basis w osi $z$ jest pełnodomenowa. Dla sinusoidy $1\,\mathrm{GHz}$,
biasu $10^4\,\mathrm{A/m}$ i kroku $0.5\,\mathrm{ps}$ wykonano po 2000
kroków Heun/RK4/RK23/RK45; zapisano po 21 próbek na integrator.

Raport `.fullmag/reports/fem-antenna-mixed/qualification.json` ma schemat
`fem_antenna_mixed.v1`, status `recorded_unvalidated` i snapshot źródeł
`ae80b1598b99f195e82d31b4ea54735686fccd2e545fe5ea47836316df5f1300`.
Tożsamość źródeł przed/po wykonaniu zgodna. Niezależny
`scripts/validate_fem_antenna_mixed.py::validate` wykazał, że `H_drive` w
airboxie i w magnetyku odpowiada waveformowi w czasie próbki do
$10^{-7}\,\mathrm{A/m}$, ale magnetyzacja węzła airboxu nie zmienia się.
Swobodne węzły magnetyku odpowiadają analitycznej trajektorii macrospinu
(maksymalny błąd $1.293\times10^{-6}$ przy progu $5\times10^{-6}$).
Metryka `max_torque_Apm` pomija węzeł airboxu mimo jego niezerowego pola.
Walidator odrzucił cztery celowe mutacje: stanu airboxu, pola w airboxie,
magnetyzacji magnetyku i torque.

Ten dowód obejmuje natywne CPU, dwa tet4, lokalny węzeł airboxu oraz stały
krok. Nie obejmuje PBC, bardziej złożonej wspólnej siatki, projekcji z
rzeczywistego solve anteny, publicznych snapshotów ani GPU. Zatem oba
podpunkty T13 o mixed-mesh i ochronie maski pozostają otwarte w szerszym
zakresie.

**Algebraiczna para PBC na mieszanej siatce CPU 2026-09-30:**
`just verify-fem-antenna-mixed-pbc-cpu` zakończyła się kodem 0.
Na tej samej siatce tet4 para magnetycznych węzłów $(1,2)$ jest jawnie
związana przez natywny `periodic_node_pairs`. Ścieżka exchange pozostaje
włączona zgodnie z kontraktem PBC, a jej współczynnik ustawiono na zero,
aby zachować niezależny analityczny wzorzec Zeemana. Cztery integratory
Heun/RK4/RK23/RK45 wykonały po 2000 kroków; pola i magnetyzacje węzłów
pary były identyczne. Natywny preflight odrzucił drugą próbę utworzenia
backendu po zwiększeniu jednej składowej bazy pola pary o
$1\,\mathrm{A/m}$; nie uśredniał niezgodnych wartości.

Raport `.fullmag/reports/fem-antenna-mixed-pbc/qualification.json` ma
schemat `fem_antenna_mixed_pbc.v1`, snapshot
`8db6de990e936ce7e221766ba39dfc25f5c97fd99dd75861b987e2bf8c4e101e`.
Porównanie źródeł przed/po i niezależny walidator przeszły; walidator
odrzucił też raport z usuniętym dowodem negatywnego preflight. Po zmianie
tego samego kodu ponownie przeszła recepta bez PBC. Wynik dotyczy
algebraicznej pary na małej siatce i stałego kroku CPU; nie jest
benchmarkiem fizycznej komórki periodycznej, demag PBC, GPU ani publicznej
projekcji bazy anteny.

## T14. Domknąć OpenAPI, zasoby i realtime

Uzupełnienie implementacyjne 2026-09-21: `SolvedAntennaDriveResource` ma
teraz jawny, opcjonalny `AntennaWaveformBandwidthDeclarationResource` z
`f_max_hz`; `generate:api` odtworzył OpenAPI v2 i wygenerowane typy bez ręcznej
edycji. Ten sam przebieg uzupełnił w generated contract odpowiedzi 422 dla
nieobsługiwanej topologii widma. `check:api-hygiene` nadal zatrzymuje się na
wcześniejszych literalnych URL-ach w testach viewportu, niezwiązanych z
anteną.

Uzupełnienie implementacyjne 2026-09-21 (stage output API): dodano
`GET /v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog`.
Handler wiąże stage z aktualnym read-modelem, rozwiązuje bezpiecznie jego
`artifact_ref`, waliduje `stage_output_catalog.v1` oraz istnienie manifestów,
publikuje thin metadata z tożsamością sesji/stage, digestem i ETag/304. Facade
`ControlRoomApi`, hook `useAntennaStageOutputCatalogResource` i wygenerowane
artefakty OpenAPI są podłączone. Katalog jest unieważniany scoped przy zmianie
artefaktów i przy zmianie `simulation/stages/execution`; testy klienta (135/135)
i bridge (61/61) przechodzą. Nadal pozostaje pełny resolver symbolicznego
stage/output oraz browser smoke.

**Stan 2026-09-11:** dodano typowane endpointy metadanych opublikowanego rozwiązania pola i widma źródłowego anteny (`data/antenna/...`) z tożsamością sesji, podpisami, linkami do artefaktów oraz ETag/304. Facade `ControlRoomApi` i hooki zasobów są podłączone; wcześniej wygenerowane pliki OpenAPI/TypeScript obejmują podstawowy endpoint, ale nie odzwierciedlają jeszcze dodanej odpowiedzi `unsupported_topology` HTTP 422, ponieważ generator został zablokowany limitem użycia. Zmiana katalogu artefaktów unieważnia teraz tylko prefiksy zasobów wyników anteny; test bridge obejmuje tę izolację. Router ma fixture test gotowego pola/widma, 304, 404 i uszkodzonego manifestu (`db52f48cd0e0449784f1dde51e017c8755ccc4b0`). W `973ac36da63e2e3c45c33d979c24f24ce15c5c1a` dodano manifest `antenna_source_spectrum_artifact.v2`, cztery adresowane hashem payloady `float64_le` oraz endpoint zakresowy `.../payloads/{payload_kind}` z walidacją rozmiaru/hash, ETag/304 i HTTP Range 206; facade/hook oraz testy Rust/UI obejmują ten transport. UI rozróżnia teraz brak opublikowanego payloadu (`missing_payload`) od nieobsługiwanej topologii. Pozostają pełna walidacja świeżości, odświeżenie generated OpenAPI po odzyskaniu generatora i testy przeglądarkowe end-to-end.

**Pliki:** API schema/router handlers wskazane w mapie, nowe `handlers/data/antenna.rs`, `ControlRoomApi.ts`, nowe `antennaResources.ts`, generated transport/types/paths.

- [ ] Regenerować scenę z typowanych danych T03; pole błędnie nazwane lub nieznane ma być wykrywane w authoring contract. Nie usztywniać przypadkowo unrelated extension fields bez migracji.
- [ ] Wykorzystać istniejące rodziny `simulation/stages/execution`, `data/artifacts`, `data/fields` i analysis; nowy handler dostarcza metadane rozwiązania anteny jako zasobu, nie jako stanu Inspectora.
- [ ] Zdefiniować thin metadata: IDs, status, signatures/revisions, requested/resolved lane, port summaries, warning IDs, links do payloadów. V/J/H/topology muszą pozostać binarne.
- [ ] Zapewnić resource identity co najmniej `(session_generation, asset_id, field_signature, target_projection_signature, quantity, component)`; stary ACK po zmianie generation nie może podmienić nowego wyniku.
- [ ] Zdarzenia websocket invalidują konkretne zasoby; GET/ETag/304 odtwarzają stan. Nie tworzyć ws-only kanału wyników ani poll całej sesji.
- [ ] Wygenerować wszystkie cztery artefakty kontraktu przez istniejący `generate:api`, z build/cache ustawionym zewnętrznie w T01. Nie ręcznie edytować generated TypeScript.
- [ ] Dodać methods facade i hooks zgodnie z `fieldDriveResources.ts`/ResourceCache; komponenty nie konstruują URL ani `fetch`.
- [ ] Testy: GET gotowego i stale zasobu, 304, brak/korupcja payloadu, anulowany stage, unsupported lane, scoped projection, invalidation tylko właściwego resource i odzyskanie po reconnect.

Istniejące polecenia frontendu:

```text
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
```

Ich przygotowanie zależności i Cargo pozostaje zarządzane przez środowisko T01; nie kierować pnpm store ani target do repo. **Bramka:** `authoring` oraz testy API/facade/resource w `browser`. Commit: `feat: expose typed antenna solution resources`.

## T15. Zbudować spójne UI i naprawić utratę parametrów/draftu

Uzupełnienie implementacyjne 2026-09-21: dedykowany Inspector `drive` pokazuje
teraz deklarowane `bandwidth_declaration.f_max_hz` jako osobny wiersz. Brak
deklaracji pozostaje jawnie `not declared`, a wartość niefinitywna jest
oznaczana jako `invalid declaration`; UI nie wyprowadza pasma z czasu impulsu
ani z próbkowania. Formatter ma test Vitest 5/5, a ESLint zmienionych plików
przechodzi. Formalny typ OpenAPI jest już wygenerowany; edycja deklaracji,
walidacja konfliktu i pełny browser smoke nadal należą do T14/T15.

**Stan 2026-09-11:** dedykowane węzły Explorer i routing Inspectora są już podłączone, a `AntennaCompositionPanel` rozwiązuje authored stage/request do właściwych `output_id` i korzysta z typowanych hooków wyników anteny. Węzły `solution` i `spectrum` pokazują stan zasobu (`loading/ready/stale/error/missing`) oraz metadane manifestu; `projection` i `drive` pokazują dostępność opublikowanej bazy pola. Dodano test resolvera identyfikatorów oraz DOM regresję gotowego wyniku. Commit `d48f32cd9` dodaje dekodowanie czterech payloadów `float64_le`, bounded heatmapę `|H(k_u,k_v)|²` z peak/k-grid oraz testy gotowego i błędnego transportu; `cae985d3b` zachowuje kody `missing_payload`/`unsupported_topology` jako jawny błąd Inspectora zamiast maskowania ich jako brak zasobu. Nadal brakuje pełnego browser smoke `create → solve → inspect → stale` i diagnostyki React dla całego workflow.

**Uzupełnienie implementacyjne 2026-09-21:** `AntennaCompositionPanel` korzysta
z typowanego `useAntennaStageOutputCatalogResource`. Resolver przekazuje teraz
`stageId` dla węzłów `solution`, `projection`, `drive` i `spectrum`, a Inspector
pokazuje osobno stan katalogu (`ready/loading/stale/error/missing`), status i
rewizję stage, opublikowane output IDs, quantities, digest oraz diagnostykę.
Pozostaje to cienkimi metadanymi control plane; payloady pola i FFT nie są
ładowane przez ten panel. Dodano regresję modelu i DOM dla gotowego katalogu.
Pełny browser smoke, diagnostyka React oraz kwalifikacja runtime nadal pozostają
otwarte.

W tej samej iteracji helpery runtime i formatter pasma zostały wydzielone z
pliku komponentu do modułów modelu. React Doctor nie zgłasza już ostrzeżeń
`only-export-components` dla tego obszaru.

**Uzupełnienie implementacyjne 2026-09-21 (draft i rewizja):**
`AntennaObjectPanel` odrzuca zapis, gdy zasób sceny nie jest `ready` albo nie
udostępnia bezpiecznej rewizji całkowitej. Canonical `replaceFieldDrive` oraz
legacy `merge_patch` migracji przekazują jawne `base_revision`; pełna tablica
nie może już nadpisać nowszej sceny bez konfliktu. Test DOM 5/5 sprawdza
canonical zapis, zachowanie `phase/offset` podczas edycji amplitudy, migrację
legacy, zachowanie niezapisanego draftu przy niezależnej rewizji sceny oraz
aktywny fokus i niezależne kontrolki w stanie pending. Dodany workflow 409
`Refetch Scene → Rebase Draft → Retry Save` pokazuje porównanie server/draft,
zachowuje lokalny draft do jawnego rebase i ponawia zapis z nową rewizją.
Łącznie testy modelu/DOM przechodzą 11/11; nie zamyka to pozostałego T15.

Komenda `Add Microstrip Antenna` również pobiera rewizję z tego samego
`SceneResource` odpowiedzi `scene()` i przekazuje ją w `merge_patch`. Brak
rewizji kończy się jawnie `failed`, a równoległe komendy podlegają serwerowemu
409 zamiast bezwarunkowego nadpisania. Test authoringu 42/42 obejmuje oba
przypadki.

**Uzupełnienie implementacyjne 2026-09-21 (kontrakt portu v2 w presecie):**
Test authoringu ujawnił, że `Add Microstrip Antenna` nadal wysyłał legacy
`terminal_selector_ref` bez discriminatora, mimo że kanoniczny
`AntennaPortModeIR` wymaga `schema_version="antenna_port_mode.v2"` i jawnych
par `inlet_terminal_ref/outlet_terminal_ref`. Preset został zaktualizowany:
current transport ma cztery rozłączne elektrody (`signal_in/out` oraz
`return_in/out`) i jawnie izolowane `x_min/x_max`, a port ma dwie gałęzie o
wagach `+1/-1`. Test `geometryLifecycleCommandContributions.test.ts` przechodzi
42/42 i sprawdza także brak legacy pola. Jest to naprawa serializacji i
authoringu; nie zamyka T02/T05/T06 ani nie stanowi dowodu zbieżności solve,
bilansu terminali lub kwalifikacji 3D FEM.

W tym samym kroku poprawiono dedykowany conductor Inspector: obiekty sceny
emitują `geometry.geometry_kind`, więc panel używa tego pola (z zachowaniem
fallbacku dla starszego `geometry.kind`). Testy modelu/DOM kompozycji przechodzą
7/7; zmiana dotyczy prezentacji authoringu i nie podnosi statusu gotowości
solverów.

Explorer waliduje teraz także strukturalną gotowość portu: schema v2, minimum
dwie gałęzie, unikalne pary terminali, niezerowe skończone wagi, suma dodatnia
równa `1` i suma wszystkich wag równa `0`. Niepoprawny port otrzymuje
`warning` oraz badge `invalid`, a poprawny port `ready`; test Explorera obejmuje
oba przypadki. Dedykowany port Inspector pokazuje tę samą walidację w wierszu
`Validation`, a reguły są współdzielone przez Explorer i Inspector w
`apps/control-room/src/modules/antenna/antennaPortValidation.ts`. Jest to
diagnostyka authoringu, nie wynik runtime solve.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja stage solution):**
dedykowany Inspector stage `solution` nie pokazuje już ogólnego
`configured · result pending`, gdy jego referencje są niekompletne. Przed
publikacją pola sprawdza obecność `current_transport_id`, każdego
`port_mode_id`, zgodność źródła/transportu portu oraz wymagane wyjście
`H_ant_basis`. Konkretne braki trafiają do wiersza `Validation`, a badge ma
stan `invalid · result pending`; poprawny, ale jeszcze niewykonany stage
pozostaje `configured · result pending`. Test DOM tego panelu przechodzi 4/4,
ESLint i React Doctor pozostają zielone. To nadal wyłącznie kontrakt i
diagnostyka metadanych UI — nie kwalifikacja solve, Relax/LLG ani GPU.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja projection):**
Inspector `projection` sprawdza teraz referencję do stage i outputu oraz
wymaga, aby wskazany output publikował `H_ant_basis`. Dla targetów typu
`object` i `region` sprawdzana jest również obecność obiektu, a dostępny
region jest rozpoznawany po `region_id` lub kanonicznej nazwie. Braki są
pokazywane w wierszu `Validation`, a badge przyjmuje stan
`invalid · result pending`; global target nie wymaga listy obiektów. Testy
modelu i DOM kompozycji przechodzą 10/10. To walidacja referencji authoringu,
nie dowód projekcji numerycznej ani kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja solved drive):**
Inspector `drive` sprawdza teraz `port_mode_id`, `projection_ref` oraz każdy
stage wskazany przez `activation.kind=stage_ids`. Gdy projekcja istnieje,
przenosi także jej błędy referencji do diagnostyki drive. Wiersz `Validation`
i badge `invalid · result pending` odróżniają brak konfiguracji od samego
oczekiwania na wynik; nie zmieniono oceny waveformu, amplitudy ani czasu.
Łączne testy modelu/DOM kompozycji przechodzą 11/11 (DOM 6/6), ESLint i
React Doctor pozostają zielone. Nadal nie jest to dowód aktywacji w LLG ani
kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja spectrum/FFT):**
Inspector `spectrum` współdzieli walidację solution reference i targetu, a
dodatkowo sprawdza opcjonalny port przypięty do stage'a. Odwzorowano reguły
IR dla sampling plane: skończony ortonormalny układ osi, dodatnie extent,
liczniki próbek, okna wymagające co najmniej trzech próbek, dozwoloną
interpolację oraz zgodność `spatial_fft`/`nonuniform_spatial_fft` z k-grid.
Dozwolone komponenty i niepusty output również są sprawdzane. Niepoprawny
request ma `Validation` i `invalid · result pending`; poprawny nadal czeka na
rzeczywisty payload FFT. Testy modelu/DOM przechodzą 13/13 (DOM 8/8), ESLint,
React Doctor i typecheck zmienionych plików pozostają bez nowych błędów.
To kontrakt authoringu, nie dowód wykonania FFT ani kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (harness browser):** dodano
`apps/control-room/scripts/smoke-antenna-authoring-ui.mjs` oraz helper i test
kontraktu Node. Smoke ma jawnie ograniczony zakres pierwszej fazy T15:
`create → Explorer → conductor/port/solution → ready thin metadata → WebGL`
z kontrolowanymi odpowiedziami zasobów pola/katalogu. Nie jest jeszcze pełnym
`smoke-antenna-workflow.mjs`: nie wykonuje native solve, Relax/LLG,
export/reload, waveform/reuse, stale ani lifecycle field-map. Próba wykonania
21.09.2026 ma status **zaliczona dla pierwszej fazy authoring/WebGL** po
przeniesieniu frontendowych artefaktów do zarządzanego storage. Zakres i
ograniczenia tego smoke pozostają takie same: nie wykonuje on native solve,
Relax/LLG, export/reload, waveform/reuse, stale ani lifecycle field-map.

**Uzupełnienie implementacyjne 2026-09-21 (dispatcher transakcji i dowód
runtime):** pierwsze uruchomienie ujawniło `STATUS_STACK_OVERFLOW` w workerze
Tokio przy `POST /v2/sessions/current/model/transactions`. Źródłem był zbyt
duży typ przyszłości generowany przez jeden asynchroniczny match wszystkich
wariantów `AuthoringTransactionRequest`, a nie niepoprawna scena anteny.
Handler zachowuje extractor JSON i publiczny kontrakt, lecz używa
synchronicznego dispatchera z osobno boksowanym future dla każdego wariantu.
Po restarcie przez zarządzany `just control-room-v2` utworzenie sesji zwróciło
`201`, pusty `merge_patch` zwrócił `200` z `scene_revision=1`, a `/healthz`
pozostał zdrowy. Jest to naprawa runtime control-plane, nie kwalifikacja
fizycznego pola.

Pierwsza faza browser smoke zakończyła się wynikiem **pass**: conductor,
port, stage/output, katalog thin metadata i WebGL spełniły kontrakt, a manifest
zawiera rozstrzygnięte ID oraz `scene_revision`. Fixture jawnie eksponuje
`x-api-contract-version` i `etag`; cztery znane anulowane żądania GET są
rejestrowane osobno, a wszystkie inne błędy żądań kończą test negatywnie.
Wynik zapisano w `.fullmag/test-results/antenna-authoring/` jako screenshot i
manifest. T15 pozostaje częściowo otwarte: pełny workflow z natywnym solve,
Relax/LLG, FFT, export/reload, reuse i stale musi zostać wykonany przed
odhaczeniem bramki browser.

Weryfikacja tej iteracji: celowane Vitest **55/55**, ESLint zmienionych plików
bez nowych błędów, `git diff --check` **OK**. Typecheck nadal ma trzy znane
błędy nullability w `FieldMapModule.tsx:588-591`; testów jednostkowych Rust nie
kompilowano, a kwalifikacji FEM/FDM GPU nie przeprowadzono.

**Pliki:** istniejące AntennaObjectPanel/Model/test, geometry command i test, Explorer/ribbon; nowe panele w `apps/control-room/src/modules/inspector/panels/antenna/`: `AntennaConductorPanel.tsx`, `AntennaPortPanel.tsx`, `AntennaSolutionPanel.tsx`, `AntennaProjectionPanel.tsx`, `SolvedAntennaDrivePanel.tsx`, `AntennaSpectrumPanel.tsx`.

- [ ] Rozdzielić etykiety „Pole regionalne” i „Antena przewodnikowa”. Stary regional panel pozostaje edytorem regional drive; nie używać go jako fallback dla brakującej konfiguracji solved source.
- [ ] Każdy child node Explorer dostaje własny selection identity i dedykowany Inspector. Dla conductor pokazać geometrię/materiał, dla portu terminale/kierunki, dla solution status/diagnostykę, dla projection target/metodę, dla drive prąd/waveform/activation, dla spectrum plane/okno/komponent.
- [ ] Badge ready brać ze zgodnego resource, nie z `type=antenna`. Incomplete port/target ma listę konkretnych braków oraz przycisk prowadzący do właściwego panelu.
- [ ] Naprawić `draftWaveform`: podczas edycji parametrów tego samego waveform zachować istniejące phase/offset/amplitude i wszystkie inne nieedytowane pola; przy zmianie rodzaju zastosować jawne defaulty nowego rodzaju.
- [ ] Utrzymywać draft pod `(object_id, field_id)`; rewizja całej sceny nie resetuje edycji. Konflikt tego samego pola pokazuje porównanie server/draft, a niezwiązany ACK nie zmienia lokalnej wartości.
- [ ] Każdy patch pełnej tablicy musi używać oczekiwanej `base_revision`, albo zastąpić go typed command pojedynczego obiektu/portu. Nie retry’ować konfliktu przez nadpisanie nowszego dokumentu.
- [ ] Pending stan jest per-field/transaction; nie wyłączać całego Inspectora. Zachować root identity, scroll, focus i selection, bez animacji opacity na trwałych kontrolkach.
- [ ] Reuse istniejących field slices/plots. Prezentować H/A i jednostkę po konwersji; próbkowanie błędne/poza domeną ma odrębny stan. Field-map aktywny zamiast viewport-3d nie utrzymuje niepotrzebnego WebGL render loop.
- [ ] UI wybiera natywny field solve jako jawny stage i dopina drive do TimeEvolution; przejście do LLG jest niedostępne przy stale/unqualified projection.
- [ ] Uruchomić React diagnostics według `react-doctor`, a następnie realny browser smoke nowej anteny z T13/T14. Mock-only test nie zamyka F01/F09.

Obowiązkowe scenariusze testów modelu panelu:

```text
existing sinusoidal phase=0.7, offset=0.2; edit only B amplitude -> phase=0.7, offset=0.2
existing sinc amplitude=0.3; edit only direction -> amplitude=0.3
unsaved current draft; unrelated object revision -> draft unchanged
edit current pending; click frequency -> frequency control remains enabled and focused
two concurrent add commands -> revision conflict or both objects preserved; never silent overwrite
new conductor antenna -> port/solution Inspector; never missing regional source panel
```

**Bramka:** `browser`. Nowy smoke `smoke-antenna-workflow.mjs` wykonuje create → solve → inspect H → Relax/Run → inspect m → export/reload → change waveform/reuse → change geometry/stale. Sprawdza widoczny canvas, `gl.isContextLost() === false`, niezerowy drawing buffer oraz osobny lifecycle field-map. Commit: `feat: complete conductor antenna authoring and inspection`.

## T16. Udostępnić FEM precompute → FDM CPU i GPU

**Pliki:** CLI attach, planner FDM/antenna projection, `crates/fullmag-runner/src/fdm/cpu/reference.rs`, `fdm/gpu/cuda/native.rs`, `multilayer.rs`, właściwi natywni właściciele FDM regional field oraz publiczne ABI.

- [ ] Zdefiniować backend-neutral resolved sampled basis z target certificate, jednostką H/A, waveform i time origin. Requested LLG backend nie zmienia backendu historycznego solve anteny.
- [ ] W T09 wygenerować projekcję na rzeczywiste cell centers FDM, z maską Ms/geometry i kolejnością zgodną z planem. Dla multilayer uwzględnić grubości, położenia i aktywne komórki; nie zakładać jednego równego z-grid.
- [ ] Domknąć istniejący CPU helper przez publiczny CLI zamiast pozostawiania go niewywołanym. Test ma uruchamiać prawdziwy skrypt pipeline, nie tylko konstruować FdmPlan ręcznie.
- [ ] Uzyskać CPU oracle statycznego H i krótkiej LLG. Potem dodać upload bazy do istniejącego natywnego właściciela pola FDM CUDA i ocenę waveform na urządzeniu/czasie RK zgodnie z jego kontraktem.
- [ ] Nie kopiować całej bazy przy każdym RHS; upload po zmianie projection revision. W idle/rendering nie przeliczać pola anteny.
- [ ] Forced GPU przy braku kwalifikacji kończy się jawnym błędem. Zlikwidować istniejące odrzucenie w CLI dopiero gdy plan, upload, waveform, quantity i runtime proof są kompletne.
- [ ] Zweryfikować double najpierw; single pozostaje unavailable dla tego workflow do własnych tolerancji i parity. Multilayer nie dziedziczy automatycznie kwalifikacji single-grid.
- [ ] Dla FEM GPU wykonać osobny test tego samego artefaktu i RK. Wspólne pakowanie CPU/GPU nie zastępuje dowodu GPU device identity.

**Bramki w kolejności:** `fdm-cpu`, `fdm-gpu`, `fem-gpu`. Każda zapisuje source/target hashes, device ordinal/name, precision, integrator, statyczne pole i trajektorię. Publikować support tylko dla kombinacji faktycznie zaliczonych; reszta ma jednoznaczny komunikat w UI i Python.

Uzupełnienie runtime 2026-09-12: istniejący FDM CPU/reference ma zielone testy
skalowania rozwiązanej bazy przez prąd i oceny waveformu w czasie oraz test
braku RF w relaksacji. Publiczny skrypt pipeline, projekcja na rzeczywiste
komórki FDM, upload CUDA i osobne dowody GPU nadal nie są zamknięte.

Uzupełnienie runtime 2026-09-21: naprawiono rozjazd zegara w ścieżce FDM
CUDA dla rozwiązanego napędu regionalnego/antenowego. Natywny integrator ma
zegar lokalny od zera, dlatego granica CUDA mapuje `stage_local` na
`t_solver`, a `absolute` na `t_solver + stage_start_time_s`; snapshoty `H_ant`,
live preview i rekonstrukcja energii używają tego samego mapowania. Zmiana nie
kwalifikuje jeszcze GPU: nadal brakuje kontenerowego dowodu double parity,
pełnej trajektorii LLG i testu rzeczywistego runtime.

Uzupełnienie runtime 2026-09-21 (granice waveformu): CUDA przycina teraz
stały i adaptacyjny krok do granic `pulse`/PWL zarówno dla `field_drives`, jak
i aktywnych `solved_antenna_drive_bases`. Harmonogram jest liczony w czasie
fizycznym i konwertowany na lokalny zegar native; nie zmienia kroku dla
sinusoidy ani sinc, które są ciągłe. Nadal potrzebny jest kontenerowy test
RHS/trajectory z rzeczywistym skokiem waveformu.

## T17. Domknąć frequency response bez pozornego wsparcia eigenmodes

**Pliki:** `crates/fullmag-runner/src/frequency_response.rs`, CLI attach/resolver, IR study/drive, planner frequency response i źródła wymuszenia.

- [ ] Rozdzielić dwa użycia: statyczne pole wpływające na równowagę/operator oraz małosygnałowe wymuszenie frequency response. Solved dynamic drive nie jest samodzielnym eigenmode operator.
- [ ] Dla rzeczywistej bazy Tier 1 dopuścić w frequency response harmonijny skalarny prąd z jawną fazą. Uzgodnić konwencję exp(+/-i omega t) z istniejącym właścicielem frequency_response i przeliczyć Sinusoidal dokładnie do niej.
- [ ] Odrzucić pulse/sinc/sampled waveform w steady harmonic study, chyba że jest jawny osobny kontrakt transformaty sygnału; nie interpretować ich amplitudy jako sinusoidy automatycznie.
- [ ] Wczytać i sprawdzić equilibrium oraz target projection; skonstruować RHS z wektorowego pola przez istniejący operator liniaryzacji LLG, zachowując jednostki i damping policy.
- [ ] Usunąć blanket rejection `FemFrequencyResponse` dopiero po wykonaniu rzeczywistego rozwiązania. `FemEigen` nadal jawnie odrzuca aktywne dynamiczne wymuszenie, bo nie jest to problem własny z prawą stroną.
- [ ] Porównać harmoniczną odpowiedź macrospin z analityką i z FFT długiej małoamplitudowej trajektorii T13 po odrzuceniu transjentu. Porównać także fazę, nie tylko peak frequency.
- [ ] Zapisać rozróżnienie pola na amper, odpowiedzi na podany prąd i susceptibility. Nie nazywać odpowiedzi magnetyzacji S21 bez modelu detektora.

**Bramka:** `frequency-response`. Jeśli bieżący scope produktu ma kończyć się na time-domain, etap może pozostać jawnie unavailable, ale nie wolno wtedy oznaczyć tej pozycji planu jako zamkniętej ani opisać całego docelowego scope jako gotowego.

(plan-validation)=
## T18. Domknąć dokumentację, walidację i ponowny audyt

**Pliki:** 0950/source-map, 0980/source-map jeśli zmienia się current/Oersted, ADR 0017, capability matrix, Python public docs, `docs/validation/antenna/`, niniejsza macierz coverage i nowy raport końcowy.

- [ ] Zastąpić target-only przykład 0950 aktualnym wykonywalnym stage-first skryptem. Tabela parametrów musi obejmować wszystkie publiczne klasy i pola antenowe, w tym waveform, projection, sampling i requested/resolved semantics.
- [ ] Rozwiązać cztery błędy validatora odnotowane w audycie poprzez rzeczywiste uzupełnienie tabel/mapowania, nie przez usunięcie parametrów z source-map. Sprawdzić wszystkie nowe kotwice path+symbol.
- [ ] Wygenerować pełne golden JSON z bieżących przykładów, zrealizować export/reimport UI i zapisać zgodność intent. Nie ręcznie pisać wygodniejszego JSON niż produkuje DSL.
- [ ] Uruchomić wszystkie grupy verification, właściwe native gates, typecheck/API hygiene, browser i scientific-docs validators. Publiczne strony budować Sphinx z warnings-as-errors oraz sprawdzić rendered HTML według scientific-documentation-contract.
- [ ] Wykonać CPW wide/constricted benchmark: fixed targets, trzy siatki, lokalne widmo, odpowiedź m(k,omega), niezależna dyspersja i analiza wpływu tłumienia. Nie używać sztucznie zmniejszonego damping do deklaracji rzeczywistej długości propagacji.
- [ ] Zapisać osobną macierz CPU/FDM, GPU/FDM, CPU/FEM, GPU/FEM z integratorami i precyzjami; brak danych lub skip pozostaje not_qualified.
- [ ] Powtórzyć audyt wszystkich F01–F13 i luk scope. Każdy wiersz ma wskazywać commit, test reprodukujący błąd, wynik RED przed i GREEN po, raport runtime jeśli wymagany.
- [ ] Wykonać końcowy read-only review diffu względem aktualnego master. Potwierdzić, że nie usunięto zmian mixed-mesh, frozen spins, profiler ani zasad output directory.
- [ ] Przygotować opis integracji z konkretnym zachowaniem przed/po i rzeczywistymi wynikami. Nie scalać automatycznie ani nie publikować dokumentacji na podstawie samego odhaczenia listy.

Polecenia dokumentacyjne istniejące w repo:

```text
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json --repo-root .
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json --repo-root .
python -B -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p "test_*.py"
python -B scripts/check_public_doc_examples.py --root public_docs/site
just verify-antenna-contracts all
```

`python` w tych poleceniach oznacza istniejący zweryfikowany interpreter z T01; na badanym Windows użyto `D:/fullmag-cache/contract-python/Scripts/python.exe`, ponieważ systemowy alias `python.exe` nie działał. Nie instalować nowego środowiska w checkoutcie.

(plan-python-api)=
(plan-problem-ir)=
(plan-round-trip-and-failure-semantics)=
## 4. Kontrakty przekazania między zadaniami

| Producent → konsument | Co przekazuje | Czego nie wolno zakładać |
|---|---|---|
| T02 → T03/T05 | Wersjonowane terminal pairs, podpisane wagi i normę 1 A | Pojedynczy legacy terminal nie określa pełnej gałęzi |
| T03 → T08/T12 | Symboliczny stage/output jako requested intent | Authoring nie zna jeszcze digestu rozwiązania |
| T05 → T06 | V/J i podpisany terminal certificate/gauge | Bilans modułów nie jest bilansem znaków |
| T06 → T08 | Konserwatywny source i pole z raportem dokładności | Mała reszta solvera nie jest błędem pola |
| T08 → T09/T13 | Resolved execution, integralność i aktualne signatures | Stary poprawny plik nie musi pasować do nowego modelu |
| T09 → T10/T13/T16 | Pole w target ordering, maska, metoda i scope | Missing sample nie jest outside_domain |
| T07 → T13/T16 | Aktywne termy i poprawny waveform/time origin | AllTimeEvolution nie obejmuje Relax |
| T12 → T14 | Rzeczywisty stage status i revisioned artifact refs | Enum postępu nie jest pomiarem pracy |
| T14 → T15 | Typowany facade/resource model | UI nie składa własnych URL ani fizyki |

`validation errors` muszą pozostać rozpoznawalnymi kategoriami z identyfikatorem obiektu/portu/stage. `unsupported combinations` mają failować przed pracą i być widoczne przez ten sam capability contract w Python i UI. Wersjonowane zmiany authoringu i ABI są częścią T02/T03/T05/T09, nie bezterminowym dual stack.

(plan-discrete-realization)=
## 5. Macierz finalnych dowodów i odpowiedzialności

| Lane | Solve pola | Konsumpcja LLG | Wymagany dowód |
|---|---|---|---|
| FEM CPU | Native H1/hypre, RT0, adaptive Biot–Savart | Natywny Zeeman | T05/T06/T13, urządzenie CPU i właściwy build |
| FEM GPU | Pierwszy solve nadal jawnie CPU | Własna realizacja device runtime | T16, artifact identity i GPU trajectory; nie nazywać precompute GPU |
| FDM CPU | Import wyniku FEM | CPU oracle na cell centers | T09/T16, projection error i LLG |
| FDM GPU | Import wyniku FEM | CUDA field-basis owner | T16, double parity, poprawny RK i brak transferów per-RHS |

Każda promocja jest osobna. Nie ma automatycznej zasady „native ABI istnieje, zatem wszystkie backendy są gotowe”.

(plan-limitations)=
## 6. Czego ten plan nie wdraża

Pełne Maxwell, harmoniczna zależność profilu J od częstotliwości, S-parametry, dBm normalization, detektor indukcyjny, backreaction i automatyczny obwodowy rozdział prądów RF to dalsze projekty. Plan naprawia wszystkie znalezione problemy Tier 1 i przygotowuje do nich uczciwe granice kontraktów. Nie udaje, że implementacja tych rozszerzeń jest potrzebna do naprawienia gubienia sceny lub aktywacji Relax.

Wykonanie T00–T18 może wymagać kilku przeglądanych zmian, a nie jednego ogromnego commita. Nie wolno zamknąć audytu połową przepływu ani nazwać testów source-layout kwalifikacją fizyczną. Jeśli środowisko blokuje runtime, zadanie otrzymuje status niezweryfikowane wraz z konkretnym poleceniem i błędem; nie obniża się wymagań.

## 7. Lista odbioru planu

- [ ] F01–F13 mają test przez rzeczywistą wadliwą granicę oraz poprawkę właściciela.
- [ ] Każda luka scope ma właściciela w T00–T18; nie ma niejawnie odłożonego FDM/phase/round-trip.
- [ ] Wszystkie nowe pliki/types/recipes są jawnie nazwane jako planowane; istniejące paths zostały sprawdzone.
- [ ] Native build jest kontenerowy i ma zewnętrzne storage; testy nie przechodzą z liczbą 0.
- [ ] Przykłady publiczne są stage-first i wykonane, a dokumentacja rozróżnia plan od faktycznej lane qualification.
- [ ] Frontend przechodzi realny browser smoke, stabilność Inspectora i WebGL lifecycle.
- [ ] Reviewer otrzymuje dowody numeryczne, nie wyłącznie listę plików lub screenshot.

(plan-scientific-bibliography)=
## 8. Dokumenty nadrzędne i źródła

- [Audyt F01–F13](../../audits/2026-09-08-microwave-antenna-worktree-audit.md): diagnoza, rewizje, dowody i granice walidacji.
- [Fizyka 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md): właściciel modelu źródła, SI, normalizacji i ważności.
- [ADR 0017](../../adr/0017-staged-antenna-field-basis-workflow.md): stage-first solve i reuse bazy.
- [Projekt field-basis](../specs/2026-07-10-microwave-antenna-field-basis-design.md): docelowe funkcje produktu; jego fragmenty historyczne wymagają aktualizacji do wyników audytu.
- [Backend masterplan](../../architecture/backend-golden-masterplan.md): właściciele native physics i runtime.
- [Höfinger i in.](https://arxiv.org/html/2511.10346v1), [Gruszecki i in.](https://arxiv.org/abs/1509.05061), [MIT Skin Effect](https://www.mit.edu/course/6/6.013_book/www/chapter10/10.7.html): źródła naukowe omówione z ograniczeniami w audycie.

(plan-source-code-index)=
## 9. Kotwice kodu dla wykonawcy

| Ścieżka istniejąca | Symbol | Zadania |
|---|---|---|
| `crates/fullmag-authoring/src/scene.rs` | `SceneDocument` | T03 |
| `crates/fullmag-authoring/src/adapters.rs` | `scene_document_from_script_builder` | T03 |
| `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | `apply_scene_merge_patch` | T03/T14 |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaPortMode` | T02/T03 |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class SolvedAntennaDrive` | T03/T07 |
| `crates/fullmag-plan/src/antenna_composition.rs` | `bind_resolved_antenna_field_solve` | T05 |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `measured_port_current` | T05 |
| `crates/fullmag-ir/src/validation.rs` | `validate_time_dependence` | T07 |
| `crates/fullmag-plan/src/util.rs` | `field_drive_is_active` | T07 |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `load_solved_antenna_drive_basis_projected` | T08/T09 |
| `crates/fullmag-runner/src/antenna_stage.rs` | `antenna_field_solution_signatures` | T08 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `sample_antenna_field_on_plane` | T09/T10 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_structured_antenna_source_spectrum` | T10 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_nonuniform_k_antenna_source_spectrum` | T10 |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | T06/T11 |
| `crates/fullmag-cli/src/orchestrator.rs` | `attach_solved_antenna_drive_bases` | T08/T12/T16/T17 |
| `crates/fullmag-runner/src/native_fem.rs` | `pack_native_regional_field_drives` | T07/T13 |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | `project_regional_field_drive_bases` | T00/T13 |

Kotwice mogą się zmienić po T00; wykonawca aktualizuje mapę źródeł przy przeniesieniu symbolu. Zaplanowana nazwa nowej funkcji nie jest dowodem obecności jej implementacji.
