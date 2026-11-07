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


## Uzupełnienie: tożsamość źródła, podregiony i zgodność

Kontrola loadera na zachowanym syntetycznym artefakcie dwóch Tet4 potwierdziła:
obie oryginalne mapy są akceptowane, zmiana klucza głównego albo region_id
powoduje właściwy ValueError o niezgodności z persisted artifact.
Wszystkie pliki miały identyczne SHA przed i po odczycie; Popen=0 i
gmsh.generate=0. To test samego loadera, nie pełnego Problem/Scene/runtime.

W asset_pipeline.py::realize_shared_fem_domain_mesh mapa region_markers
wiąże geometrię, lecz object_region_markers zapisuje istniejący region_id,
nie etykietę podregionu. SceneObjectRegion ma już owner_object i region_id.
Nie trzeba wynajdywać nowej tożsamości podregionu.

persistence.py::_semantic_manifest_sha256 obejmuje nazwy i markery obu
map. _validate_certification_receipt sprawdza ich zgodność z receipt v2.
Przepisanie map po rename bez nowego kontraktu zrywa ten dowód.
Odrębnym kandydatem są bindingi do istniejącego RegionRef/RegionRefIR,
przy niezmienionych mapach źródła; nie zostały wdrożone.

Dodatkowa luka jest wcześniejsza: ScriptBuilderGeometryEntry nie przenosi
istniejącego object_id magnetyka. scene_object_from_geometry odtwarza ID z
name. Publiczne rewrite overrides poprawnie dopisuje ID sceny mimo braku
pola w typowanym builderze; ta ścieżka nie jest potwierdzonym błędem.
Python dict builder i Scene to pole już mają. Osobny, niewdrożony patch i plan:
[Zachowanie object_id](2026-11-07-magnetic-object-id-roundtrip-implementation.md).

Obecny publiczny writer to IR 0.3.0. ADR0024 wymaga atomowego cutoveru
obiektów i mesh policy na V04, a problem-ir-compatibility-v1 wymaga
wersjonowania zmiany znaczenia. Nie dodajemy po cichu nowej semantyki
bindingów do starego IR; jego deserializator ignoruje nieznane pola.
Zachowanie istniejącego domain_mesh i dodanie nowej semantyki wiązania
są odrębnymi wymaganiami, oba nadal otwarte.

Przez GitHub API sprawdzono również master
e8e0d35cb7da697207b490f9573cb2fb7f646e97, siedem commitów po lokalnie
zintegrowanym eeb1e1fcf6070021ac902ee8ecb01268e2cea9b9. Publiczny writer
i brak pola ID pozostają tam takie same. Był to odczyt przypiętych źródeł;
nie jest dowodem fetch ani scalenia tego nowszego mastera z worktree.

Dowody: verification/antenna-authoring-roundtrip-20261107/domain-marker-binding-audit-v2/
w prywatnym control volume:
- plan.json: a0034ff2ee809020cd3f22341efb7c3fff68dc31ad5044bc44dec2c1bbd007ea
- audit.py: 7d4b9ac62a8e08a7abd71a6b3ec2fd19653e5bd22d23ef33947491726bf2baab
- result.json: d4bd35ffb883a740f6c1f95818a28f8c117a60db0cde0e1bbf1b0c5929076de1
- manifest.json przypina artefakty i rzeczywiste źródła.
Wersja v1 przerwała się na błędzie cytowania skryptu przed importami;
zachowano jej kod i failure.json. V2 naprawia wyłącznie ten błąd helpera.
