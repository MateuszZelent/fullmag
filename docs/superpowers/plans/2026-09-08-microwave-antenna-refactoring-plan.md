# Plan implementacji refaktoryzacji modułu anten mikrofalowych

> **Dla wykonawcy:** realizuj zadania kolejno przy użyciu `executing-plans`; jeśli praca zostanie jawnie rozdzielona na agentów, stosuj `subagent-driven-development`. Każda pozycja `- [ ]` wymaga rzeczywistego wykonania i dowodu. Nie oznaczaj jej jako zakończonej na podstawie samego kodu.

**Cel:** usunąć wszystkie problemy wskazane w [audycie z 2026-09-08](../../audits/2026-09-08-microwave-antenna-worktree-audit.md), a następnie domknąć reprodukowalny przepływ przewodnik 3D → prąd → baza pola → relaksacja bez RF → LLG z RF → wyniki w Python i Control Room.

**Architektura:** wspólne obiekty, geometria, materiały i CurrentTransport są właścicielami fizyki. Antena wiąże terminale w porty, uruchamia niezależny solve pola i dostarcza immutable wektorową bazę na amper. LLG, frontend i analizy konsumują ten sam wynik przez jawne projekcje i wersjonowane kontrakty.

**Stos technologiczny:** Python DSL, Rust IR/planner/runner/API, MFEM/hypre CPU, istniejące konserwatywne RT0 i adaptacyjne Biot–Savart, natywne realizacje FEM/FDM, Next.js 16/React, generowany OpenAPI v2, istniejący facade i resource hooks, Vitest/Playwright oraz kontenerowe recipes `just`.

**Status:** plan do wykonania; poniższe zmiany, nowe funkcje, pliki, recipes i nazwy testów nie są deklaracją ich aktualnego istnienia. Ten dokument nie wykonuje refaktoryzacji. Podstawą jest dirty snapshot audytu, HEAD `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5`, lokalny master `7faa259c5597ba447c413f2aea0ff66d6110b297`.

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

- [ ] Najpierw lokalnie naprawić kolejność: utworzyć wektor zerowy pełnej długości targetu; dla `mask[i]==false` pominąć lookup. Dla aktywnego węzła brak próbki nadal zwraca błąd.
- [ ] Test RED/GREEN: source posiada próbkę tylko w `[0,0,0]`; target posiada `[0,0,0]` i `[1,0,0]`; maska `[true,false]` daje pierwsze pole i zero. `[true,true]` nadal odrzuca brak danych.
- [ ] Zdefiniować trzy odrębne realizacje: `identity_coordinates_v1`, `fem_p1_interpolation_v1`, `direct_rt0_evaluation_v1`. Nie nazywać lookupu `fem_element`.
- [ ] W nowej wersji field carrier zachować topology/element ordering i sampling scope potrzebne do point location; albo zachować w binarnym artefakcie RT0 + conductor mesh i closure do ponownej ewaluacji. Same pozycje i H nie wystarczają do klasyfikacji wnętrza.
- [ ] Dla P1 użyć barycentrycznych współrzędnych poprawnego elementu; boundary tolerance skalować geometrią. Zdefiniować deterministic ownership dla punktów na współdzielonej ścianie. Nie używać nearest node jako interpolacji FEM.
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
`compose.yaml` interpretuje kompatybilnościowy `FULLMAG_FRONTEND_ROOT` jako
nieprawidłowy mount z dwoma ścieżkami Windows. Nie jest to jeszcze pełna bramka
T11: brakuje agregacji między osobnymi blokami/retries i callbackami etapów,
budżetu pamięci i anulowania, diagnostyki pasma `eta_wave`/`eta_skin`, pomiaru
wall-time/peak-memory oraz kontenerowego benchmarku direct RT0.

**Pliki:** nowe planner `antenna_preflight.rs` i runner `antenna_validity.rs`, istniejący IR/plan, `native_fem/steady_transport.rs`, direct tetra options, manifest/DTO; nowy `tests/antenna/verify_budget.py`.

- [ ] Wyliczać przed solve liczbę elementów źródła, targetów, par i rozmiar buforów. Użyć checked multiplication; overflow jest błędem, nie ogromnym zaakceptowanym zadaniem.
- [ ] Zastąpić stałą miliona par jawnie wersjonowaną polityką wykonania. Zachować limit domyślny dopóki benchmark nie uzasadni innego; błąd preflight pokazuje oba rozmiary i koszt.
- [ ] Blokować targety dla ograniczenia pamięci i granic anulowania. Licznik globalny obejmuje wszystkie bloki, porty i retries; nie resetować budżetu dla każdego bloku, aby obchodzić limit.
- [ ] Nie zmniejszać automatycznie gęstości próbkowania. Użytkownik może jawnie zmienić target/rozdzielczość lub zatwierdzić większy budżet obliczeń w konfiguracji badania; proweniencja zapisuje decyzję.
- [ ] Dodać diagnostykę `eta_wave`/`eta_skin` z 0950, zakres ważności oraz źródło `f_max`: sinusoid/cutoff sinc, zadeklarowane pasmo sampled waveform; dla nieznanego pasma zwracać `validity_bandwidth_unknown`.
- [ ] Prostokątny pulse i skok nie mają skończonego idealnego pasma. Nie wyznaczać `f_max` wyłącznie jako odwrotności długości impulsu. Wymagać opisania bandwidth/rise-time lub zwrócić brak oceny.
- [ ] Ostrzeżenia przeliczać przy zmianie waveform, ale nie stawiać przez to bazy jako stale. Dla wielu aktywnych portów oceniać ich pasma i wspólne źródło.
- [ ] Zapisać measured wall time, peak memory, pairs, refined pairs, error i cancellation latency. Dopiero jeśli direct solver nie spełnia potrzeb, zaprojektować oddzielnie kwalifikowany fast operator; samo zwiększenie limitu nie jest optymalizacją.

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

**Pliki:** `antenna_stage.rs`, native charge/field wrappers, CLI `orchestrator.rs` i nowy `antenna_workflow.rs`, standardowy stage execution read-model i artefakty.

- [ ] Przenieść antenową orkiestrację z monolitu do `antenna_workflow.rs`; publiczne wywołanie przyjmuje plan, artifact store i callback postępu/anulowania. Nie przenosić przy tym innych workflows.
- [ ] Sprawdzić cache przed emisją meshing/solving. Cache hit publikuje `ready` z `reused_existing=true` bez fikcyjnego solve.
- [ ] Emitować meshing, solving_current, evaluating_field, projecting_targets dopiero na rzeczywistych granicach wykonania. Jeśli mesh jest wcześniej gotowy, oznaczyć etap jako reuse/skip z przyczyną.
- [ ] Przekazać cancellation token do długich operacji i sprawdzać go między blokami pola T11. Anulowanie nie może opublikować gotowego manifestu.
- [ ] Payloady zapisywać do task-private temporary directory, weryfikować hashe, publikować manifest jako ostatni atomowy krok. Concurrent request tej samej signature deduplikuje lub weryfikuje identyczność wyniku; nie nadpisuje istniejącego assetu.
- [ ] Na failure/cancel zapisać stage stop reason i diagnostykę, zachować poprzedni poprawny immutable wynik. Cleanup usuwa wyłącznie własne niedokończone pliki, nigdy wspólny cache ani explicit output directory.
- [ ] Wykonać resolver stage/output T08; następny stage dostaje resolved reference dopiero po poprawnej publikacji.
- [ ] Zarejestrować outputy w standardowym stage/artifact catalog. Nie ukrywać jedynego wyniku w `.fullmag` historii; zwykły script launch używa publicznego sibling `.zarr` zgodnie z launcherem repo.

Sekwencje testowe:

```text
cache miss: queued -> meshing/reused_mesh -> solving_current -> evaluating_field -> projecting_targets -> ready
cache hit:  queued -> ready(reused_existing=true)
cancel:     evaluating_field -> cancelled; no ready manifest
failure:    solving_current -> failed(reason); no downstream drive
stale:      ready -> stale(reason); old immutable artifact remains readable by its old run
restart:    reload ready manifest -> verify bytes and dependencies -> resolve consumer
```

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

## T14. Domknąć OpenAPI, zasoby i realtime

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

**Stan 2026-09-11:** dedykowane węzły Explorer i routing Inspectora są już podłączone, a `AntennaCompositionPanel` rozwiązuje authored stage/request do właściwych `output_id` i korzysta z typowanych hooków wyników anteny. Węzły `solution` i `spectrum` pokazują stan zasobu (`loading/ready/stale/error/missing`) oraz metadane manifestu; `projection` i `drive` pokazują dostępność opublikowanej bazy pola. Dodano test resolvera identyfikatorów oraz DOM regresję gotowego wyniku. Commit `d48f32cd9` dodaje dekodowanie czterech payloadów `float64_le`, bounded heatmapę `|H(k_u,k_v)|²` z peak/k-grid oraz testy gotowego i błędnego transportu; `cae985d3b` zachowuje kody `missing_payload`/`unsupported_topology` jako jawny błąd Inspectora zamiast maskowania ich jako brak zasobu. Nadal brakuje pełnego browser smoke `create → solve → inspect → stale` i diagnostyki React dla całego workflow.

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
