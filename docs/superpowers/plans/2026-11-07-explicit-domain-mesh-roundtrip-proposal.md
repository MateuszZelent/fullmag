# Jawna domena GSG w scenie UI — projekt naprawy roundtripu

Status: WYMAGA UZUPEŁNIENIA PROJEKTU po niezależnym przeglądzie; nie jest gotowy do zatwierdzenia ani implementacji nowego kontraktu.
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

Jednocześnie model/problem.py::_materialize_geometry_assets porównuje
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
