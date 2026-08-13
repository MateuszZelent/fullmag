# Kompozycyjny model obiektów i modułów fizycznych

**Status:** zatwierdzony projekt; oczekuje na przegląd zapisanej specyfikacji

**Data:** 2026-08-13

**Zakres:** Python DSL, `ProblemIR`, normalizacja, planner, runtime, FEM/FDM,
OpenAPI v2, Control Room, eksport skryptu i migracja legacy

**Kanoniczny właściciel semantyki modułów:**
`docs/physics/0995-physics-module-scope-and-activation.md`

## 1. Decyzja

Fullmag wprowadzi jeden kanoniczny byt `PhysicsObject`. Każdy obiekt ma
geometrię, niezmienną tożsamość, nazwę użytkownika i podstawowy `type`, ale
nie otrzymuje żadnego aktywnego równania wyłącznie na podstawie typu.

Fizyka jest kompozycją jawnie dodanych modułów:

```text
PhysicsObject
  + geometry
  + optional material assignments
  + zero or more object/region physics modules
  + zero or more named surfaces
```

Moduły globalne należą do `Global Physics`, a prawa łączące dwa obiekty lub
regiony należą do jawnych `Interfaces`. Obecność rekordu modułu w kanonicznym
authoringu jest jedyną podstawą utworzenia węzła `physics_graph.v1`.

W szczególności:

- `name` jest nazwą użytkownika, a nie typem ani przełącznikiem fizyki;
- `type` jest podstawowym archetypem authoringu i prezentacji;
- `object_id` jest niezmienną tożsamością używaną przez zależności;
- dodanie `object.current.solve(...)` tworzy moduł transportu;
- brak wywołania modułu oznacza brak tego modułu w `ProblemIR`, plannerze,
  runtime i Explorerze;
- zerowa wartość prądu oznacza istniejący moduł z zerowym wymuszeniem, nie
  brak modułu;
- `electrode` jest warunkiem brzegowym modułu transportu na nazwanej
  powierzchni, nie typem bryły.

## 2. Problem obecnej architektury

Publiczny builder zwraca `MagnetHandle` z `geometry()`, przez co utworzenie
zwykłej bryły z góry wiąże ją z semantyką ferromagnetyka. Obiekty
niemagnetyczne trafiają do oddzielnego, słabo typowanego
`auxiliary_geometries`, a antena wymaga specjalnego `antenna_object()`.

Ten podział ma cztery konsekwencje:

1. geometria jest utożsamiona z jedną rodziną fizyki;
2. przewodnik HM nie ma równorzędnego publicznego uchwytu obiektowego;
3. UI może budować drzewo z kategorii danych zamiast z rzeczywiście dodanych
   modułów;
4. eksport Python i `ProblemIR` utrwalają historyczne rozdzielenie
   `magnets[]` oraz `auxiliary_geometries[]`.

Docelowy model usuwa ten podział semantyczny. FDM i FEM otrzymują ten sam
model obiektu i różnią się dopiero materializacją zakresu na maski albo
markery.

## 3. Rozdzielenie pojęć

### 3.1. Tożsamość

Każdy obiekt ma:

| Pole | Znaczenie | Mutowalność |
|---|---|---|
| `object_id` | niezmienny identyfikator referencyjny | niezmienne po utworzeniu |
| `name` | unikalna w scenie nazwa użytkownika | zmienialna transakcyjnie |
| `label` | opcjonalny opis wyświetlany | zmienny, nie musi być unikalny |
| `type` | podstawowy archetyp obiektu | zmiana tylko przez walidowaną migrację |
| `geometry_id` | referencja do geometrii | zmiana invaliduje mesh zgodnie z ADR 0009 |

Publiczny Python zwykle przekazuje uchwyty, nie tekstowe identyfikatory.
Wygodne wyszukanie `study.objects["heavy_metal"]` rozwiązuje aktualne `name`,
ale lowering zawsze zapisuje `object_id`. Zmiana `name` nie przepisuje
interfejsów, checkpointów ani zależności graphu.

Przy tworzeniu obiektu bez jawnego `object_id` authoring generuje stabilny ID
raz i utrwala go w SceneDocument. Skrypt utworzony od zera może deterministycznie
użyć kanonicznego slugu nazwy, jeżeli nie koliduje on z istniejącym ID. Import
i ponowny eksport zachowują zapisany ID bez ponownej generacji.

### 3.2. Typ podstawowy

Pierwsza wersja kontraktu dopuszcza:

```text
geometry | ferromagnet | conductor | antenna
```

Znaczenie:

- `geometry` — neutralna bryła bez sugerowanej domeny fizycznej;
- `ferromagnet` — obiekt, dla którego UI priorytetyzuje authoring
  magnetyzacji i materiałów magnetycznych;
- `conductor` — obiekt, dla którego UI priorytetyzuje transport ładunku i
  własności elektryczne;
- `antenna` — obiekt źródłowy prezentowany jako antena, mogący korzystać z
  prądu zadanego albo rozwiązanego.

`type` nie jest zbiorem capability i nie uruchamia operatora. Ferromagnetyk
może mieć moduł current transport, antena może być przewodnikiem, a neutralna
geometria może otrzymać moduł po późniejszej konfiguracji. Typ steruje
domyślnym układem Inspectora, filtrem palety i stylem prezentacji, ale nie
zastępuje walidacji modułu.

Nie dodajemy `electrode` do typów objętościowych. Jeżeli fizyczny pad jest
osobną bryłą, jest obiektem `conductor`; rola terminala nadal należy do jego
powierzchni w konkretnym module prądowym.

### 3.3. Materiał

Materiał nie jest typem i nie jest modułem. Obiekt lub region może otrzymać
przypisania parametrów magnetycznych, elektrycznych, spinowych, termicznych
lub mechanicznych. Dodanie parametrów materiałowych nie tworzy samoistnie
równania. Walidator modułu sprawdza dopiero, czy jego domena ma komplet
wymaganych parametrów.

### 3.4. Moduł fizyczny

Moduł jest jawnie utworzonym rekordem rodzinnym o stabilnym `module_id`,
zakresie, domenie rozwiązania, zależnościach i stanie aktywacji. Akcesor taki
jak `hm.current` nie tworzy rekordu; rekord powstaje dopiero po wywołaniu
metody tworzącej, np. `solve`, `prescribe` albo `add`.

## 4. Publiczny Python DSL

### 4.1. Tworzenie obiektów

Kanoniczny konstruktor:

```python
# %%
import fullmag as fm

study = fm.study("hm_fm_racetrack")

hm = study.object(
    fm.Box(2.0e-6, 200e-9, 5e-9),
    name="heavy_metal",
    type="conductor",
)

free_layer = study.object(
    fm.Box(2.0e-6, 200e-9, 1e-9).translate((0.0, 0.0, 3e-9)),
    name="free_layer",
    type="ferromagnet",
)
```

Sygnatura docelowa:

```python
StudyBuilder.object(
    shape: GeometryLike,
    *,
    name: str,
    type: Literal["geometry", "ferromagnet", "conductor", "antenna"] = "geometry",
    label: str | None = None,
    object_id: str | None = None,
) -> PhysicsObjectHandle
```

`name` jest obowiązkowe w nowym kanonicznym API. Ciche nazwy `body` i
`antenna` nie są dozwolone, ponieważ utrudniają round-trip i diagnostykę
wielu obiektów. `object_id` jest parametrem zaawansowanym używanym głównie
przy imporcie i odtwarzaniu; zwykły skrypt operuje uchwytem.

### 4.2. Konfiguracja magnetyzacji

```python
# %%
free_layer.magnetization.configure(
    material=cofeb,
    initial_state=fm.texture.skyrmion(
        polarity=-1,
        chirality="neel",
    ),
)
```

Wywołanie tworzy moduł magnetyzacji dla dokładnego `object_id`. Parametry
materiałowe są referencją do kanonicznego materiału. Sam
`type="ferromagnet"` nie tworzy tego modułu.

### 4.3. Transport ładunku i elektrody

```python
# %%
charge = hm.current.solve(
    name="hm_charge",
    conductivity_s_per_m=5.0e6,
)

charge.electrode(
    name="source",
    surface=hm.surface("x-", orientation=(-1.0, 0.0, 0.0)),
    outward_current_density_Apm2=-1.0e12,
)
charge.electrode(
    name="drain",
    surface=hm.surface("x+", orientation=(1.0, 0.0, 0.0)),
    potential_V=0.0,
)
```

`hm.current.solve(...)` zwraca uchwyt utworzonego modułu. Elektrody są
nazwanymi warunkami brzegowymi tego modułu i mogą wskazywać tylko powierzchnie
należące do jego solve domain. Jeden obiekt może uczestniczyć w więcej niż
jednym wariancie badania, ale w pojedynczym zmaterializowanym etapie nie wolno
nakładać sprzecznych BC na tę samą powierzchnię.

### 4.4. Spin transport i torque

```python
# %%
spin = hm.spin_transport.she(
    name="hm_spin",
    current=charge,
    sigma_s_Spm=5.0e6,
    polarization_p=0.0,
    theta_sh=0.12,
    lambda_sf_m=1.5e-9,
)

hm_fm = study.interface(
    name="hm_fm",
    side_a=hm.surface("z+", orientation=(0.0, 0.0, 1.0)),
    side_b=free_layer.surface("z-", orientation=(0.0, 0.0, -1.0)),
)

hm_fm.spin_mixing.configure(
    spin_transport=spin,
    g_up_Spm2=2.5e14,
    g_down_Spm2=2.5e14,
    g_r_Spm2=5.0e14,
    g_i_Spm2=0.0,
)

free_layer.spin_torque.from_transport(
    name="transport_torque",
    source=spin,
    interface=hm_fm,
)
```

Zależności wynikają z uchwytów i są serializowane jako stabilne ID. Nie wolno
odnajdywać źródła na podstawie typu obiektu, pierwszego prądu w kolekcji ani
aktualnego zaznaczenia UI.

### 4.5. Zakres regionalny i globalny

Moduł regionalny jest tworzony przez uchwyt regionu:

```python
free = free_layer.region("free")
free.magnetization.configure(material=cofeb, initial_state=initial)
```

Fizyka globalna jest jawna i nie jest sztucznie przypisywana pierwszemu
obiektowi. Poniższy namespace jest docelowym skrótem authoringowym tej
migracji; pod spodem zapisuje istniejący `RegionalFieldDrive` z
`FieldTarget.global_domain()`:

```python
study.physics.external_field.uniform(
    name="bias",
    B=(0.0, 0.0, 25e-3),
)
```

## 5. Kanoniczny `ProblemIR`

### 5.1. Kolekcja obiektów

Następna publiczna wersja IR wprowadza `objects[]`:

```json
{
  "objects": [
    {
      "schema_version": "physics_object.v1",
      "object_id": "obj_heavy_metal",
      "name": "heavy_metal",
      "label": "Heavy metal",
      "type": "conductor",
      "geometry_id": "geom_heavy_metal",
      "material_assignment_ids": []
    },
    {
      "schema_version": "physics_object.v1",
      "object_id": "obj_free_layer",
      "name": "free_layer",
      "type": "ferromagnet",
      "geometry_id": "geom_free_layer",
      "material_assignment_ids": ["assign_free_layer_cofeb"]
    }
  ]
}
```

Przypisanie materiału jest typowanym rekordem root, ponieważ musi zachować
dokładny target obiektu albo regionu:

```json
{
  "material_assignments": [
    {
      "schema_version": "object_material_assignment.v1",
      "assignment_id": "assign_free_layer_cofeb",
      "target": {"object_id": "obj_free_layer"},
      "material_id": "cofeb"
    }
  ]
}
```

Lista ID w obiekcie jest tylko deterministycznym indeksem prezentacyjnym;
rekord root jest właścicielem targetu i materiału. Przypisania regionalne
używają dodatkowo `region_id` i round-tripują bez spłaszczenia do jednego
`material_ref`.

`objects[]` jest jedynym kanonicznym indeksem obiektów sceny. Geometrie nadal
pozostają oddzielnymi zasobami, ponieważ jedna geometria ma własny lifecycle,
hash i cache siatki. Regiony wskazują `object_id`, a nie nazwę ani pozycję w
tablicy.

### 5.2. Moduły i graph

Rodzinne payloady nadal przechowują komplet parametrów konstytutywnych.
`physics_graph.v1` przechowuje ich tożsamość, zakres, zależności i aktywację.

```json
{
  "physics_graph": {
    "schema_version": "physics_graph.v1",
    "modules": [
      {
        "id": "hm_charge",
        "kind": "ohmic_poisson",
        "solve_domain": [{"object_id": "obj_heavy_metal"}],
        "applies_to": [{"kind": "object", "object_id": "obj_heavy_metal"}],
        "depends_on": [],
        "activation": "active"
      }
    ]
  }
}
```

Typ obiektu nie jest kopiowany do `family_payload` i nie bierze udziału w
wyborze operatora. Planner znajduje operator po rodzaju modułu oraz jego
capability, następnie rozwiązuje referencje `object_id` na topologię.

### 5.3. Interfejsy i powierzchnie

Nazwana powierzchnia jest selekcją topologiczną należącą do obiektu. Nie jest
samodzielnym obiektem objętościowym. Interfejs zawiera dwie zorientowane strony
oraz stabilne ID obu właścicieli. Normalna jest częścią kontraktu i nie może
być odtworzona z kolejności obiektów.

Interfejs istnieje raz w `interfaces[]` jako wersjonowany
`physics_interface.v1` z `interface_id`, `name`, `side_a`, `side_b` oraz
jawnym kierunkiem `side_a_to_side_b`. Explorer może pokazać linki pod obydwoma
obiektami, ale nie duplikuje rekordu. Moduł mixing conductance przechowuje
parametry konstytutywne i referencję `interface_id`; nie kopiuje stron
interfejsu do zagnieżdżonego, alternatywnego rekordu.

### 5.4. Własność danych authoringowych

`SceneDocument` ma dokładnie jednego właściciela każdego rekordu:

| Dane | Jedyny właściciel | Projekcje pochodne |
|---|---|---|
| identity, geometry, type | `objects[]` | Explorer, viewport |
| materiał obiektu/regionu | `material_assignments[]` | grupowanie Inspectora |
| magnetization/current/spin/torque/Oersted | root family collections | `physics_graph` |
| interfejs geometryczny | `interfaces[]` | scope grafu i linki Explorera |
| activation i zależności | normalizer grafu | status wykonania |

Legacy `physics_stack`, `magnetization_ref`, `material_ref` i ScriptBuilder są
wyłącznie wejściami migracji. Nowy writer nie utrzymuje ich jako równoległych,
edytowalnych źródeł prawdy.

## 6. Walidacja i semantyka błędów

Walidacja jest warstwowa:

1. authoring sprawdza format nazwy, unikalność `name`, unikalność `object_id`
   oraz istnienie geometrii;
2. normalizer sprawdza kompletność i jednoznaczność referencji;
3. walidator modułu sprawdza wymagane parametry materiałowe i legalność
   zakresu;
4. planner sprawdza capability wybranego backendu, urządzenia i trybu;
5. runtime sprawdza zgodność zmaterializowanych masek/markerów i rewizji.

Reguły fail-closed:

- nieznany `type` jest zachowywany wyłącznie przez czytnik forward-compatible
  jako `unsupported`; nie może otrzymać nowych modułów w UI;
- duplikat `name` albo `object_id` odrzuca transakcję;
- tekstowa referencja po nazwie musi rozwiązać się dokładnie do jednego
  obiektu przed loweringiem;
- moduł wskazujący brakujący obiekt, region, powierzchnię, interfejs albo
  źródło ma stan `blocked`/`unresolved` i nie trafia do wykonania;
- typ nie może zalegalizować brakującego modułu ani brakujących parametrów;
- backend nie może syntetyzować modułu na podstawie parametrów materiału;
- usunięcie obiektu jest zablokowane, dopóki jawnie nie zostaną usunięte albo
  przeniesione zależne moduły i interfejsy;
- rename obiektu nie zmienia `object_id` ani wyników referencyjnych.

Stan modułu current jest deterministyczny:

| Stan authoringu | Activation | Wykonanie |
|---|---|---|
| niekompletne BC | `configured` | zakazane |
| kompletne BC, wszystkie wymuszenia zero | `inactive` | zakazane |
| kompletne BC, co najmniej jedno wymuszenie niezerowe | `active` | po capability |
| brak targetu lub named dependency | `blocked` | zakazane |
| nieznana rodzina z nowszego IR | `unsupported` | zakazane |

Zmiana BC przelicza ten stan oraz wszystkie zależne spin/torque edges w jednej
transakcji. Zerowy prąd nie usuwa authored modułu; brak modułu oznacza, że
transport w ogóle nie należy do problemu.

## 7. Planner i realizacje numeryczne

Planner otrzymuje wspólny `PhysicsObjectIR` i graph dla obu dyskretyzacji.

### 7.1. FDM

Każdy zakres `object_id`/`region_id` jest materializowany jako wersjonowana
maska komórek i, dla BC/interfejsów, maska zorientowanych ścian. Maska należy
do rozwiązanej rewizji topologii. Typ obiektu nie wybiera kernela CUDA ani
nie tworzy pola.

### 7.2. FEM

Każdy zakres jest materializowany jako markery elementów shared-domain mesh,
a powierzchnie i interfejsy jako jawne markery facetów z orientacją. Obiekty
magnetyczne i przewodzące mogą współdzielić domenę siatki bez utraty odrębnych
zakresów modułów. Typ obiektu nie uruchamia steady transport podczas zwykłej
relaksacji magnetycznej.

### 7.3. Proweniencja

Plan i artefakty zapisują osobno:

- authored `object_id`, `name`, `type` oraz rewizję sceny;
- authored moduły i ich aktywację etapową;
- resolved mask/marker identity;
- requested oraz resolved backend/device/precision/mode;
- wszystkie odrzucenia capability i brak fallbacku.

Zmiana etykiety nie invaliduje stanu numerycznego. Zmiana geometrii, regionu,
materiału używanego przez aktywny moduł albo zakresu modułu invaliduje
odpowiednie plany i artefakty.

## 8. Control Room i OpenAPI v2

### 8.1. Drzewo Explorera

Docelowy układ:

```text
Model
├── Objects
│   ├── heavy_metal [conductor]
│   │   ├── Geometry
│   │   ├── Materials
│   │   ├── Current Transport: hm_charge
│   │   └── Spin Transport: hm_spin
│   └── free_layer [ferromagnet]
│       ├── Geometry
│       ├── Materials
│       ├── Magnetization
│       └── Spin Torque: transport_torque
├── Interfaces
│   └── hm_fm
└── Global Physics
    └── Applied Field: bias
```

Explorer konsumuje zasoby obiektów i `physics_graph`, nie puste kolekcje
rodzinne. Nie pokazuje Current, Spin, SOT/STT ani Oersted, jeśli odpowiedni
moduł nie istnieje. Moduł istniejący, lecz etapowo wyłączony, pozostaje
widoczny z jednoznacznym stanem `inactive`.

### 8.2. Inspector i tworzenie modułów

Inspector obiektu pokazuje kolejno Identity, Geometry, Materials, Physics i
Execution availability. `type` wybiera domyślną kolejność kart oraz
rekomendowane akcje `Add Physics`; lista możliwości pochodzi z capability i
reguł kompatybilności, a nie z ukrytych rekordów.

Akcja `Add Current Transport` tworzy lokalny draft. Węzeł Explorera pojawia
się dopiero po udanej transakcji API i odświeżeniu `scene_revision`.
Anulowanie draftu nie pozostawia pustego modułu.

Każdy semantyczny węzeł ma własny Inspector. Współdzielony szablon wizualny
nie oznacza jednego generycznego formularza dla różnych bytów.

### 8.3. Zasoby API

OpenAPI v2 zachowuje istniejące zasoby authoringu i mutacje:

```text
GET  /v2/sessions/current/model/authoring
POST /v2/sessions/current/model/objects
PATCH /v2/sessions/current/model/objects/{object_id}
DELETE /v2/sessions/current/model/objects/{object_id}
POST /v2/sessions/current/model/transactions
```

Zwykłe `POST` generuje `object_id` atomowo; jawne ID jest dozwolone tylko w
transakcji importu/migracji. Zwykły `PATCH` zmienia `name` lub `label`, ale nie
`type`. Reclassification używa dedykowanej transakcji z walidacją zależnych
modułów i proweniencją. Mutacje używają revision preconditions, są atomowe i
zwracają nową `scene_revision`. Frontend używa generowanych typów, centralnego
klienta i resource hooks; komponenty nie tworzą własnych endpointów.

## 9. Round-trip

Wymagany invariant:

```text
Python -> ProblemIR -> SceneDocument -> UI edit -> canonical Python
       -> ProblemIR
```

Po normalizacji oba końcowe IR muszą zachować:

- `object_id`, `name`, `label`, `type`, `geometry_id`;
- materiały i regiony;
- moduły, parametry rodzinne, zakresy i zależności;
- powierzchnie i zorientowane interfejsy;
- kolejność etapów i aktywację modułów;
- requested execution intent.

Eksporter nie może odtwarzać `antenna_object()` ani wybierać
`geometry()` na podstawie obecności parametrów magnetycznych. Zawsze emituje
`study.object(..., type=...)` i jawne wywołania modułów.

## 10. Migracja legacy

Migracja jest wersjonowana i nie może być wykonana jako niejawne zgadywanie.

### 10.1. Odczyt

- każdy rekord `magnets[]` migruje do obiektu `type="ferromagnet"` oraz
  jawnego modułu magnetyzacji;
- każda `auxiliary_geometry` z utrwaloną rolą `antenna` migruje do
  `type="antenna"` bez automatycznego modułu prądowego;
- pozostała auxiliary geometry migruje do `type="geometry"`;
- current/spin/torque/field payloady są mapowane po istniejących stabilnych
  referencjach; brak jednoznacznej referencji daje `unresolved`;
- czytnik zachowuje źródłową wersję i raport migracji w proweniencji.

### 10.2. Zapis

Nowy authoring zapisuje wyłącznie `objects[]`. Eksport do starego IR jest
dozwolony tylko jako jawne narzędzie kompatybilności i musi odrzucić model,
którego nie da się przedstawić bezstratnie.

### 10.3. Python compatibility

`geometry()` i `antenna_object()` pozostają czasowo adapterami:

- `geometry(shape, name)` tworzy `study.object(...,
  type="ferromagnet")` i zachowuje legacy konfigurację magnetyczną;
- `antenna_object(shape, name)` tworzy `study.object(..., type="antenna")`;
- każde użycie emituje kontrolowane ostrzeżenie migracyjne z kanonicznym
  zamiennikiem;
- adaptery nie są używane przez canonical script exporter;
- usunięcie następuje dopiero po golden round-tripie wszystkich wspieranych
  fixture i ogłoszonym oknie deprecacji.

## 11. Testy i dowody akceptacji

### 11.1. Python i IR

- konstrukcja każdego `type` bez niejawnych modułów;
- unikalność i rename `name` przy zachowaniu `object_id`;
- jawne utworzenie magnetyzacji, current, spin i torque;
- brak rekordu modułu po samym odczycie akcesora;
- elektrody jako BC powierzchni, nie obiekty;
- Python -> IR -> exporter -> Python -> IR golden equality;
- migracja `magnets[]` i `auxiliary_geometries[]`;
- fail-closed dla niejednoznacznych nazw i brakujących referencji.

### 11.2. Planner i runtime

- FDM mask identity dla object/region/surface/interface;
- FEM marker identity dla tego samego kontraktu;
- zwykła relaksacja FEM/FDM bez current module nie planuje transportu;
- istniejący current module z zerowym BC pozostaje w graphie, lecz nie jest
  mylony z brakiem modułu;
- brak fallbacku typu -> operator;
- proweniencja requested/resolved i migracji.

### 11.3. API i UI

- OpenAPI/generowane typy/klient/resource hook parity;
- create, rename, change label, add module, cancel draft i delete dependency;
- Explorer pokazuje wyłącznie zapisane moduły;
- każdy typ obiektu, moduł, interfejs i global physics ma własny Inspector;
- canonical Python export nie zawiera legacy konstruktorów;
- test SSR/hydration i responsywności Inspectorów;
- browser smoke dla FDM i FEM obejmujący utworzenie obiektu, modułu oraz
  ponowne otwarcie zapisanej sceny.

### 11.4. Granica kwalifikacji

Zielony kontrakt authoringu nie kwalifikuje solvera fizycznego. Każda rodzina
modułu zachowuje własną czteroliniową kwalifikację FDM CPU, FDM GPU, FEM CPU i
FEM GPU. Typ obiektu nigdy nie podnosi capability.

## 12. Sekwencja wdrożenia

1. Zamrozić `PhysicsObjectIR`, reguły ID/nazwy i migrację wersji.
2. Wprowadzić `PhysicsObjectHandle` oraz canonical script round-trip bez
   usuwania adapterów legacy.
3. Przenieść normalizację do `objects[]` i naprawić referencje graphu.
4. Zmaterializować wspólne zakresy w plannerze FDM/FEM i proweniencji.
5. Wprowadzić zasoby OpenAPI v2 oraz UI authoring nad jednym kontraktem.
6. Przebudować Explorer i Inspectory na rzeczywistych obiektach/modułach.
7. Uruchomić migracyjne golden fixtures, browser smoke i scenariusze
   naukowe bez transportu oraz z transportem.
8. Dopiero po pełnym dowodzie round-trip oznaczyć legacy konstruktory jako
   gotowe do usunięcia w przyszłej wersji głównej.

Każdy krok musi pozostawić repozytorium w stanie kompatybilnym i testowalnym.
Nie wolno przejściowo tworzyć dwóch konkurencyjnych źródeł prawdy dla
obiektów.

## 13. Kryteria ukończenia

Projekt jest wdrożony produkcyjnie dopiero, gdy:

- Python i UI tworzą to samo `objects[]` oraz `physics_graph`;
- rename nie zrywa żadnej referencji;
- brak modułu oznacza brak planowania i wykonania modułu w FEM i FDM;
- `type` nie tworzy ani nie aktywuje operatora;
- elektrody i interfejsy mają poprawne, zorientowane zakresy powierzchniowe;
- legacy fixture migrują deterministycznie albo failują z jednoznacznym
  raportem bez utraty danych;
- exporter generuje wyłącznie kanoniczne API;
- Explorer i Inspectory odzwierciedlają dokładny graph;
- OpenAPI, wygenerowane typy, klient, resource hooks i SceneDocument są
  zgodne;
- testy FDM i FEM dowodzą, że scenariusz bez prądu nie uruchamia transportu;
- capability i dokumentacja uczciwie rozróżniają semantykę, wykonanie,
  walidację numeryczną i kwalifikację produkcyjną.

## 14. Decyzje odroczone

Poza tym projektem pozostają nowe rodziny fizyki, nowe równania transportowe,
pole Oersteda i MTJ. Mogą korzystać z kompozycyjnego modelu po jego wdrożeniu,
ale nie rozszerzają zakresu tej migracji.

Nie dodajemy dowolnych tagów użytkownika do semantyki solvera. Jeżeli będą
potrzebne do organizacji sceny, powstaną jako osobne metadata prezentacyjne,
bez wpływu na `type`, graph i capability.
