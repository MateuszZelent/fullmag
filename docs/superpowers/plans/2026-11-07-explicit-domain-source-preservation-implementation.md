# Zachowanie jawnej domeny FEM przez Python i scenę — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Odtworzyć ten sam zadany mesh i bieżący model fizyczny po Python → builder → SceneDocument → eksport Python, bez utraty źródła, map, kluczy geometrii i kontroli właścicieli.
**Architecture:** Zachować już istniejące rozdzielenie object_id, nazwy prezentacyjnej i klucza geometrii w V03. Dodać typowaną deklarację źródła do wspólnego authoringu oraz eksportowalną asercję właścicieli, która wyłącznie sprawdza istniejące przypisanie i nigdy go nie zmienia. Nie dodawać wykonywalnego marker_bindings ani nie przełączać writera IR.
**Tech Stack:** Python DSL i unittest, Rust serde/fullmag-authoring, istniejące API v2, obecny workflow bootstrap.
**Spec:** [Projekt źródła domeny i diagnoza](2026-11-07-explicit-domain-mesh-roundtrip-proposal.md), [mesh roundtrip](../../specs/mesh-roundtrip-semantics-v1.md), [ADR0024](../../adr/0024-compositional-physics-object-model.md), [ADR0027](../../adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md), [zatwierdzony projekt domen](../../../.superpowers/brainstorm/2026-11-02-antenna-magnetic-domains/design.md).
**Status:** PRZEJRZANY; OCZEKUJE DECYZJI UŻYTKOWNIKA. Nowe parametry i pola poniżej są proponowane, nie wdrożone. Naprawione wcześniej object_id i lookup właściciela podregionu są osobnymi warunkami koniecznymi. Ten etap nie kończy E0–E12, wspólnej siatki antena/LLG ani reprodukcji publikacji.

## Global Constraints

- Istniejący worktree anten, bieżący branch i 63 chronione wpisy indeksu; żadnego nowego worktree lub bezpośredniego push do mastera.
- Jeden Python DSL, jeden bieżący ProblemIR 0.3.0, istniejący field store, API v2 i klient typowany. Żadnego drugiego modelu fizyki lub endpointu.
- Bez nowego Solve, Gmsh generation, prepare-only, native buildu, restartu, recovery, zwalniania rezerwacji i modyfikacji wyników.
- Lekkie testy w istniejącej grupie Docker; kompilacja testów Rust wyłącznie przez dotychczasową autoryzowaną ścieżkę CI.
- Źródłowe mapy, pliki meshu, build_report, receipt, certyfikaty i hashe pozostają niezmienione.
- ProblemIR V04, zmiana polityki meshu, przenoszenie danych i egzekwowanie historycznego ownera przy dowolnej edycji wykonywalnego IR są poza tym etapem i pozostają otwartymi wymaganiami.
- FDM CPU/GPU: zgodność dotychczasowych modeli; jawna domena FEM nadal niedopuszczalna. FEM CPU/GPU: wspólna semantyka authoringu; testy nie kwalifikują solverów ani urządzeń.
- Kod, komentarze i commity po angielsku; dokumenty i raport po polsku.

## Review Focus

1. Zmiana nazwy przy stałym ID zachowuje geometry key, także wewnątrz Translate/CSG.
2. Usunięcie właściciela i nowy obiekt o dawnej nazwie nie legalizują starej asercji; brak lub zmiana ID daje odmowę.
3. ID podregionu ma pierwszeństwo przed aliasem, również gdy wskazuje wyłączony region; kolizja aliasu z nowym ID nie przekierowuje markera.
4. Reset generated różni się od braku starego pola i Merge Patch null; niezwiązana edycja nie usuwa źródła.
5. Źródło siatki nie daje nowego grantu plikowego; brak pliku, obcy digest lub niezgodne mapy nadal odmawiają bez zastępczego meshowania.

Każdy z tych przypadków ma test w T1, T2 lub T3. Nie traktować nieznanego elementu jako pustej mapy, zera lub domyślnego Box.

## Zdefiniowany zakres gwarancji

Asercja authoringu oznacza: „niezmieniony wpis źródłowej mapy nadal rozwiązuje się w bieżącym modelu do oczekiwanego RegionRef”. Nie jest remapowaniem ani nowym modelem siatki. Po poprawnym lowering bieżący IR zawiera rzeczywiste geometrie, obiekty, regiony i niezmienione mapy; ten sam zaakceptowany IR można odtworzyć.

V03 nie przechowuje historii poprzedniego ownera jako obowiązkowego wykonywalnego bindingu. Bezpośrednio zmieniony IR jest nowym wejściem: nie wolno twierdzić, że ten plan odrzuci je na podstawie nieobecnej historii. Taka gwarancja wymaga typowanego kontraktu i atomowej granicy V04 z obu ADR. Nie dodawać pozornie obowiązkowego pola do runtime_metadata i nie reklamować ochrony wszystkich runtime.

Capture asercji następuje tylko przy pierwszym przyjęciu kompletnego starego wejścia do nowej reprezentacji authoringu. Od tej chwili oczekiwane ID są przechowywane i eksportowane literalnie. Refresh, rename i ponowny import zapisanej nowej sceny nie wykonują capture ponownie. Import samego dawnego IR może utworzyć asercję bieżącego snapshotu, lecz nie odzyskuje historii, której w nim nie ma.

Legacy object_id=name nie dowodzi historii utworzenia/usunięcia. Początkowe przyjęcie ma jawnie utrwalić bieżące ID w eksporcie; gwarancja dotyczy zmian po tym przyjęciu. Rozmyślne ponowne użycie tego samego jawnego ID nie jest wykrywalne jako „inny obiekt” na podstawie samego ID i nie jest dodatkową obietnicą tego etapu.

## Proponowane interfejsy i parametry

### Tożsamość geometrii

Nowy keyword geometry_name: str | None = None w world.geometry, world.geometry_object, world.antenna_object oraz odpowiadających metodach StudyBuilder, w tym conductor. Brak zachowuje obecne reguły: magnetyk name + "_geom", auxiliary name. Jawna wartość jest istniejącym kluczem geometrii, nie etykietą; niepusty tekst bez otaczających spacji, bez automatycznego trim lub zamiany na object_id.

ScriptBuilderGeometryEntry.geometry_name i SceneGeometry.geometry_name: Option<String>, brak dla starych dokumentów. Nowy eksport zachowuje rzeczywisty klucz. Etykieta auxiliary jest odrębnie zachowywana w proponowanych _WorldState._auxiliary_geometry_names i Problem.auxiliary_geometry_names (mapa geometry key → nazwa, default pusta z dotychczasowym fallbackiem).

physics_graph.objects[].name i physics_objects[].name pochodzą z etykiety; geometry_id pozostaje kluczem. Nie zmieniać object_id ani aktywować modułów na podstawie nazwy/type. Wszystkie nowe dane mają jednostkę 1. Nie zmieniać wymiarów, transformacji lub układu SI.

Pełny descriptor geometry_params zachowuje nazwę kształtu przez pole name, także w zagnieżdżonych descriptorach. Wewnętrzne Translate pozostają pełnymi węzłami drzewa: nie spłaszczać ich do jednej pozycji translation i nie nadpisywać poprzedniego offsetu. Jedynie jeden transform ownera sceny może być wyodrębniony zgodnie z dotychczasowym modelem sceny; jego złożenie z drzewem zachowuje kolejność. Renderer nie zastępuje nazw dzieci etykietą ownera. Użyć istniejących publicznych konstruktorów; nie tworzyć drugiego języka geometrii.

Jawne geometry_name musi być jednoznaczne w całym modelu: magnetyk–magnetyk, auxiliary–auxiliary i magnetyk–auxiliary. Sprawdzić wszystkie rzeczywiste klucze, również klucze uzyskane przez legacy default pozostałych obiektów. Różne display name lub object_id nie legalizują kolizji. Odmowa następuje przed lowering/materializacją, również w all-air z pustymi mapami. Zachować walidację konstrukcji class-based i obu adapterów; nie polegać wyłącznie na sprawdzeniu tabeli markerów.

### Deklaracja źródła

Jedno opcjonalne shared_domain_mesh_source w ScriptBuilderState i SceneStudyState, o tym samym typowanym kształcie:

~~~text
{"kind": "generated"}
{"kind": "explicit", "source": "...fullmag-mesh",
 "region_markers": [{"geometry_name": "track_geom", "marker": 1}],
 "object_region_markers": [{"geometry_name": "core-id", "marker": 2}],
 "marker_owners": [
   {"table": "region_markers", "geometry_name": "track_geom", "marker": 1,
    "target": {"object_id": "immutable-track"}},
   {"table": "object_region_markers", "geometry_name": "core-id", "marker": 2,
    "target": {"object_id": "immutable-track", "region_id": "core-id"}}
 ]}
~~~

| Pole | Typ / default | Walidacja i znaczenie |
|---|---|---|
| Brak całej deklaracji | legacy | Brak nadpisania źródła przy script-backed export; scratch bez zewnętrznej domeny |
| kind | generated lub explicit | generated odrzuca wszystkie pola wariantu explicit |
| source | String, required explicit | Dotychczasowy canonical path/resolver; bez NUL i pustego tekstu; nie nowy grant |
| region_markers | Vec dotychczasowych markerów | Wymagane także gdy jawnie puste; pusta mapa tylko dla obecnego all-air field-only |
| object_region_markers | opcjonalna Vec | Zachować brak versus deklarację; istniejące reguły dodatnich markerów i kolizji |
| marker_owners | Vec, required w nowej explicit deklaracji | Dokładnie jeden rekord na każdy wpis obu map; [] tylko przy obu pustych |
| table | region_markers lub object_region_markers | Rozróżnia znaczenia literalnych kluczy map |
| geometry_name | String | Literalny klucz źródłowej mapy; nie bieżąca nazwa prezentacyjna |
| marker | u32 > 0 | Ten sam marker co w wskazanej tabeli; bool, float, overflow i duplikaty odrzucane |
| target | istniejący RegionRef | Root: jawne object_id bez region_id; podregion: jawne object_id i region_id |

Wszystkie ID/mapy/markery mają jednostkę 1. Obecne granice serializacji, tolerancje i budżety nie rosną. Brak/null/nieznane pola wariantu explicit są błędami nowej deklaracji. W starym Python domain_mesh brak nowego marker_owners zachowuje legacy; inicjalny importer tworzy asercję tylko z kompletnego zaakceptowanego modelu. Nie tworzy jej z nazw samych artefaktów.

Nowy opcjonalny keyword marker_owners w obu dotychczasowych domain_mesh. Publiczny Python przyjmuje rekordy ze statycznym target fm.RegionRef; capture zamienia je na powyższy JSON, a renderer odtwarza RegionRef. Nie dodawać dynamicznego capture() do eksportowanego skryptu: ponowny import musi sprawdzić zapisane oczekiwania.

Generated usuwa tylko wybór źródła domeny, mapy i jego asercję; zachowuje recipe Universe/object, native fem_domain_mesh i wyniki. Merge Patch null usuwa klucz, przywracając znaczenie legacy braku nadpisania; reset musi wysłać generated.

## T1. Bezstratna tożsamość geometrii i jej etykiety

**Files:** world.py; model/problem.py; model/physics_scope.py; runtime/script_builder.py; runtime/scene_document.py w packages/fullmag-py/src/fullmag; crates/fullmag-authoring/src/{builder.rs,scene.rs,adapters.rs,validation.rs}; testy i pełne inicjalizatory tych typów w API; docs/specs/mesh-roundtrip-semantics-v1.md; docs/physics/0105-fem-meshing-production-acceptance.md i adjacent source-map.

**Interfaces:** geometry_name według tabeli; istniejące funkcje export_builder_draft, build_scene_document_from_builder, build_builder_from_scene_document i render_scene_document_as_script zachowują klucz i etykietę. Nowe mapy etykiet nie są źródłem solver physics.

- [ ] Napisać packages/fullmag-py/tests/test_geometry_asset_identity.py: jawny/legacy klucz, identyczne ID po rename, auxiliary label różny od geometry_id w obu producentach graph, dwa obiekty o różnych kluczach, Translate i nazwane dzieci CSG. Dodać osobno Translate(Translate(Box(name=inner), a, name=mid), b, name=outer) z różnymi niezerowymi a i b, oraz trzy kolizje globalnych kluczy przy różnych label/ID. Porównać pełne geometry.entries, oba offsety i referencje; nie tylko liczby elementów.
- [ ] Uruchomić te testy przed poprawką w obecnym backendzie; wymagany RED na utracie klucza/nazwy, bez setup failure.
- [ ] Uzupełnić notę 0105, tabelę parametrów i mapę Python→V03, source anchors oraz failure/compatibility. Nie duplikować równań meshu; żadne nowe równanie nie jest potrzebne.
- [ ] Zaimplementować przeniesienie istniejącego klucza w publicznym DSL, obu exporterach i obu adapterach Rust. Nie przepisywać istniejących ID. Przy tworzeniu per_geometry intent dla jawnego geometry_name użyć rzeczywistego klucza; przy odczycie legacy zachować dotychczasowy lookup aliasów i precedence.
- [ ] Dodać Rust testy geometry_asset_identity_ dla JSON, rename, overrides, starego braku pola i pustej wartości. Uzupełnić wszystkie pełne inicjalizatory; nie osłabiać walidacji materiału/roli.
- [ ] GREEN: nowe Python testy i dotychczasowe object_id/mesh-by-id/owned-region testy; Rust wyłącznie CI. Focused scientific validator/source-map i kontrakty dokumentacji. Commit dopiero dla spójnego pionowego slice'u, bez cudzych hunków.

## T2. Źródło domeny i asercja przez cały authoring

**Files:** nowe packages/fullmag-py/src/fullmag/runtime/domain_mesh_source.py i crates/fullmag-authoring/src/domain_mesh_source.rs; istniejące world.py, model/problem.py, runtime/script_builder.py, runtime/scene_document.py; Rust lib.rs, builder.rs, scene.rs, adapters.rs, validation.rs, authoring_model.rs; istniejące schema/projekcja API i fixture inicjalizatory; testy T2; nota 0105/spec/source-map.

**Interfaces projektowane:** Python normalize_shared_domain_mesh_source(value) -> dict, capture_domain_marker_owners(problem) -> list[dict], validate_domain_marker_owners(problem, owners) -> None. Rust ScriptBuilderSharedDomainMeshSource, ScriptBuilderDomainMarkerOwner oraz validate_shared_domain_mesh_source(source, objects) -> Result<(), SceneDocumentValidationError>. Typ enum jest współdzielony przez builder i scenę, nie kopiowany do osobnych DTO.

- [ ] Napisać packages/fullmag-py/tests/test_explicit_domain_roundtrip.py oraz testy Rust shared_domain_source_: brak/generated/explicit, reset, oba rodzaje map, kompletność owners i błędne typy. Wspólny fixture JSON w crates/fullmag-authoring/tests/fixtures/domain_marker_owner_cases.json ma identyczne oczekiwane wyniki w obu językach.
- [ ] RED obejmuje rename przy ID, usunięcie i nowego ownera pod dawną nazwą, alias regionu po rename, alias kolidujący z innym region_id, wyłączony ID z aktywną nazwą oraz brak coverage. Nie zastępować aliasu nowym kluczem mapy.
- [ ] Wykonać initial capture tylko na kompletnym modelu przy przyjęciu starego wejścia. Nowa scena z marker_owners zachowuje je literalnie. Nowy model/scratch/import bez materiału lub jednoznacznych właścicieli ma odmówić, nie zgadywać. Dla all-air GSG legalne są puste mapy i owners=[].
- [ ] Zaimplementować asercję po zebraniu wszystkich obiektów i regionów przed każdym lowering/materializacją, także include_geometry_assets=False. Root geometry musi mieć dokładnie jednego ownera; podregion używa ID przed aliasem tak jak obecny resolver Rust, z owner_object zgodnym z RegionRef.
- [ ] Przenieść deklarację przez capture, builder, scenę, overrides i renderer domain_mesh. Eksportować statyczne rekordy fm.RegionRef, nigdy bieżące ponowne rozwiązanie oczekiwanego ID. Bez nowego pola FemDomainMeshAssetIR.
- [ ] Włączyć deklarację do authoring_model.rs::discretization_payload i istniejącej rewizji/fingerprint. Niezwiązany patch musi zachować source/owners. Zmiana źródła unieważnia przygotowanie przez obecny mechanizm, bez zmiany archiwalnych wyników.
- [ ] Testować pełną scenę i API projection/persistence, w tym Merge Patch null versus generated. Nie dodawać nowego endpointu lub edytora JSON. Stary native fem_domain_mesh nadal oznacza study.mesh.load i nie przejmuje nowego pola.
- [ ] GREEN i commit całej spójnej ścieżki T2 razem. Nie publikować częściowego writera, który zapisuje pole, lecz pomija je w eksporcie lub walidacji.

## T3. Odbiór rzeczywistych wejść i bramki integracji

**Files:** testy T1/T2, .github/workflows/bootstrap.yml, istniejący audyt GSG, nowy raport docs/superpowers/plans/2026-11-07-explicit-domain-roundtrip-result.md; nowy test integracyjny crates/fullmag-authoring/tests/explicit_domain_python_roundtrip.rs i jego most packages/fullmag-py/tests/explicit_domain_roundtrip_bridge.py; małe, przypięte źródła wejściowe w crates/fullmag-authoring/tests/fixtures/explicit_domain_roundtrip/ (50nm.py, corner25nm.py, manifest.json).

**Interfaces:** publiczny loader/exporter oraz oba adaptery Rust. Test Rust uruchamia testowy most Python przez stdin/stdout JSON, najpierw export_builder, potem po rzeczywistym przejściu przez adaptery Rust render_and_reimport. Most używa istniejących publicznych funkcji i nie jest nowym endpointem lub narzędziem wykonującym solver. Zwraca pełny IR, flagi/stages i liczniki blokad. Istniejące dane real-gsg-inputs-v1 są bazą porównania, nie dowodem nowych PASS.

- [ ] Dodać do istniejącego kroku roundtrip CI oba nowe pliki Python i prefiksy Rust; nie tworzyć zastępczego solwera lub nowej trasy buildu.
- [ ] Uruchomić rzeczywisty GSG oraz zachowany kandydat corner25 wyłącznie jako wejścia authoringu, z lightweight_assets i aktywnymi blokadami Popen/Gmsh generation/Solve. Nie stosować kandydata do wykonania i nie zmieniać jego zamrożonych bajtów.
- [ ] Porównać source, obie mapy, build_target=domain, pełny fizyczny IR i liczbę/parametry etapów. Zastosować wyłącznie ścisłą listę ścieżek i oczekiwanych wartości z sekcji poniżej. Nie ignorować geometry, IDs, materiałów, assetów lub fizyki.
- [ ] Dla syntetycznego już zapisanego artefaktu wykonać istniejący loader po rename przy trwałych kluczach; potwierdzić te same mapy, topologię i hashe pliku. Przypadek legacy alias drift ma odmówić przed materializacją. Bez tworzenia nowego meshu.
- [ ] Sprawdzić stary builder/scenę, FDM CPU/GPU authoring oraz FEM CPU/GPU requested intent. Ten test nie jest dowodem wykonania czterech backendów.
- [ ] Przeczytać rzeczywiste wyniki CI, przeprowadzić review całego diffu i selektywnie commit/push. Zaktualizować raport oraz status E12 bez utożsamiania source-contract PASS z runtime/science/UI E2E.

## Konkretne kontrole zadań

Polecenia Python poniżej wykonuje istniejący backend grupy zadania z checkoutem
jako source root i PYTHONPATH wskazującym packages/fullmag-py/src. To testy
interpretera; nie uruchamiać hostowego buildu. Polecenia Cargo wykonuje wyłącznie
istniejący krok bootstrap rust-contracts w GitHub CI, nigdy lokalnie.

T1:
~~~text
python -B -m unittest discover -s packages/fullmag-py/tests -p test_geometry_asset_identity.py -v
cargo test --locked -p fullmag-authoring --lib geometry_asset_identity_
~~~

T2:
~~~text
python -B -m unittest discover -s packages/fullmag-py/tests -p test_explicit_domain_roundtrip.py -v
cargo test --locked -p fullmag-authoring --lib shared_domain_source_
~~~

T3, ciągły most obu języków, wyłącznie w GitHub CI:
~~~text
cargo test --locked -p fullmag-authoring --test explicit_domain_python_roundtrip -- --nocapture
~~~

Fixture zawiera dokładne bajty dwóch zamrożonych skryptów i ich SHA256:
50 nm 6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050,
corner25 d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148.
Nie wymaga dostępu CI do prywatnego wolumenu komputera użytkownika. Most
przyjmuje ścieżki fixture wewnątrz repo, blokuje generowanie siatki i Solve,
używa lightweight_assets i include_geometry_assets=False. Test loadera
rzeczywistego zachowanego meshu pozostaje osobną odczytową kontrolą w backendzie;
nie tworzyć jego zastępczej wersji wyłącznie dla zielonego CI.

Nowe nazwane regresje i wymagane asercje:

| Zadanie / test | Asercja |
|---|---|
| T1 test_geometry_key_survives_display_rename | geometry.entries[].name i object_id identyczne; zmienia się wyłącznie etykieta i jawne referencje do etykiety, jeśli model je posiada |
| T1 test_auxiliary_label_is_not_geometry_id | label=GSG antenna, geometry_id=antenna, object_id=immutable-A we wszystkich producentach i po eksporcie |
| T1 test_translated_csg_preserves_child_names | pełne geometry.entries przed/po równe, łącznie z nazwami base/tool i transformacją |
| T1 test_nested_translates_preserve_both_offsets | inner/mid/outer i odrębne offsety a=(1e-9,2e-9,3e-9), b=(-4e-9,5e-9,6e-9) identyczne po obu adapterach; nie tylko suma lub bounds |
| T1 test_geometry_key_collision_is_rejected_globally | trzy pary ról przy różnych name/object_id odmawiają przed wywołaniem materializatora, również w all-air |
| T1 test_absent_geometry_name_keeps_legacy_default | magnetyk track_geom i auxiliary track zgodnie z dotychczasowym DSL |
| T2 test_owner_assertion_rejects_recreated_display_name | stary target immutable-A nie akceptuje nowego immutable-B mimo tej samej etykiety; materializator nie jest wywołany |
| T2 test_disabled_id_does_not_fall_back_to_alias | wyłączony region_id=core blokuje marker core mimo aktywnego innego regionu o name=core |
| T2 test_new_region_id_cannot_capture_old_alias | dawny alias core do r-1 nie przechodzi po dodaniu region_id=core przy innym ownerze |
| T2 test_generated_reset_differs_from_null | generated usuwa source/maps/owners; usunięty przez Merge Patch klucz oznacza legacy brak override |
| T2 test_unrelated_patch_preserves_source_and_owner_assertions | literalne mapy, kolejność, source i raz zapisane targety identyczne po niezwiązanej edycji |
| T3 test_gsg_scene_export_preserves_explicit_domain | oba rzeczywiste zamrożone wejścia zachowują domain source/maps/build_target, fizyczny IR i etapy przy zerowym liczniku Gmsh/Solve |

Dla nazwanych testów Rust zastosować odpowiednie prefiksy z powyższych poleceń
i te same fixture przypadków. Testy API w istniejącym module persistence mają
dodatkowo objąć niezwiązany patch i obecne native fem_domain_mesh razem z nową
deklaracją; zachować oba wybory, jeżeli kombinacja była dopuszczalna.

T1/T2 dokumentacja:
~~~text
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0105-fem-meshing-production-acceptance.source-map.json --repo-root .
python -B -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p "test_*.py"
python -B .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base <przypięty-base-SHA> --head HEAD --repo-root .
~~~

W T3 wykonać ten sam test realnych wejść po obu adapterach Rust przez istniejącą
kompilowaną ścieżkę CI; test samych helperów Python nie zalicza Rust/API.
Nowe testy powinny najpierw wykazać RED dotyczący utraty danych, a GREEN wymaga
exit 0, zera nieoczekiwanych skip oraz odczytu wszystkich asercji.
Pełnego fizycznego IR nie redukować do wybranego snapshotu kilku kluczy.

## Ścisła lista nowych pól i porównanie semantyki T3

Nie usuwać całego model_builder lub runtime_metadata z porównania.
Dla identycznego modelu przed/po jedyne nowe pola kanonicznego IR, które
można znormalizować, to:

| Dokładna ścieżka JSON Pointer | Dopuszczalna wartość |
|---|---|
| /problem_meta/runtime_metadata/mesh_workflow/domain_marker_owners | Brak przed pierwszym capture → dokładna raz przyjęta lista; następne przejścia identyczne |
| /problem_meta/runtime_metadata/model_builder/problem/mesh_workflow/domain_marker_owners | Dokładnie ta sama lista co wyżej, nie swobodny nowy builder |

Nowe geometry_name i shared_domain_mesh_source są polami buildera/sceny,
nie dodatkowymi polami geometrii lub mesh assetu IR. W porównaniu buildera/sceny
ich dokładne miejsca to /geometries/i/geometry_name,
 /objects/i/geometry/geometry_name, /shared_domain_mesh_source i
 /study/shared_domain_mesh_source. Każda wartość musi być równa wartości
wyprowadzonej z przyjętego wejścia: istniejący literalny key oraz źródło/mapy
i statyczna asercja; nie jest to wildcard pomijający potomków.

Obecna scena może jawnie odtworzyć pipeline dawnych flat stages. Jego ewentualne
dodanie do /problem_meta/runtime_metadata/study_pipeline i
/problem_meta/runtime_metadata/model_builder/study_pipeline jest dozwolone
wyłącznie przy pełnej równości z wynikiem istniejącego
runtime/script_builder.py::export_study_pipeline_document(before).
Również /problem_meta/runtime_metadata/script_sync/study_pipeline_version
musi być dokładnie study_pipeline.v1, a study_pipeline_node_count dokładnie
liczbą nodes tego samego dokumentu. Test niezależnie porównuje każdy stage,
jego kolejność, payload, enabled, requested execution oraz flags. Inna wartość,
nowy etap lub pominięta fizyka pozostają błędem, nie „metadanymi”.

Mapy/ID/markery, kolejność list oraz hashe artefaktów porównywać dokładnie.
Liczby fizyczne w IR mają te same przedustalone kryteria starego audytu:
rtol=5e-12, atol=0, zaś wartości całkowite bez tolerancji.
Niezmieniony plik meshu wymaga identycznego SHA256 i bajtów; tolerancja float
nie dotyczy integralności pliku.

## Zgodność, wykonanie i ograniczenia odbioru

Nowy spójny pakiet czyta stare sceny/buildery z opisanym fallbackiem. Nowa SceneStudyState deklaracja jest nieznanym polem dla starego czytnika z deny_unknown_fields; stare Python nie przyjmuje nowych keywordów. Dawny builder może ignorować obce pola, dlatego nie obiecujemy forward compatibility ani mieszanego starego API z nowym exporterem. Nie obniżać wersji przez usuwanie nowej deklaracji z projektu.

Publiczny IR writer pozostaje 0.3.0; nie deklarujemy v0.3.1, osobnego mesh writera, dual-write V03/V04 ani nowej wykonywalnej ochrony historycznych właścicieli. Właściwe provenance bieżącego rozwiązania nadal opisuje rzeczywiste ID/geometry/maps.

Managed build, restart, przeglądarka dla zmienionego importu/eksportu, nowe przygotowanie, rzeczywisty Solve, cold-load i reprodukcja publikacji pozostają odrębnymi bramkami pełnego zadania. Ten plan prosi wyłącznie o implementację źródeł i lekką weryfikację/CI. Nie zastępuje tych bramek testami na fixture.

## Self-review przed przekazaniem

- Zachowanie geometrii/etykiet i per-object mesh → T1.
- Źródło, oba rodzaje map, początkowy capture i statyczny eksport asercji → T2.
- ID/alias/disabled oraz usunięcie/recreate → wspólny fixture i T2.
- Brak/reset/null, persistence, revision/fingerprint i stare dokumenty → T2/T3.
- Rzeczywiste wejścia GSG, niezmieniony artefakt i pełna semantyka → T3.
- Noty/parametry/source-map przed nowym API → T1/T2, walidacja przy obu.
- Każdy nowy interfejs powyżej jest projektowany; nie ma twierdzenia, że już istnieje.
- Brak historycznej ochrony dowolnej edycji IR i nadal otwarty V04 są jawne, nie ukryte jako domniemany PASS.

Przed implementacją wymagany przegląd tego planu przez użytkownika zgodnie ze skillem writing-plans. Zachowana metoda wykonania: istniejąca sesja, zadania kolejno, z niezależnym review krytycznych kontraktów. Nie pytać ponownie o sam wybór metody.


## Uzupełnienia po niezależnym przeglądzie

Przegląd read-only wymagał trzech doprecyzowań: globalnych kolizji kluczy,
zagnieżdżonych Translate i ścisłej listy różnic. Wszystkie dodano do T1/T3
i nazwanych regresji. Self-review dopisał przenośny fixture i ciągły test
Python → oba adaptery Rust → Python w CI; prywatna ścieżka komputera
użytkownika nie może być zależnością runnera. To nadal plan, bez zastosowania
nowych pól lub uruchomienia ich testów.


Ponowny przegląd read-only po uzupełnieniach: brak dalszych wymaganych
poprawek przed zatwierdzeniem. Weryfikacja dokumentu: istniejące lokalne
linki, parzyste ogrodzenia bloków i wymagane sekcje planu. Żaden z nowych
interfejsów nie został zastosowany, skompilowany lub zakwalifikowany tym
przeglądem.
