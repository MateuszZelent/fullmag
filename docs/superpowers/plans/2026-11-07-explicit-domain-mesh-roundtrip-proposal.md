# Jawna domena GSG w scenie UI — projekt naprawy roundtripu

Status: audyt i historia projektu ogólnego; nowy wykonywalny binding IR pozostaje nierozstrzygnięty.
Bieżący [przejrzany plan zachowania istniejącej domeny V03](2026-11-07-explicit-domain-source-preservation-implementation.md)
rozstrzyga authoring i jawnie ograniczoną asercję, bez nowego bindingu solvera;
oczekuje osobnej decyzji przed wdrożeniem nowych pól.
Baza kodu: f6d176fb4ed53912f00c32373639d2cd2a0a79f9, z zachowaniem wcześniejszego WIP.
Cel pełnego zadania nadal obejmuje E0–E12 i reprodukcję publikacji. Ten etap
naprawia utratę wejścia meshu i nie zastępuje kwalifikacji fizyki lub odbioru UI.

## Problem i kryterium

[Audyt](2026-11-07-gsg-scene-domain-mesh-audit.md) potwierdził, że oba rzeczywiste
wejścia GSG zachowują pełne IR przez Python→Python, lecz tracą
study.domain_mesh przez SceneDocument. Naprawione flagi wykonania przechodzą
poprawnie. Nie usuwamy tej różnicy z testu.

Sukces: oba wejścia zachowują źródło i obie mapy markerów po
Python→scene→Rust adapters/API projection→Python, z tym samym wyborem domeny.
Źródłowy test korzysta z lightweight_assets i blokad solvera/Gmsh.
Managed odbiór pozostaje osobną bramką.

## Warianty i wybór

1. Dodać typowaną deklarację jawnej domeny do istniejącego buildera/sceny.
   Zachowuje obecny DSL i rozdziela requested intent od realizacji. Wymaga
   spójnego pakietu odczytującego nowe opcjonalne pole. **Zalecane.**
2. Użyć obecnego fem_domain_mesh. Odrzucone: to native study.mesh.load,
   inne dane wejściowe i walidacja; nie przenosi map domain_mesh.
3. Dodać nieinterpretowaną kopię mesh_workflow do otwartej mapy.
   Odrzucone: omija typowany model i jego identity/validation.
4. Pozostawić wyłącznie eksport zwykłego Python. Niewystarczające dla E12;
   nie realizuje zleconego roundtripu UI.

## Proponowany addytywny kontrakt

Jedno nowe opcjonalne pole o tej samej nazwie w ScriptBuilderState
i SceneStudyState: shared_domain_mesh_source. Nie dodajemy pola fizycznego
ProblemIR ani nowego endpointu. Pole jest tagowanym wyborem:

    {"kind": "generated"}

albo:

    {
      "kind": "explicit",
      "source": "gsg-convergence-targets.fullmag-mesh",
      "region_markers": [],
      "object_region_markers": [{"geometry_name": "existing-region", "marker": 2}]
    }

object_region_markers jest opcjonalne; przykład pokazuje kształt, a nie
rzeczywistą dodatkową mapę wejścia GSG. W rzeczywistym GSG pozostaje nieobecne.
Powyższy kształt map odzwierciedla obecny DSL, lecz nie jest jeszcze gotowym
kontraktem trwałych powiązań sceny. Wymagane rozstrzygnięcie opisano poniżej.
Same nazwy markerów nie aktywują fizyki.

| Składnik | Znaczenie i typ | Jednostka / default |
|---|---|---|
| Brak całego pola | brak nadpisania dla starej sceny script-backed; nowy scratch bez importu | 1 |
| kind=generated | jawne usunięcie wyboru zewnętrznej domeny; zachowuje recipe Universe/object | 1 |
| kind=explicit | odtworzenie study.domain_mesh z poniższymi danymi | 1 |
| source | niepusty authored path w kanonicznym zapisie z / | path, bez domyślnej lokalizacji |
| region_markers | lista dotychczasowych geometry_name/marker; jawnie pusta dla domeny obserwacyjnej | 1, wymagana przy explicit |
| object_region_markers | opcjonalna niepusta lista jak w obecnym DSL | 1 |
| geometry_name / marker | istniejące powiązanie i dodatni marker całkowity | 1 |

Generated nie może zawierać source/maps. Explicit odrzuca brak pól,
nieprawidłowe typy, null, puste source, NUL, zduplikowane nazwy/markery
i kolizję markerów między obiema mapami. Nie dodajemy losowego górnego limitu
lub zmiany wartości markerów; implementacja ma użyć istniejących granic
serializacji/loadera, pokazać je w testach i nie rozszerzać ich przy okazji.
Nie mieszamy bool z markerem liczbowym. Nie dodajemy nowego formatu pliku.

Pełna weryfikacja materiałów, zgodności map z topologią oraz dopuszczalności
pustej mapy pozostaje w istniejącym pełnym Problem/loaderze/plannerze.
Scena nie może samą nazwą geometrii włączyć modułu magnetycznego.

## Obecność, zmiana i invalidacja

Nowy eksport deklaruje generated albo explicit na podstawie rzeczywistego
stanu workspace; dawne dokumenty bez pola pozostają czytelne. Dla starej sceny
script-backed brak oznacza zachowanie wejścia źródłowego; dla nowego scratch
nie ma zewnętrznej domeny. Jawne generated pozwala odróżnić reset od braku
nadpisania. Null nie jest trzecią wartością kontraktu.

API Merge Patch null usuwa klucz przed deserializacją zgodnie z obecną
semantyką; po usunięciu obowiązuje legacy brak nadpisania. Reset musi wysłać
generated. Nie twierdzimy, że samo skasowanie klucza odpina źródło.

Generated usuwa wyłącznie domain_mesh_source/domain_mesh_mode i związane
mapy z deklaracji tej domeny, a nie recipe, topologię innych obiektów lub
dane wynikowe. Explicit odtwarza ten sam istniejący domain_mesh i build_target.
Zmiana deklaracji wchodzi do discretization_payload i nowej rewizji
authoringu; istniejący fingerprint/preparation guard unieważnia nieaktualne
przygotowanie. Nie zmieniamy starego wyniku ani jego provenance.

Source path nie daje nowego grantu plikowego. Absolutne/relatywne ścieżki
podlegają dotychczasowemu resolverowi, capture i sandboxowi; UI nie odczytuje
hostowych plików przez własny fetch. Reprezentacja sceny zachowuje deklarację,
a resolved digest/topology ID publikuje obecna materializacja. Brak pliku
przy materializacji pozostaje błędem; nie zastępujemy go nowym meshem.

fem_domain_mesh pozostaje oddzielnym wyborem native realizacji. Nowy projekt
nie zmienia dopuszczalności ich istniejących kombinacji ani reguł wczytywania
native asset. Test ma zachować oba źródła, gdy ich współistnienie jest obecnie
dozwolone; nie usuwać jednego w celu przejścia walidacji.

## Zakres implementacji i testy

1. Aktualizacja odpowiedniego kontraktu docs/specs/mesh-roundtrip-semantics-v1.md
   i source-map zgodnie z scientific-documentation-contract. Tabela parametrów,
   mapa source+symbol, zgodność i macierz realizacji obowiązkowe; brak nowej
   fizyki, równań transportu lub LLG.
2. Python script_builder/scene_document: eksport deklaracji, adaptery,
   overrides i odtworzenie domain_mesh przez istniejący renderer. Wspólny
   validator zamiast drugiego parsera materiałów/topologii.
3. Rust builder.rs/scene.rs/adapters.rs/validation.rs oraz
   authoring_model.rs::discretization_payload: nowy typ, domyślny brak,
   oba adaptery, model/revision identity i overrides; aktualizacja pełnych
   inicjalizatorów. SceneResource.study zachowuje obecną otwartą mapę.
4. Regresje Python i Rust: brak/generated/explicit, pusta mapa GSG,
   mapy region/object, zmiana/reset, niepoprawne typy i kolizje, stara scena,
   native reference bez zmiany oraz oba rzeczywiste skrypty. Dla IR
   odróżnić dozwolone metadane pipeline od utraty fizycznego wyboru meshu.
5. Test API projekcji/persistence oraz niezwiązanego patcha. Nie dodawać
   nowego endpointu lub edytora importu w tym etapie; gotowość pełnego
   authoringu UI meshu pozostaje osobnym wymaganiem E6/E12.
6. Lekkie testy Python/DOM w istniejącej grupie Docker; Rust i wymagane CI
   tylko dotychczasową zatwierdzoną trasą GitHub. Przegląd i selektywny
   commit z zachowaniem 63 chronionych wpisów indeksu.

Nie ma zgody wykonawczej na build native, restart, prepare-only, Submit/Solve,
zwolnienie rezerwacji lub zmianę granic dostępu do archiwum. Ten projekt
ich nie proponuje. Późniejszy managed odbiór wymaga gotowego kodu i
autoryzowanego okna oraz zgodnego admission; nie obchodzi quarantine.

## Zgodność i bramki

Stary runtime z deny_unknown_fields odrzuci nową scenę zawierającą pole.
To zgodność odczytu dawnych dokumentów przez nowy pakiet, nie forward
compatibility starego pakietu. Wymagany spójny authoring/Python/API.
Rollback nie może automatycznie usunąć nowej deklaracji z projektu.

| Realizacja | Zakres tego etapu |
|---|---|
| FDM CPU / GPU | zgodność starego authoringu; jawna domena FEM nadal niedopuszczalna |
| FEM CPU / GPU | wspólna deklaracja authoringu; nie kwalifikacja solvera lub obu urządzeń |

Odbiór lekki nie dowodzi rzeczywistego meshowania, próbkowania H, projekcji
na magnetyk, LLG, transmisji lub zgodności z publikacją. Przed deklaracją E12
pozostają managed runtime, publiczny export/reimport w UI i stare wyniki bez zmian.

## Wynik niezależnego przeglądu — required, jeszcze nierozstrzygnięte

Przegląd read-only potwierdził lukę trwałej tożsamości markerów. Obecne
adapters.rs::builder_geometry_name_for_object emituje bieżące object.name
z fallbackiem do ID. Nowe powiązanie sceny oparte wyłącznie na geometry_name
mogłoby po rename wskazywać stary obiekt albo nowy obiekt o dawnej nazwie.

Jednocześnie model/problem.py::build_geometry_assets_for_request porównuje
artifact.region_markers i artifact.object_region_markers dosłownie z mapami
zadanymi w domain_mesh. Nie wystarczy zastąpić nazwy przez bieżącą etykietę:
niezmieniony plik może nadal zawierać stary klucz. Nie wolno omijać tej
walidacji ani modyfikować historycznego pliku podczas rename.

Przed uznaniem projektu za gotowy trzeba rozstrzygnąć:
- osobne znaczenia niezmiennego klucza regionu w artefakcie i immutable
  object_id w scenie; nazwa prezentacyjna nie może być referencją;
- dokładnego właściciela i trwały identyfikator podregionu dla
  object_region_markers, na podstawie aktualnego modelu, bez wymyślania
  nieistniejącego region_id;
- jednoznaczny import legacy map do takich powiązań, z odmową przy
  brakującym, usuniętym lub niejednoznacznym celu;
- czy rename zachowuje historyczne powiązanie bez remeshingu i jak istniejący
  loader otrzymuje oba znaczenia bez zmiany semantyki źródłowego artefaktu.

Obowiązkowe regresje do dopisania po rozstrzygnięciu: rename przy stałym
object_id, kolizja nazw prezentacyjnych, usunięcie i odtworzenie pod dawną
nazwą, unresolved reference oraz persisted artifact z niezmiennymi mapami.
Pusta mapa GSG nie ćwiczy tych przypadków, więc sam jej zielony roundtrip
nie zakwalifikuje kontraktu ogólnego.

Nie wdrożono tego rozszerzenia. Nie prosimy o zatwierdzenie niepełnego
projektu i nie zaliczamy go do zatwierdzonej naprawy flag wykonania.


## Ustalenia po dalszej analizie — bez wdrożenia

Właściciel podregionu jest już znany: SceneObjectRegion.owner_object oraz
region_id. asset_pipeline.py::_realize_fem_domain_mesh_asset_from_components_impl zapisuje region_id do geometry_name mapy
object_region_markers. Nazwa prezentacyjna regionu nie jest tym kluczem.
Syntetyczna kontrola rzeczywistego loadera jest opisana w audycie.

Rozważany poprawny owner dodatkowego powiązania to osobne marker_bindings
przy FemDomainMeshAssetIR, z marker i istniejącym RegionRefIR jako target.
Nie dodawać target do FemDomainRegionMarkerIR: tego samego typu używa
build_report, a planner porównuje obie źródłowe mapy dosłownie.
Source maps, receipt i semantic manifest pozostają niezmienione;
binding musi mieć osobną tożsamość w przygotowaniu.

To rozszerzenie dotyka także Pythonowego przygotowania magnetyzacji
(model/problem.py), mesh.rs::shared_domain_region_entries_for_problem,
mesh.rs::validate_domain_object_region_identity,
fem.rs::build_conformal_region_element_fields oraz
validate.rs::region_is_conformal. Sam nowy klucz sceny nie wystarcza.
Nie wdrożono go i nie zadeklarowano go w obecnym publicznym IR.

ADR0024, sekcja Migration and rollback, wymaga wspólnego cutoveru V04
obiektów i polityk siatki. problem-ir-compatibility-v1 wymaga wersjonowania
nowego znaczenia. Deserializator obecnego FemDomainMeshAssetIR ignoruje
nieznane pola; nie wolno więc obiecać bezpiecznej odmowy starego runtime
po dopisaniu samego marker_bindings. Wybór zgodnej granicy migracji musi
poprzedzić implementację tego ogólnego kontraktu; nie zmieniamy writera
na 0.3.1 ani 0.4 w ramach naprawy flag lub ID.

Niezależny warunek konieczny, możliwy do naprawienia bez nowego IR:
[przeniesienie już istniejącego object_id magnetyka przez Rust](2026-11-07-magnetic-object-id-roundtrip-implementation.md).
Ten patch został wdrożony i zweryfikowany osobno: [wynik siedmiu regresji i CI](2026-11-07-magnetic-object-id-roundtrip-result.md). Nie stanowi obejścia
nierozstrzygniętej granicy mapowania domeny. Cel pełnego roundtripu i reprodukcji
pozostaje otwarty.


## Rozstrzygnięcie zakresu tożsamości — 07.11.2026

Odczyt i niezależny przegląd na HEAD
8ecf00436cef40f1a4b32e331bfbf362c37c01fd rozdzieliły dwie naprawy.
Zachowanie już istniejącego klucza geometrii nie jest samo w sobie nową
semantyką IR. V03 rozdziela geometry.entries[].name, regions[].geometry
i magnets[].name/object_id. Dlatego nie uzasadniamy migracji całego IR
wyłącznie utratą klucza podczas eksportu. Ewentualne nowe marker_bindings
pozostają osobnym, wersjonowanym rozszerzeniem, a nie ustalonym warunkiem
każdego bezstratnego roundtripu.

### Potwierdzona przyczyna w publicznym Pythonie

W istniejącym backendzie wykonano izolowany proces Python z importem źródeł
z /opt/fullmag/source/packages/fullmag-py/src i blokadą subprocess.Popen.
Dla Box o nazwie persisted_geom oraz object_id=immutable-sample:

| Nazwa obiektu | Klucz przekazanego kształtu | Klucz zwrócony przez MagnetHandle._resolved_geometry |
|---|---|---|
| sample | persisted_geom | sample_geom |
| renamed sample | persisted_geom | renamed sample_geom |

Dla geometry_object(type=conductor, object_id=immutable-conductor) ten sam
test zwrócił odpowiednio sample i renamed sample zamiast persisted_conductor.
Proces zakończył się kodem 0, lista wywołań subprocess była pusta.
Nie wywoływano to_ir, materializacji, Gmsh ani Solve. To dowód zachowania
konstruktorów, nie kompletny test roundtripu lub wykonania solvera.

Właściciele przyczyny:

- packages/fullmag-py/src/fullmag/world.py::MagnetHandle._resolved_geometry
  nadpisuje shape.name przez nazwę magnetyka z sufiksem _geom;
- packages/fullmag-py/src/fullmag/world.py::geometry_object nadpisuje
  shape.name nazwą prezentacyjną obiektu;
- packages/fullmag-py/src/fullmag/runtime/script_builder.py::_export_geometry_entry
  zachowuje nazwę magnetyka, lecz nie odrębny klucz jego geometrii;
- crates/fullmag-authoring/src/adapters.rs::builder_geometry_name_for_object
  wybiera nazwę prezentacyjną;
- crates/fullmag-plan/src/mesh.rs::shared_domain_region_entries_for_problem
  już rozwiązuje klucz geometrii przez region do magnetyka.

Hash world.py podczas kontroli:
b8634f79e4edfb723a2582bba5a6446dc009be723fc8dfb126f4817f909cab3f.
Hash mesh.rs:
e0c88d8f33bc0038506f19a6aca74cd7fd860effb052edd4cebab8fe4d3f9bb7.
To przypięcie do odczytanego dirty worktree; sam HEAD nie opisuje jego WIP.

### Legacy alias nie jest trwałym region_id

Kontrprzykład z odczytu kodu, nie wynik wykonanego meshowania: mapa artefaktu
ma geometry_name=core, marker=2; region ma region_id=r-1,
owner_object=immutable-A, name=core. Funkcja
crates/fullmag-plan/src/mesh.rs::resolve_object_region_marker dopuszcza
jednoznaczny alias nazwy, gdy nie ma pasującego region_id. Po zmianie nazwy
r-1 na renamed core alias przestaje działać; po dodaniu r-2 o nazwie core
może wskazać nowy region. Zachowanie klucza głównej geometrii tego nie naprawia.
Mapy zapisane przez packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py::_realize_fem_domain_mesh_asset_from_components_impl
używają region_id i nie mają tej konkretnej zależności od nazwy.

Nie zmieniać map artefaktu, build_report ani receipt podczas rename:
model/problem.py::build_geometry_assets_for_request wymaga ich literalnej zgodności.

### Następny projekt — granice, które musi domknąć

Najmniejszy kandydat zachowuje źródło, obie mapy i istniejące klucze geometrii
w Pythonie, builderze i scenie, bez zmiany writera V03. Dla kanonicznych
region_id ma zachować rename przy stałej tożsamości; legacy alias, którego
właściciel się zmienia lub przestaje być jednoznaczny, ma powodować jawną
odmowę zamiast automatycznego przepięcia. To ograniczenie trzeba pokazać
użytkownikowi, nie nazywać pełną obsługą dowolnych legacy map.

Przed planem implementacyjnym pozostaje wskazać dokładny, wspólny nośnik
przypięcia właściciela oraz jego eksport do Python. Guard istniejący tylko
w SceneDocument jest niewystarczający: po eksporcie nie wolno utracić dowodu,
że usunięty obiekt i nowy obiekt pod dawną nazwą mają różne object_id.
Nowe ukryte znaczenie tylko w scenie naruszałoby jeden kontrakt modelu.
Jeżeli rozwiązanie wymaga nowej semantyki IR, obowiązuje atomowa granica
V04 z ADR0024 i ADR0027; nie dodawać ignorowanego pola do V03.

Kryteria regresji: nieedytowane wejście GSG, odrębny geometry key i nazwa,
rename przy stałym object_id, usunięcie i odtworzenie pod dawną nazwą,
kanoniczny region_id, alias legacy po rename oraz po kolizji z nowym ID,
niezmienione bajty źródła i pełny Python → scena → Python → IR.
Pusta mapa GSG nie zastępuje tych przypadków.

Status pozostaje WYMAGA UZUPEŁNIENIA PROJEKTU. Ten przegląd nie zmienia
kontraktu, polityki, runtime ani stanu wyników; nie uruchamia nowych obliczeń.


## Naprawa istniejącego lookup właściciela podregionu — 07.11.2026

Śledzenie granicy ujawniło niezależny błąd w
packages/fullmag-py/src/fullmag/model/problem.py::Problem.to_ir.
owner_geometry_names używało magnet.name, podczas gdy ObjectRegion.owner_object
zawiera jawne object_id. Dla track / immutable-track do materializatora
dochodził pusty owner_geometry_name. Gdy drugi magnetyk miał nazwę
immutable-track i inne ID, podregion był kierowany do geometrii tego drugiego
obiektu. Nie jest to nowe znaczenie IR, lecz błędny lookup już istniejącego ID.

Naprawa używa dokładnego object_id i dawnego name tylko wtedy, gdy ID jest None.
Nie przepisuje map źródła ani ID podregionu. Testy w
packages/fullmag-py/tests/test_object_region_owner_identity.py przez publiczny
authoring i Problem.to_ir przechwytują rzeczywiste argumenty istniejącego
materializatora. Obejmuje to jawne ID, legacy brak ID, rename i kolizję
z nazwą prezentacyjną drugiego magnetyka.

RED: 4 testy, 3 właściwe porażki i 1 PASS legacy; bez błędów setupu.
GREEN: 4 nowe i 4 istniejące regresje, 8/8 PASS. Materializator zastąpiono
capture wyłącznie w teście; subprocess.Popen jest blokowany w nowych
regresjach. To dowód poprawnego handoff authoringu, nie nowego meshowania,
wyniku pola lub zakwalifikowania wspólnego rdzenia antena/LLG.
Receipty red.json i green.json zachowano w prywatnym wolumenie grupy pod
verification/object-region-owner-identity-20261107/.
Bootstrap rust-contracts dostał wykonanie nowego pliku obok dotychczasowych
regresji roundtripu; wynik CI zostanie zapisany po rzeczywistym zakończeniu.

## Granica warunkowego wariantu V03 po przeglądzie

Niezależny przegląd dopuścił zachowanie geometry_name w V03 oraz eksportowalną
asercję authoringu, o ile nie obiecujemy nowej ochrony każdego wejścia IR.
Kandydat marker_owners musi identyfikować tabelę, literalny klucz, marker
i oczekiwany RegionRef, mieć pełne pokrycie bez duplikatów oraz przechowywać
raz przyjęte trwałe ID. Refresh/rename nie mogą wyliczać oczekiwanego właściciela
ponownie. Sprawdzenie po zebraniu modelu musi poprzedzać każdą materializację,
także to_ir(include_geometry_assets=False), i odpowiadać dokładnie regule
ID przed aliasem, również dla wyłączonego ID.

Nie wolno przedstawiać tego jako trwałej historii ownera w samym V03 IR.
Identyczny zaakceptowany IR zachowuje bieżący graph i mapy, ale dowolnie
zmodyfikowany IR nie zawiera wcześniejszego oczekiwanego targetu.
Ochrona obejmująca takie ponowne authorowanie IR wymaga osobnego typowanego
kontraktu i atomowej granicy V04. Obowiązkowa bramka ukryta wyłącznie
w runtime_metadata byłaby błędnym obejściem.

Dla auxiliary oddzielenie etykiety od geometry key musi objąć również
world.py::geometry_object, model/problem.py::Problem.to_ir i
model/physics_scope.py::build_physics_graph. Samo nowe pole sceny
nie wystarczy. Ten wariant jest nadal rozpoznaniem granicy, nie wdrożeniem
nowego source declaration lub zatwierdzonym wspólnym modelem domen.
