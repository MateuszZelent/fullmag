# Kwalifikacja refaktoryzacji Physics Scope Graph

Data snapshotu: 2026-08-08
Worktree: `.worktrees/physics-scope-graph-implementation-20260808`
Zakres: authoring/IR/planner/API/Explorer/Inspector oraz kontrolowane kontrakty
FEM CPU.

## 1. Kryterium fizyczne

Brak rekordu `CurrentTransport` oznacza brak źródła prądu i nie tworzy węzła
zależnego STT/SOT/SHE/Oersted. Rekord obecny z napędem równym zero pozostaje
modułem grafu; jego stan aktywacji jest jawny. Żaden z tych stanów nie jest
wnioskowany z długości listy, indeksu obiektu ani wartości `j`.

`applies_to` opisuje obszar działania modułu, natomiast `solve_domain` opisuje
domenę jego PDE. FEM otrzymuje semantic marker identities, a FDM semantic cell
mask identities; nie są one jeszcze certyfikatami konkretnej siatki/gridu.

## 2. Dowód źródłowy i testowy

| Warstwa | Dowód | Wynik | Granica |
|---|---|---|---|
| Fixtures authoringu | sześć scenariuszy w `crates/fullmag-authoring/tests/fixtures/physics_graph/` oraz `scripts/test_physics_scope_graph_fixtures.py` | zielony, 2 testy walidatora | kontrakt semantyczny, bez solvera |
| Python DSL | `PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_physics_scope_graph.py` | 5 passed | brak dowodu runtime FEM/FDM |
| Rust authoring | testy graph contract | zielone w poprzednim checkpointcie | normalizacja, nie h-convergence |
| ProblemIR/planner | `cargo test -p fullmag-plan --test physics_graph_resolution -- --nocapture` | 6 passed | markery/maski są semantic identities |
| API | `cargo test -p fullmag-api router_v2::tests::physics_graph_resource_exposes_thin_normalized_graph_for_supported_scenes -- --nocapture` | 1 passed | odpowiedź cienka, bez pól/siatki |
| API check | `cargo check -p fullmag-api` | zielony, tylko istniejące ostrzeżenia | nie zastępuje browser smoke |
| OpenAPI | walidacja JSON i zgodności wygenerowanych ścieżek | 206/206 | statyczny kontrakt |
| Explorer/Inspector/resource/API frontend | 10 ukierunkowanych plików Vitest, w tym graf zasobów, invalidation, Explorer, selection, wspólny frame inspektora i DOM overview | 312 passed | test uruchomiony z repozytoryjnego cache zależności przez tymczasowe aliasy; pełny typecheck worktree nadal wymaga kompletnego `node_modules` |
| Inspector edit-session/action bar | 3 ukierunkowane suites oraz focused typecheck | 84/84 | SSR/browser proof pozostaje otwarty |
| Runner typed graph provenance | unit + integration test artefaktów | 2/2 | fixture zapisuje plik i wpis w `metadata.json`; brak managed solver capture |
| Graph runtime verifier | `scripts/test_verify_physics_scope_graph_runtime.py` + fixture tests | 10 passed | kontrakt fail-closed, brak przechwyconego artefaktu managed |

Testy Rust i Python wykonano z task-specific targetami Cargo na zarządzanym
storage. W worktree Control Room nie ma kompletnego `node_modules`, dlatego pełny
typecheck worktree i browser smoke pozostają otwarte. Ukierunkowane testy Vitest
wykonano na kodzie worktree z istniejącym repozytoryjnym cache pakietów, bez
instalacji przez sieć i bez kopiowania runtime. Nie jest to jeszcze dowód
uruchomienia produkcyjnego serwera UI.

## 3. API i provenance

Dodano zasób:

```text
GET /v2/sessions/current/model/physics-graph
```

Zwraca on `schema_version`, `scene_revision`, moduły, krawędzie i normalizer
provenance. Nie zwraca topologii ani próbek pól. Mutacje authoringu/spinu
unieważniają klucz zasobu razem z rewizją sceny. Explorer i semantic inspector
korzystają z typed facade/resource layer; komponenty nie budują endpointów
ręcznie.

Planner dopisuje stabilne, tekstowe wpisy `physics_graph.v1` do
`ProvenancePlanIR.notes`, dzięki czemu tożsamość grafu jest obecna w
serializowanym execution planie. Runner dodatkowo zapisuje
`physics/physics_graph_provenance.v1.json` oraz kopię typed payloadu w
`metadata.json.execution_provenance.physics_graph`; payload zawiera rewizję
sceny, rewizję siatki, digest grafu, lane, ID modułów, scope, zależności i semantic
marker/mask IDs. Jest to provenance rozstrzygnięcia semantycznego, nie
certyfikat konkretnej siatki/gridu ani dowód wykonania solvera.

## 4. FEM/FDM i dynamiczny Oersted

Wykonano przez repozytoryjne recepty `just`:

```text
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-m2-affine-contract
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-oersted-oet0-cpu-contract
```

Obie bramy zakończyły się `PASS`; OE-T0 potwierdził 4/4 testy (serial, MPI
`n=1`, MPI `n=2` i byte identity). Są to dowody managed FEM CPU i operatora
RT0/H(div), ale nie dowód integracji RT0 z publicznym solved-current chain.

Aktualizacja 2026-08-08: zarządzany kontrakt
`FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-cpu-only-contract`
zakończył się `PASS` dla transportu, ABI oraz nowego transport→RT0→OE-F1.
Ostatni test wywołuje append-only symbol OE-F1 na tym samym immutable
`ConservativeCurrentView`, sprawdza zgodność `source_view_identity_digest` i
publikuje skończone pole oraz diagnostykę par kwadratury. Jest to wykonywalna
ścieżka natywna CPU/double; nie jest jeszcze dowodem planner/stage→LLG,
kwalifikacji GPU ani produkcyjnego continuum limit.

Aktualny publiczny łańcuch FEM pozostaje:

```text
OhmicPoisson one-way steady
  -> H1/P1 nodal J_charge
  -> regularized tet4 midpoint Biot-Savart
  -> bounded H_oe artifact
  -> FEM LLG plan
```

Jego jawny `source_kind` to
`solved_current_h1_nodal_midpoint_reference`. Kontrakt
`ConservativeCurrentView` RT0/H(div), closure, stage identity i źródłowe
digesty jest teraz realizowany przez append-only RT0/OE-F1 ABI i natywny
adapter. Publiczny planner nadal nie materializuje closure/stage descriptoru,
więc standardowy łańcuch pozostaje bezpiecznie na ścieżce H1/midpoint.

### 4.1 Inwentaryzacja istniejących bram i nowy verifier grafu

W `justfile` istnieją następujące bramy, które są użyteczne jako dowód
realizacji fizyki, ale nie są bramami grafu zakresu:

| Lane/scenariusz | Recepta | Co rzeczywiście sprawdza | Czego nie sprawdza |
|---|---|---|---|
| FDM transient spin | `just verify-fdm-transient-spin-m3-reference` | publiczny Python → ProblemIR → runner oraz kontrolę wznowienia M3 CPU/double | graph ID, scope, pominięcie zależności w runtime |
| FDM SOT/Oersted | `just verify-fdm-prescribed-sot-native-contract`, `just verify-fdm-oersted-native-contract` | natywne kontrakty CUDA/algebry i testy operatora Oersteda | obecność/nieobecność modułu z authoringu |
| FEM steady transport/Oersted CPU | `just verify-fem-steady-transport-cpu-only-contract`, `just verify-fem-oersted-oet0-cpu-contract` | zarządzany build MFEM/hypre i ograniczone kontrakty CPU/MPI | graph revision, zakres modułu i publiczny solved-current chain |
| FEM STT/SOT | `just verify-fem-stt-native-contract`, `just verify-fem-prescribed-sot-native-contract` | natywny ABI oraz ograniczone kroki CPU/GPU | graph IDs i dependency omission |
| FEM↔FDM common-limit/Oersted | `just verify-fem-steady-transport-m2-common-limit-contract`, `just verify-fem-oersted-observable-contract` | profil wspólnego limitu i bounded observable/operator contract | typed provenance grafu |

Powyższe polecenia zostały w tym checkpointcie sprawdzone przez `just
--dry-run`; nie uruchamiano ciężkich obrazów ani kompilacji. Ich obecne
kontrakty nie emitują kompletnego artefaktu z `module_id`, `scope_key`,
`executed_module_ids` i `scene_revision` grafu, więc nie mogą być użyte jako dowód
punktów 1–7 z Task 8.

Dodano dedykowany, lekki verifier
`scripts/verify_physics_scope_graph_runtime.py`. Przyjmuje on fixture grafu
oraz opcjonalny artefakt `fullmag.physics_scope_graph_runtime.v1` i sprawdza:

- dokładny zbiór ID/kind/activation, scope (`global`, `object`, `region`,
  `cross_object`, `unresolved`) i `depends_on`;
- dokładne krawędzie oraz brak aktywnej zależności bez aktywnego źródła;
- lane-specific FEM `fem_marker_ids` albo FDM `fdm_cell_mask_id`, bez
  przenoszenia tożsamości między lane;
- jawne `executed_module_ids`, w tym zakaz wykonania zależnego modułu bez
  wykonania źródła;
- `provenance.scene_revision`, `requested_lane` i `resolved_lane` (verifier
  akceptuje przejściowy alias `graph_revision`, jeśli `scene_revision` nie jest
  jeszcze zapisane).

Testy `scripts/test_verify_physics_scope_graph_runtime.py` obejmują pusty
prąd, authored zero-drive (moduły pozostają `inactive`, ale lista modułów nie
znika), object-local chain, global/cross-object scope, złą scope, brak
provenance i pominiętą zależność. Wynik lokalny: `10 passed` łącznie z
`scripts/test_physics_scope_graph_fixtures.py`. Runner ma już własny
`physics_graph.runtime.v1` artefakt z testem zapisu, ale nie jest on
jeszcze pełnym capture'em `executed_module_ids` wymaganym przez verifier. Brak
managed artefaktu runtime oznacza, że ta brama pozostaje gotowa do użycia, lecz
nie awansuje kwalifikacji solvera w tym snapshotcie.

## 5. Explorer i Inspector

Explorer tworzy gałęzie tylko wtedy, gdy graf ma odpowiednie moduły:

- brak prądu nie tworzy transportu, spinu, torque ani Oersteda;
- moduły object/region są pod właściwym obiektem;
- global/cross-object są emitowane raz w gałęzi globalnej;
- unresolved/unsupported są jawnie diagnostyczne i read-only.

Inspector używa wspólnego `InspectorOverviewFrame` z metrykami, kartą główną,
sekcjami nawigacyjnymi i tokenami `--fm-*`. `PhysicsGraphModuleInspectorPanel`
pokazuje zakres, aktywację, zależności i stan wykonania. Edytory payloadów rodzin
pozostają osobne, ale panele Transport/STT/SOT/SHE/Oersted są już podłączone do
wspólnego edit-session/action bar z kontraktami DOM/accessibility. Pełny SSR i
browser smoke nie zostały wykonane z powodu niekompletnego `node_modules`.

## 6. Otwarte blokery produkcyjne

1. Semantic typed provenance jest zaimplementowane; nadal brakuje certyfikatu
   realizacji marker/mask na konkretnej siatce/gridzie oraz managed rozróżnienia
   `resolved` od `executed_module_ids`.
2. FEM RT0/H(div) musi zostać podłączony z planner/IR do publicznego
   solved-current Oersted i LLG, z closure, direct tetra oracle, kontrolą
   znaku/energii oraz sweepem `h`; natywny CPU adapter jest już dostępny.
3. FDM CPU/GPU i FEM CPU/GPU potrzebują wspólnego benchmarku ze stanem,
   konwencją znaku, `h/dt`, artefaktami i continuum limit; graph nie awansuje
   solvera.
4. Brakuje pełnego managed FDM/FEM graph-runtime gate, który wygeneruje
   artefakty akceptowane przez `verify_physics_scope_graph_runtime.py`, oraz
   live browser/Playwright proof dla pustej sceny, zero-drive, object-local i
   cross-object.
5. Worktree frontend wymaga odtworzenia kompletnego, zgodnego z repozytorium
   środowiska zależności przed typecheckiem, DOM testami i screenshotami.

## 7. Wniosek kwalifikacyjny

Refaktoryzacja semantyczna jest implementacyjnie wykonywalna i ma zielone
kontrakty authoring → planner → API oraz statyczne kontrakty Explorer/Inspector.
Najwyższy uczciwy status całego celu pozostaje jednak:

```text
scope graph / authoring / API / Explorer: reference_executable
FEM bounded solved-current Oersted CPU: development_executable
FEM RT0/OE-F1 native CPU/double contract: development_executable
FEM public planner→LLG RT0, FEM GPU, FDM cross-backend equivalence: semantic_only/open
```

Raport nie zawiera screenshotów ani wygenerowanych artefaktów runtime, ponieważ
nie wykonano wiarygodnego browser smoke ani pełnego graph-runtime fixture gate.
