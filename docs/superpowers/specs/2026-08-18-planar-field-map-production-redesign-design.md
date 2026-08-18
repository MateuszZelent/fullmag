# Produkcyjny redesign mapy pola 2D — specyfikacja projektowa

**Status:** projekt uzgodniony, oczekuje na akceptację zapisanej specyfikacji
**Data:** 2026-08-18
**Zakres:** `apps/control-room`, OpenAPI v2 i backendowe zasoby pól planarnych
**Powiązane kontrakty:**

- `docs/specs/frontend-v2/05-viewport-architecture.md`
- `docs/specs/frontend-v2/15-viewport-2d-module.md`
- `docs/adr/0011-resource-first-api.md`
- `docs/adr/0020-planar-field-map-and-monitor.md`

## 1. Cel

Mapa pola 2D ma być pełnoprawnym instrumentem naukowym porównywalnym pod
względem czytelności z widokiem pola w MuMax: z fizycznie poprawnymi osiami,
jednostkami, proporcjami domeny, czytelną poziomą legendą oraz prawdziwymi
danymi solvera. Airbox, obiekty, regiony i części siatki mają być niezależnymi,
jednocześnie komponowanymi warstwami, a Inspector ma edytować wyłącznie
wybrany target.

Projekt obejmuje cztery istniejące defekty:

1. interfejs pokazuje generyczne osie `u` i `v`, mimo że standardowe przekroje
   są zdefiniowane w kartezjańskich płaszczyznach `xy`, `xz` i `yz`;
2. pionowa legenda zasłania dane i nie ma jakości wymaganej od narzędzia
   naukowego;
3. backend planarnego zasobu `m` publikuje wyłącznie zera, chociaż kanoniczny
   zasób całego pola tej samej sesji jest niezerowy;
4. ustawienia warstw 2D są globalne, dlatego zmiana wireframe Airboxa zmienia
   również prezentację obiektu.

## 2. Potwierdzony stan obecny

### 2.1 Dane runtime i API

Problem został odtworzony na lokalnej sesji
`mumag_sp4_fdm_relax_projected_gradient_bb`:

- `GET /v2/sessions/current/data/fields/m/meta` dla rewizji pola `8` zwrócił
  zakres `[-0.0077686847303691286, 0.9999999904118213]`;
- telemetria tej sesji pokazała `avg mx = 0.967553`, `avg my = 0.124151` oraz
  `|avg m| = 0.975486`;
- planarne metadata dla tej samej rewizji zwróciły `occupied = 262144`,
  `empty = 0`, ale `scalar_min = scalar_max = 0`;
- bezpośrednio zdekodowany binarny FMVP planarnego endpointu zawierał `262144`
  próbki i ani jednej wartości niezerowej.

Nie jest to błąd autoskali, palety, maski ani dekodera w przeglądarce. Zerowy
payload powstaje w backendowym przepływie danych przed rendererem.

### 2.2 Rozjazd resolverów pola

`crates/fullmag-api/src/router_v2/handlers/data/fields.rs` preferuje w
`get_field_meta` wynik `resolve_transport_spatial_field`, który odczytuje
kanoniczny, niezerowy artefakt transportowy.

`crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`, w
`build_planar_field_from_source`, korzysta natomiast z
`resolve_current_spatial_field`. W odtworzonej sesji ten resolver dostarcza
zerowy nośnik pola. Powstają dwa różne znaczenia „bieżącego pola” w jednej
rodzinie zasobów v2.

Artefakt transportowy jest obecnie opakowany jako
`SpatialFieldCarrier::ArtifactLinear`. `resolve_spatial_target` słusznie
odrzuca ten carrier, ponieważ sam liniowy artefakt nie zawiera dokładnych
współrzędnych. Naprawa nie może polegać na pominięciu tej walidacji. Musi
bezpiecznie związać wartości artefaktu z opublikowanym carrierem przestrzennym
po sprawdzeniu jego tożsamości.

### 2.3 Osie i legenda

`apps/control-room/src/modules/field-map/FieldMapModule.tsx` wpisuje na stałe:

```tsx
u ({renderModel.display.axisUnit})
v ({renderModel.display.axisUnit})
```

`apps/control-room/src/design/styles/field-map.css` pozycjonuje te etykiety
absolutnie, a legendę umieszcza jako pionowy overlay po prawej stronie pola.
Układ nie rezerwuje miejsca na ticki i etykiety. Legenda przykrywa obraz przy
węższym panelu.

### 2.4 Globalny stan targetów

`PlanarVisualizationState` w
`crates/fullmag-api/src/schemas/visualization_state.rs` ma jeden globalny
`layers`, `wireframe_style`, `point_style`, `vector_style`, `range` i
`view_scope`.

`PlanarVisualizationSection.tsx` zapisuje każdy patch przez:

```ts
visualizationSync.queuePatch({ planar: next })
```

Patch nie zawiera tożsamości Airboxa ani obiektu. Przeciek ustawień między
targetami jest więc skutkiem publicznego modelu stanu, a nie tylko błędem
lokalnego komponentu.

## 3. Zatwierdzona decyzja produktowa

Przyjęto wielotargetową kompozycję 2D:

- Airbox, obiekty, regiony i części siatki mogą być widoczne jednocześnie;
- każdy target ma własny profil prezentacji 2D;
- zaznaczenie w Explorerze wybiera target edytowany w Inspectorze, ale nie
  ukrywa pozostałych targetów;
- wspólne pozostają płaszczyzna, pozycja cięcia, kamera, rozdzielczość oraz
  kolejność kompozycji;
- profile 2D są niezależne od profili 3D, ale używają tej samej kanonicznej
  tożsamości targetu.

Odrzucono:

- jeden globalny profil z wyjątkami per Inspector;
- automatyczne kopiowanie stylów 3D do 2D;
- jeden target renderowany naraz;
- wnioskowanie targetu z nazwy obiektu lub aktualnego zaznaczenia bez
  jawnego `target_ref`.

## 4. Docelowy kontrakt stanu

### 4.1 Podział odpowiedzialności

`PlanarVisualizationState` zostaje rozdzielony logicznie na:

```text
planar
├── viewport
│   ├── source
│   ├── default_slice
│   ├── interaction
│   ├── resolution
│   └── quality
├── active_target_ref
├── composition_order[]
└── target_profiles[]
```

`viewport` opisuje jeden fizyczny przekrój i kamerę. `target_profiles`
opisuje, jak poszczególne targety są prezentowane w tym przekroju.

### 4.2 Tożsamość targetu

`PlanarTargetRef` jest typem dyskryminowanym:

```text
domain
airbox
object(object_id)
region(object_id, region_id)
mesh_part(mesh_part_id, object_id?)
```

Identyfikatory pochodzą z kanonicznego modelu sceny i zasobów meshing.
`name` oraz typ prezentacyjny nie uczestniczą w identyfikacji ani aktywowaniu
fizyki.

### 4.3 Profil targetu

Każdy `PlanarTargetProfile` posiada:

- `target_ref`;
- `visible`;
- `quantity_id` oraz `component`;
- `colormap`, `range`, `display_unit`, `raster_opacity`;
- przełączniki `raster`, `contours`, `mesh`, `boundaries`, `points`,
  `vectors`, `probes`, `bounds`;
- `wireframe_style`, `point_style`, `vector_style`;
- revision profilu lub revision całego zasobu prezentacji.

Zmiana profilu Airboxa nie może modyfikować żadnego pola profilu obiektu.
Patch bez `target_ref` jest niedozwolony dla pól target-scoped.

### 4.4 Wspólne i lokalne ustawienia

Wspólne dla widoku:

- source i definicja płaszczyzny;
- pozycja lub grubość cięcia;
- pan/zoom/fit;
- rozdzielczość oraz jakość próbkowania;
- kolejność kompozycji.

Lokalne dla targetu:

- quantity/component;
- widoczność i display passes;
- paleta, zakres, opacity;
- wireframe, punkty, wektory i kontury.

## 5. Docelowy kontrakt danych pola

### 5.1 Jeden resolver prawdy

Wszystkie zasoby pola v2 muszą korzystać z jednego kanonicznego procesu:

1. wybierz najnowszy naukowo poprawny payload quantity;
2. określ requested intent i resolved provenance;
3. rozwiąż dokładny carrier przestrzenny bieżącej generacji;
4. sprawdź komponenty, cardinality, grid/topology, generation i revision;
5. zwiąż payload z carrierem;
6. dopiero wtedy wykonaj scope selection i sampling.

Nie wolno ponownie obliczać pola w UI ani używać preview jako ukrytego
zamiennika pełnego zasobu.

### 5.2 Wiązanie artefaktu transportowego

Dla FDM artefakt transportowy może zostać przekształcony w carrier nadający
się do samplowania tylko wtedy, gdy:

- `grid_cells` równa się opublikowanemu gridowi domeny;
- liczba wartości równa się `nx * ny * nz * n_comp`;
- generation artefaktu zgadza się z generation domeny;
- revision i source provenance są dodatnie i spójne;
- dokładne `origin_m` i `cell_size_m` pochodzą z bieżącego certyfikatu domeny;
- membership, jeśli wymagany przez target, ma tę samą tożsamość gridu.

Dla FEM payload musi zostać związany z topology revision/hash oraz jawnym
mappingiem wartości do nodal/element entities. Artefakt bez dokładnego mappingu
pozostaje niesamplowalny.

### 5.3 Zachowanie przy niespójności

Niespójność nie jest konwertowana do zer. API zwraca jawny błąd, np.:

- `409 field_carrier_mismatch`;
- `409 stale_field_revision`;
- `422 unsupported_planar_target`;
- `422 unsupported_planar_operator`.

Prawidłowe fizycznie pole zerowe pozostaje legalne. Rozpoznaje się je na
podstawie poprawnej tożsamości źródła, carriera i payloadu, a nie na podstawie
heurystyki `min == max == 0`.

### 5.4 Target-scoped sampling

Żądanie planarne niesie `target_ref`, z którego backend rozwiązuje scope.
Rozwiązany target trafia do sample tokenu oraz ETag. Zmiana stylu nie zmienia
sample tokenu. Zmiana targetu, quantity, component, płaszczyzny, operatora,
rozdzielczości lub rewizji pola musi zmienić sample token.

Planarne metadata publikują co najmniej:

- `target_ref` i target carrier identity;
- `quantity_id`, `component`, canonical unit;
- field, carrier, mesh/topology i source revisions;
- source kind oraz backend/device/precision provenance;
- frame, operator i resolution;
- occupancy oraz prawdziwy scalar range;
- sample token i linki do binarnych zasobów.

## 6. Docelowa prezentacja naukowa

### 6.1 Rama wykresu

Canvas nie zajmuje już całego stage pod absolutnie pozycjonowanymi napisami.
`PlanarPlotFrame` rezerwuje jawne obszary na:

- tytuł przekroju;
- lewą oś;
- dolną oś;
- obszar danych;
- odczyt kursora;
- poziomą legendę.

Obszar danych zachowuje fizyczny aspect ratio z bounds przekroju. Resize może
dodawać wolny margines, ale nie rozciąga jednej osi niezależnie od drugiej.

### 6.2 Osie kartezjańskie

Wewnętrzne `u` i `v` pozostają legalnymi współrzędnymi samplera, lecz nie są
domyślnym językiem użytkownika.

Mapowanie standardowych płaszczyzn:

| Płaszczyzna | Oś pozioma | Oś pionowa | Podpis cięcia |
|---|---|---|---|
| `xy` | `x` | `y` | `z = wartość` |
| `xz` | `x` | `z` | `y = wartość` |
| `yz` | `y` | `z` | `x = wartość` |

Płaszczyzna ukośna nie może być fałszywie podpisana jako osiowo kartezjańska.
Otrzymuje `x′` i `y′` oraz widoczne wektory kierunkowe w bazie świata.

Ticki:

- używają algorytmu nice-number;
- mają wspólną jednostkę długości na obu osiach;
- wybierają spośród `nm`, `µm`, `mm`, `m`;
- używają cyfr tablicowych;
- nie nakładają się przy wąskim panelu;
- aktualizują się wraz z pan/zoom bez ponownego samplowania pola.

### 6.3 Pozioma legenda

`PlanarColorLegend` znajduje się pod obszarem danych i nie jest overlayem.
Zawiera:

- `quantity · component`;
- display unit;
- poziomy gradient;
- minimum po lewej, maksimum po prawej;
- 5–7 czytelnych ticków zależnie od szerokości;
- wyróżnione zero dla zakresu symetrycznego;
- jawny stan `Uniform wartość` dla stałego pola;
- jawny stan loading/stale/error zamiast nieaktualnych liczb.

Zakres manualny pozostaje w SI w stanie kanonicznym. Konwersja jednostek jest
wyłącznie prezentacyjna.

### 6.4 Odczyt kursora

Hover i pinned probe pokazują pełną pozycję świata:

```text
x = 120 nm · y = −35 nm · z = 1.5 nm · |m| = 0.998
```

Dla targetów nakładających się odczyt wskazuje target oraz źródło wartości.
Pinned probe pozostaje backendowym, revision-safe zapytaniem; lokalny hover
jest tylko szybką interpolacją/render readout.

### 6.5 Kompozycja targetów

Każdy target jest osobną warstwą modelu renderowania. Kolejność kompozycji jest
deterministyczna i zapisana w `composition_order`.

Minimalne zasady:

- raster targetów jest clipowany occupancy/target maską;
- Airbox bounds/wireframe nie dziedziczy opacity rastera obiektu;
- wireframe, punkty i wektory każdego targetu używają własnego profilu;
- wybrany target może otrzymać nieinwazyjny outline selection;
- ukrycie targetu nie usuwa ani nie resetuje jego profilu;
- zmiana zaznaczenia nie modyfikuje widoczności innych targetów.

## 7. Podział komponentów frontendowych

`FieldMapModule.tsx` przestaje być jednocześnie kontrolerem zasobów,
builderem modelu, ramą wykresu, legendą i diagnostyką.

Docelowe odpowiedzialności:

- `FieldMapModule` — aktywność modułu i składanie wysokopoziomowych części;
- kontroler zasobów planarnych — query identity, revisions, stale/error;
- builder kompozycji — `PlanarTargetResource` →
  `PlanarTargetRenderModel[]`;
- `PlanarPlotFrame` — layout, osie, ticki, aspect ratio;
- `PlanarCanvasStack` — lifecycle bazowego i overlay canvasa;
- `PlanarColorLegend` — legenda i range state;
- `PlanarCursorReadout` — hover/pinned coordinates;
- target-scoped Inspector — edycja jednego profilu przez `target_ref`.

Granice te są projektowe; plan wdrożeniowy ma dopasować dokładne nazwy i
ścieżki do istniejących wzorców bez mechanicznego dzielenia plików.

## 8. Lifecycle i wydajność

- jedna instancja renderera na mount `field-map`;
- jeden base canvas i jeden overlay canvas dla całej kompozycji;
- żadnego osobnego canvasa na target;
- topology/geometry update jest oddzielony od field-buffer update;
- style-only patch nie pobiera pola i nie przebudowuje geometrii;
- pan/zoom aktualizuje viewport i chrome bez ponownego samplowania;
- worker otrzymuje stabilne zadania po sample identity;
- ResizeObserver jest jedynym źródłem resize;
- brak interval-driven redraw;
- brak ciągłego RAF w idle;
- typed arrays pozostają poza React state;
- worker, observer, animation frame i bufory są zwalniane na unmount;
- liczba jednocześnie pobieranych targetów podlega jawnej polityce budżetu,
  bez cichego obniżania jakości aktywnych warstw.

## 9. Stany użytkownika i diagnostyka

Widok rozróżnia:

- loading;
- ready;
- stale;
- field pending materialization;
- no published field;
- empty intersection;
- valid uniform field;
- carrier mismatch;
- decode failure;
- unsupported target/operator;
- degraded overlay classification.

Stan błędu nie pozostawia poprzedniej legendy jako rzekomo aktualnej. Ostatni
dobry obraz może być zachowany wyłącznie jako jawnie oznaczony `stale` z jego
revision i target identity.

Diagnostyka musi pokazać przynajmniej field revision, sample token, target,
carrier identity, source kind, backend/device/precision oraz powód degradacji.

## 10. Migracja kontraktu

Zmiana jest kontraktem OpenAPI v2, nie lokalnym patchem komponentu.

Kolejność migracji:

1. uzupełnić specyfikację/ADR o target-scoped planar profiles i jeden resolver
   pola;
2. zmienić backendowe schematy i route semantics;
3. zregenerować OpenAPI v2, TypeScript types i generated transport;
4. zmienić handwritten facade, query identity, cache keys i resource hooks;
5. dodać adapter migracyjny starego pojedynczego profilu do profilu `domain`;
6. przełączyć Inspector i renderer na nowe profile;
7. usunąć adapter dopiero po spełnieniu jawnych kryteriów migracji.

Frontend nie może ręcznie budować ścieżek `/v2`. HTTP pozostaje źródłem
snapshotów, a WebSocket wyłącznie invaliduje odpowiednie profile/zasoby.

## 11. Strategia testów

### 11.1 Backend manufactured tests

- FDM: analityczne, niejednorodne `m(x,y,z)` dla `xy`, `xz`, `yz`;
- FDM: payload transportowy niezerowy plus zerowy legacy live carrier — planar
  musi wybrać kanoniczny payload;
- FDM: mismatch grid/generation musi zwrócić `409`, nie zera;
- FEM P1: liniowe pole i barycentryczna zgodność trzech płaszczyzn;
- occupancy, target masks i niezależne object/Airbox scopes;
- sample token zmienia się tylko dla zmian tożsamości danych;
- prawidłowe pole identycznie zerowe pozostaje `ready` i `uniform`.

### 11.2 Kontrakt API

- OpenAPI target refs i target profiles round-trip;
- wygenerowane typy i transport kompilują się bez ręcznych poprawek;
- meta oraz binary scalar mają tę samą sample identity;
- planar range zgadza się z bezpośrednio zdekodowanym binary payloadem;
- ETag/304 i stale revision działają per target;
- websocket invaliduje właściwy target bez publikowania ciężkiego payloadu.

### 11.3 Frontend unit/integration

- mapowanie `xy/xz/yz` na `x/y/z`;
- ukośna płaszczyzna używa `x′/y′` i wektorów kierunkowych;
- nice ticks i jednostki dla nm/µm/mm/m;
- pozioma legenda: auto, symmetric, manual, uniform, stale, error;
- aspect ratio pozostaje fizyczny po resize;
- patch Airboxa nie zmienia profilu obiektu i odwrotnie;
- style-only patch nie wykonuje field fetch;
- zmiana target/quantity/plane/revision wykonuje właściwy fetch;
- kompozycja i clipping kilku targetów są deterministyczne;
- cleanup renderer/worker/observer na zmianie taba.

### 11.4 Browser qualification

- SP4 pokazuje niezerowe `m` oraz zakres zgodny z API;
- `xy`, `xz`, `yz` mają poprawne osie i podpis normalnej;
- Airbox i obiekt są widoczne jednocześnie i mają niezależny wireframe;
- przełączenie targetu zachowuje scroll/focus/drafts Inspectora;
- Mocha i Latte mają czytelne osie, legendę i focus rings;
- kilka szerokości panelu nie powoduje kolizji etykiet;
- 100 przełączeń targetów/tabów nie zwiększa liczby canvasów, workerów,
  observerów ani listenerów;
- idle ma zero nieuzasadnionych klatek;
- po powrocie do 3D WebGL context jest zdrowy, a drawing buffer niezerowy.

## 12. Bramki akceptacji produkcyjnej

Zmiana jest gotowa dopiero, gdy wszystkie poniższe warunki są udowodnione:

1. API planarnego SP4 zwraca niezerowe próbki zgodne z kanonicznym polem;
2. nie istnieją dwa konkurencyjne resolvery znaczenia „current field” dla
   publicznych zasobów pola;
3. `xy/xz/yz` pokazują właściwe osie `x/y/z` i pozycję cięcia;
4. użytkownik nie widzi `u/v` dla osiowo kartezjańskich przekrojów;
5. legenda jest pozioma, nie zasłania danych i obsługuje uniform range;
6. fizyczny aspect ratio jest zachowany;
7. Airbox i każdy target mają niezależne profile 2D;
8. zmiana wireframe Airboxa nie zmienia żadnego obiektu;
9. style-only patch nie powoduje field refetch ani resampling;
10. błędna tożsamość danych kończy się jawnym błędem, nigdy zerowym fallbackiem;
11. OpenAPI, generated transport, facade, hooks, adapter i renderer są zgodne;
12. testy backendowe, frontendowe, browserowe, lifecycle i performance są
    zielone;
13. nie pozostaje nieudokumentowana ścieżka legacy ani komponentowy `fetch()`.

## 13. Poza zakresem

- zmiana fizycznej definicji PlanarMonitor;
- dodanie nowych operatorów samplowania;
- zastąpienie Canvas 2D przez WebGL lub ECharts;
- zmiana palety Catppuccin;
- ukryte obniżanie rozdzielczości albo jakości aktywnych warstw;
- połączenie profili 2D i 3D w jeden wspólny profil prezentacji;
- przebudowa całego Inspectora niezwiązana z target-scoped 2D state.

## 14. Punkt kontynuacji

Po zatwierdzeniu tej specyfikacji należy utworzyć szczegółowy plan
wdrożeniowy w `docs/superpowers/plans/`. Plan ma rozdzielić co najmniej:

1. regresję i naprawę kanonicznego resolvera pola;
2. kontrakt target refs/profiles w OpenAPI;
3. facade, hooks i query/cache identity;
4. wielotargetowy render model;
5. kartezjańską ramę wykresu i poziomą legendę;
6. target-scoped Inspector i migrację stanu;
7. browser/lifecycle/performance qualification.

Każdy etap musi mieć test RED przed implementacją, dokładne komendy
weryfikacyjne i niezależną bramkę akceptacji.
