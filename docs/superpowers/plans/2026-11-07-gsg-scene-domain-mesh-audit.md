# GSG: utrata jawnej siatki domeny przez scenę — audyt 07.11.2026

## Wynik i granice

Potwierdzono utratę authoringu jawnej domeny FEM w trasie Python → typowana
scena → canonical Python. Zwykły Python → canonical Python zachowuje pełne IR.
Naprawione flagi wykonania przechodzą obiema trasami. Nie wykonano meshowania,
solvera ani zmiany projektu użytkownika; nie kwalifikujemy wyniku V/J/H
na podstawie tego audytu.

To wewnętrzna diagnoza istniejącej semantyki, zgodna z zakresem odczytowym
scientific-documentation-contract. Nie wdraża nowego schematu ani metody
fizycznej i nie stanowi gotowej do publikacji noty naukowej.

## Wejścia i odtwarzalny dowód

| Wejście zachowane | SHA256 |
|---|---|
| gsg_junction_prepare_50nm.py | 6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050 |
| gsg_junction_prepare_corner25nm.py, projekt niewdrożony | d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148 |

Użyto bieżących źródeł Python w istniejącym backendzie grupy 3203,
z lightweight_assets=True, include_geometry_assets=False i jawnym source_root.
To dowód ścieżki źródłowej; nowy pakiet natywny nie jest wdrożony.
Guardy subprocess.Popen oraz gmsh.model.mesh.generate miały po zero wywołań.
W obu wejściach wykonano dwie trasy: render_loaded_problem_as_script oraz
build_scene_document_from_builder → render_scene_document_as_script.
Porównanie obejmuje wszystkie klucze, typy bool, długości i kolejność list;
tylko dla liczb obowiązuje wcześniej ustalona tolerancja względna 5e-12,
bezwzględna 0. Nie usunięto różnic z surowego wyniku.

| Trasa, oba wejścia | Pełne IR | Mesh workflow | Flagi etapów/workspace |
|---|---|---|---|
| Python → canonical Python | PASS | identyczny | identyczne |
| Python → scena → canonical Python | FAIL | utrata jawnego źródła | identyczne |

## Potwierdzona przyczyna

Obie deklaracje study.domain_mesh zachowują źródło
gsg-convergence-targets.fullmag-mesh i jawnie pustą mapę regionów magnetycznych.
Po przejściu przez scenę znikają domain_mesh_mode, domain_mesh_source
i domain_region_markers; build_target zmienia się z domain na mesh.
Dotyczy to głównego mesh_workflow i jego odbicia w model_builder.problem.

ScriptBuilderState i SceneStudyState nie mają typowanego odpowiednika tych
danych. Python exporter sceny i oba adaptery Rust zachowują ustawienia rozmiaru,
lecz nie źródło tej domeny z mapami markerów. Autor modelu UI także nie publikuje
tej deklaracji w discretization_payload. To potwierdzona utrata intencji;
nie uruchomiono zmienionej sceny, więc nie zmierzono jej skutku runtime.

Dalsze różnice to zmiana pomocniczej nazwy geometrii sampling na etykietę
Co/Ni field sampling oraz addytywne metadane pipeline. Nie utożsamiamy ich
automatycznie ze zmianą fizyki; pozostają jawnie w surowym porównaniu.

## Mapa właścicieli i zakres naprawy do zaprojektowania

| Plik + symbol | Odpowiedzialność |
|---|---|
| packages/fullmag-py/src/fullmag/world.py::domain_mesh | kanoniczne źródło oraz region_markers/object_region_markers |
| packages/fullmag-py/src/fullmag/world.py::_normalize_domain_region_marker_table | normalizacja i obecna walidacja map |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py::_study_global_mesh_config | zachowuje źródło w eksporcie zwykłego skryptu |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py::_render_domain_mesh_call | emituje właściwe study.domain_mesh |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py::_export_fem_domain_mesh_reference | odrębny kontrakt native pinned mesh |
| packages/fullmag-py/src/fullmag/runtime/scene_document.py::build_scene_document_from_builder / build_builder_from_scene_document | obecna granica utraty |
| crates/fullmag-authoring/src/builder.rs::ScriptBuilderState | typowany builder |
| crates/fullmag-authoring/src/scene.rs::SceneStudyState | typowana scena |
| crates/fullmag-authoring/src/adapters.rs | oba adaptery i override do renderera |
| crates/fullmag-authoring/src/authoring_model.rs::discretization_payload | model authoringu/revizji UI |

Istniejące fem_domain_mesh {source, sha256, build_requested} odtwarza
study.mesh.load, a nie study.domain_mesh. Nie wolno użyć go jako pojemnika
na brakujące mapy. Specyfikacja docs/specs/mesh-roundtrip-semantics-v1.md
oddziela native reuse od innych deklaracji i importów.

Właściwa naprawa musi przechować jawne źródło oraz obie mapy przez te same
granice authoringu, zachować pustą mapę dla obserwacyjnej domeny field-only,
zachować stare dokumenty i określić zachowanie usunięcia/zmiany źródła.
Wymaga osobnego, przejrzanego projektu addytywnego kontraktu; nie dodano pola
na próbę i nie zmieniono markerów, przygotowania, tożsamości nośnika lub SI.
Brak nowego kontraktu nie usprawiedliwia zastąpienia domeny innym meshem.

## Artefakty

Control volume: verification/antenna-authoring-roundtrip-20261107/real-gsg-inputs-v1/.
Uruchomienie w tym samym backendzie: python3 -B <ten-katalog>/audit.py.
Ponowne uruchomienie powinno użyć nowego katalogu dowodów; starych nie nadpisywać.

| Artefakt | SHA256 |
|---|---|
| audit.py | 0690c2e33f01930d6b07cab1ed16887b99cb4ab8c77bc41ab7e480a167c5c285 |
| plan.json | d52709ed1b5912694ffee48820c232356b356c1d0a0cbff85ea5bc107c69ae22 |
| result.json | e0f7f428cc7f24119f608224b0e234f98f9a66074da871128d8f468e57dc8163 |

FDM CPU/GPU i FEM CPU/GPU nie były wykonywane. Sprawdzono wspólny tor
authoringu na wejściu FEM CPU/double; nie jest to kwalifikacja solvera ani
dowód odtworzenia publikacji.
