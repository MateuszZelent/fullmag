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
serializowanym execution planie. Publiczny `TransportExecutionProvenance` dla
FEM nadal ma przede wszystkim bounded Oersted field/source/mesh digests. Nie
udajemy, że obecny runner ma już osobne, typed RT0 graph certificate.

## 4. FEM/FDM i dynamiczny Oersted

Wykonano przez repozytoryjne recepty `just`:

```text
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-m2-affine-contract
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-oersted-oet0-cpu-contract
```

Obie bramy zakończyły się `PASS`; OE-T0 potwierdził 4/4 testy (serial, MPI
`n=1`, MPI `n=2` i byte identity). Są to dowody managed FEM CPU i operatora
RT0/H(div), ale nie dowód integracji RT0 z publicznym solved-current chain.

Aktualny publiczny łańcuch FEM pozostaje:

```text
OhmicPoisson one-way steady
  -> H1/P1 nodal J_charge
  -> regularized tet4 midpoint Biot-Savart
  -> bounded H_oe artifact
  -> FEM LLG plan
```

Jego jawny `source_kind` to
`solved_current_h1_nodal_midpoint_reference`. Kontrakt przyszłego
`ConservativeCurrentView` RT0/H(div), closure, stage identity i źródłowe
digesty jest opisany w §4.6 noty 0980, ale nie został przedstawiony jako
zaimplementowany ABI.

## 5. Explorer i Inspector

Explorer tworzy gałęzie tylko wtedy, gdy graf ma odpowiednie moduły:

- brak prądu nie tworzy transportu, spinu, torque ani Oersteda;
- moduły object/region są pod właściwym obiektem;
- global/cross-object są emitowane raz w gałęzi globalnej;
- unresolved/unsupported są jawnie diagnostyczne i read-only.

Inspector używa wspólnego `InspectorOverviewFrame` z metrykami, kartą główną,
sekcjami nawigacyjnymi i tokenami `--fm-*`. `PhysicsGraphModuleInspectorPanel`
pokazuje zakres, aktywację, zależności i stan wykonania. Edytory payloadów rodzin
pozostają osobne. Pełna migracja wspólnego action bar/edit-session dla każdego
panelu oraz DOM/browser proof są jeszcze bramą UI, a nie wykonanym faktem.

## 6. Otwarte blokery produkcyjne

1. Typed runtime provenance musi przejąć graph module ID, scope, scene/mesh
   revision i certyfikat realizacji marker/mask; obecne notes są warstwą
   kompatybilności.
2. FEM RT0/H(div) musi zostać podłączony do publicznego solved-current Oersted
   z closure, direct tetra oracle, kontrolą znaku/energii oraz sweepem `h`.
3. FDM CPU/GPU i FEM CPU/GPU potrzebują wspólnego benchmarku ze stanem,
   konwencją znaku, `h/dt`, artefaktami i continuum limit; graph nie awansuje
   solvera.
4. Brakuje pełnego managed FDM graph-runtime gate i live browser/Playwright
   proof dla pustej sceny, zero-drive, object-local i cross-object.
5. Worktree frontend wymaga odtworzenia kompletnego, zgodnego z repozytorium
   środowiska zależności przed typecheckiem, DOM testami i screenshotami.

## 7. Wniosek kwalifikacyjny

Refaktoryzacja semantyczna jest implementacyjnie wykonywalna i ma zielone
kontrakty authoring → planner → API oraz statyczne kontrakty Explorer/Inspector.
Najwyższy uczciwy status całego celu pozostaje jednak:

```text
scope graph / authoring / API / Explorer: reference_executable
FEM bounded solved-current Oersted CPU: development_executable
FEM RT0 end-to-end, FEM GPU, FDM cross-backend equivalence: semantic_only/open
```

Raport nie zawiera screenshotów ani wygenerowanych artefaktów runtime, ponieważ
nie wykonano wiarygodnego browser smoke ani pełnego graph-runtime fixture gate.
