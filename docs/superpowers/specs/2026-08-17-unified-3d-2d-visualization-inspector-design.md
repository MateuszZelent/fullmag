# Wspólny Inspector wizualizacji 3D/2D — projekt

**Status:** projekt do akceptacji przed implementacją  
**Data:** 2026-08-17  
**Zakres:** `apps/control-room`, zasób `visualization/state.planar`, renderer `field-map`

## 1. Decyzja

Fullmag będzie miał jeden wspólny Inspector wizualizacji. Tryby 3D i 2D nie
będą miały dwóch niezależnych układów kontrolek. Oba warianty użyją tej samej
kompozycji, tych samych sekcji, tych samych prymitywów interakcji i tej samej
kolejności wspólnych ustawień.

Różnica pomiędzy trybami będzie ograniczona do:

- adaptera mapującego wspólne pojęcia wizualizacji na stan renderera 3D albo 2D;
- capability gatingu wynikającego z targetu i dostępnych danych;
- dodatkowych sekcji 2D dotyczących źródła, ramki przekroju, operatora
  próbkowania i rozdzielczości.

Quiver, wireframe, points, bounds, koloryzacja ilości, opacity, colorbar i
zakres wartości są wspólnymi pojęciami wizualizacji. Nie są traktowane jako
funkcje właściwe wyłącznie dla 3D.

## 2. Problem w stanie bieżącym

Obecny tryb 3D używa rozbudowanej kompozycji opartej o
`ObjectVisualizationOverview`, sekcje Display, Render Mode, Surface Coloring,
Vectors, Points, Wireframe, Geometry Scope oraz diagnostykę.

Tryb 2D omija tę kompozycję i renderuje monolityczny
`PlanarVisualizationSection`. Skutki:

- Inspector 2D ma inną hierarchię i inny język interakcji niż 3D;
- warstwy 2D są pokazane jako surowa lista checkboxów;
- wspólne możliwości renderera wyglądają jak osobne funkcje;
- domyślny stan 2D włącza jednocześnie `raster`, `mesh` i `boundaries`, przez
  co heatmapa jest przykryta siatką;
- style quiver, wireframe i points są uboższe od odpowiadających im ustawień
  3D;
- rozwój obu Inspectorów powoduje dalszy drift.

## 3. Docelowa kompozycja

### 3.1. Wspólny szkielet

Oba tryby używają dokładnie tego samego szkieletu:

1. tożsamość Inspectora i przełącznik `3D | 2D`;
2. wspólny pasek metryk;
3. `Display`;
4. `Surface Coloring`;
5. `Vectors`;
6. `Points`, gdy warstwa jest aktywna i obsługiwana;
7. `Wireframe`, gdy warstwa jest aktywna i obsługiwana;
8. ustawienia widoku i jakości;
9. diagnostyka, provenance i reset profilu.

Tryb 2D dodaje, bez zastępowania wspólnych sekcji:

1. `Source & Slice` przed `Display`;
2. `Sampling & Resolution` w ustawieniach zaawansowanych;
3. dane operatora, ramki i rewizji źródła w provenance.

### 3.2. Wspólne sekcje i znaczenie w rendererach

| Sekcja / kontrolka | Renderer 3D | Renderer 2D |
|---|---|---|
| Visible | widoczność targetu | widoczność całej kompozycji planarnej bez utraty ustawień warstw |
| Shaded / Surface | powierzchnia shaderowa | raster heatmapy |
| Shaded + Wireframe | powierzchnia i krawędzie | raster oraz mesh/boundaries overlay |
| Wireframe | krawędzie geometrii | mesh/boundaries overlay bez rastra |
| Points | węzły/punkty nośnika | zajęte próbki/bin centers |
| Bounds | granice targetu | obrys zakresu ramki/próbkowania |
| Quantity Source | ilość pola targetu | `planar.quantity_id` |
| Component | projekcja ilości | `planar.component`: x/y/z/u/v/normal/magnitude/orientation |
| Surface Coloring | shader/paleta/zakres/opacity | paleta/range/display unit/raster opacity |
| Vectors | glyph layer 3D | quiver overlay nad heatmapą 2D |
| Wireframe style | kolor i opacity krawędzi | kolor i opacity mesh/boundaries |
| Points style | kolor, opacity i rozmiar | kolor, opacity i rozmiar markerów próbek |
| Colorbar | legenda aktywnej ilości | legenda aktywnej ilości i komponentu |

Kontrolki, których dany target nie może zrealizować, są capability-gated z
czytelnym powodem. Nie powstaje drugi układ Inspectora dla FDM ani FEM.

## 4. Render Mode 2D

`Render Mode` jest wspólnym komponentem interfejsu i pochodną warstw, a nie
drugim źródłem prawdy. Nie dodajemy `planar.render_mode`.

Mapowanie 2D:

| Tryb | raster | mesh | boundaries | points |
|---|---:|---:|---:|---:|
| Shaded / Heatmap | on | off | off | off |
| Shaded + Wireframe | on | on | on | off |
| Wireframe | off | on | on | off |
| Points | off | off | off | on |
| Off | off | off | off | off |

`Contours`, `Vectors`, `Probes` i `Bounds` są niezależnymi passami, podobnie
jak wektory i bounds w 3D. Zmiana trybu głównego nie kasuje ich konfiguracji.

Domyślny profil nowych sesji 2D to ciągła heatmapa:

```text
visible=true
raster=true
mesh=false
boundaries=false
contours=false
points=false
vectors=false
probes=true
```

Wyłączenie wireframe nie może wyłączyć rastra, zmienić zakresu koloru ani
unieważnić bufora scalar. Ma jedynie wyłączyć pobieranie i rysowanie overlayu
siatki, jeśli żaden inny pass go nie potrzebuje.

## 5. Architektura komponentów

### 5.1. Kompozycja wspólna

Powstanie neutralna kompozycja `VisualizationInspectorOverview`, używana przez
oba tryby. Nie fetchuje danych i nie zna OpenAPI. Przyjmuje gotowe sloty,
metryki i capability.

Współdzielone komponenty prezentacyjne:

- `VisualizationDisplayPassesControl`;
- `VisualizationRenderModeControl`;
- `VisualizationSurfaceColoringLayout`;
- `VisualizationVectorsLayout`;
- `VisualizationPointsLayout`;
- `VisualizationWireframeLayout`.

Komponenty te odpowiadają za układ, dostępność, klawiaturę i wygląd. Nie
patchują bezpośrednio stanu 3D ani 2D.

### 5.2. Adapter 3D

Adapter 3D zachowuje istniejący `VisualizationTargetSettings`, target
capabilities, target overrides, viewport preferences oraz aktualne komendy.
Refaktor nie zmienia wynikowej semantyki renderera 3D.

### 5.3. Adapter 2D

Adapter 2D korzysta wyłącznie z:

- `useVisualizationStateResource` i `visualizationSync.queuePatch`;
- katalogu quantities i canonical component availability;
- zasobów planar meta/mask/mesh/vector;
- `PlanarInspectorCapabilities`;
- źródła `Default` albo autorskiego `PlanarMonitor`.

Adapter buduje ten sam model kontrolek co 3D i mapuje operacje na
`planar.layers`, `planar.vector_style`, `planar.range`, `planar.resolution` oraz
ustawienia stylu planarnego.

Ciężkie bufory nie trafiają do React state ani store Inspectora.

## 6. Rozszerzenia stanu planarnego

Wspólne kontrolki nie mogą być pozorne ani browser-local. Brakujące ustawienia
stylu 2D zostaną dodane do `PlanarVisualizationState` i
`PlanarVisualizationPatch`, z defaultami i migracją sesji:

- globalne `visible`;
- `viewport_colorbar_visible`;
- styl wireframe: kolor i opacity;
- styl points: kolor, opacity i rozmiar;
- rozszerzony styl vector: opacity, thickness i monochrome color.

Istniejące pola pozostają kanoniczne:

- `raster_opacity` dla heatmapy;
- `colormap`, `range`, `display_unit` dla colorbar;
- `vector_style.length_mode`, `color_mode`, `scale`;
- `resolution.vector_budget` dla liczby glyphów;
- `layers` dla aktywnych passów.

Zmiany kontraktu rozpoczynają się w schematach Rust/OpenAPI, następnie są
regenerowane typy TypeScript, adapter frontendowy i renderer. Nie wolno
dopisywać ręcznych typów zastępujących wygenerowany kontrakt.

## 7. Kontrolki specyficzne dla 2D

`Source & Slice` zawiera:

- `Source`: `Default`, następnie monitory użytkownika;
- dla `Default`: `XY | XZ | YZ`;
- suwak położenia na osi normalnej;
- współrzędną SI;
- operator `Plane sample | Slab average`;
- grubość dla `Slab average`;
- odczyt target scope.

Dla monitora Inspector pokazuje aktywną ramkę, operator i target. Edycja
definicji monitora pozostaje w dedykowanym Inspectorze monitora; wspólny
Inspector wizualizacji wybiera tylko źródło i profil prezentacji.

`Sampling & Resolution` zawiera:

- interactive/export quality;
- width/height;
- vector budget;
- zoom i reset widoku;
- capability status dla FDM/FEM i wybranego operatora.

## 8. Renderer 2D

Renderer zachowuje jeden base Canvas dla rastra i jeden overlay Canvas dla
mesh, boundaries, contours, points, probes i quiver. Każdy pass ma niezależną
bramkę widoczności i styl.

Zasady:

- `visible=false` czyści oba canvasy, ale nie niszczy profilu;
- `mesh=false` i `boundaries=false` nie pobierają mesh overlayu;
- `vectors=false` nie pobiera bufora vector;
- `raster=false` nie uruchamia colorizera;
- quiver jest rysowany nad heatmapą i może działać z rasterem włączonym lub
  wyłączonym;
- wireframe jest overlayem, a nie alternatywnym rendererem;
- zmiana warstwy nie remountuje Canvas, workera ani resource controllerów;
- kolory Canvas są rozwiązywane z tokenów `--fm-*`.

## 9. Stan, synchronizacja i reset

Wspólny Inspector zachowuje semantykę `liveViewport`:

- zmiany są natychmiastowe;
- optimistic presentation dotyczy wyłącznie pól prezentacyjnych;
- identity fields (`source`, `quantity`, `component`, slice i scope) czekają na
  odpowiedź zasobu i nową sample identity;
- Reset przywraca pełny zapisany profil właściwego trybu;
- przełączenie 3D/2D nie kopiuje ustawień geometrycznych pomiędzy rendererami;
- wspólna intencja quiver może być przenoszona tylko przez jawny adapter.

## 10. Testy

### 10.1. Kompozycja Inspectora

- 3D i 2D renderują ten sam zestaw wspólnych nagłówków i tę samą kolejność;
- 2D dodaje `Source & Slice` i `Sampling & Resolution`;
- wspólne kontrolki używają tych samych komponentów, nie kopii JSX;
- capability gating ma opis przyczyny i zachowuje dostępność klawiaturową.

### 10.2. Semantyka trybów

- każdy tryb 2D daje dokładny patch warstw z tabeli;
- `Shaded` wyłącza mesh/boundaries i zostawia ciągłą heatmapę;
- niezależne vectors/contours/probes/bounds nie są kasowane;
- `Visible off/on` zachowuje poprzedni profil warstw;
- wireframe off nie zmienia quantity/component/range.

### 10.3. Renderer i zasoby

- raster i quiver renderują się równocześnie;
- mesh overlay znika bez wyczyszczenia rastra;
- wyłączony mesh nie uruchamia jego resource hooka;
- zmiana component unieważnia właściwy scalar/vector query key;
- zmiany stylu nie pobierają ponownie danych naukowych;
- renderer/worker powstaje raz na mount i jest zwalniany na unmount.

### 10.4. Kontrakt i migracja

- Rust serde/default/patch tests dla nowych pól;
- OpenAPI schema tests i regeneracja transportu;
- migracja zapisanej sesji ustawia brakujące style bez zmiany źródła i warstw;
- nowa sesja ma domyślnie heatmapę bez wireframe.

### 10.5. Browser smoke

Przeglądarkowa bramka obejmuje:

1. otwarcie 3D i zapis wspólnych sekcji Inspectora;
2. przełączenie do 2D bez tworzenia monitora;
3. potwierdzenie tych samych wspólnych sekcji i dodatkowego Source/Slice;
4. `Shaded`: niezerowy raster i zero segmentów mesh;
5. `Shaded + Wireframe`: ten sam raster i niezerowe segmenty mesh;
6. quiver nad heatmapą z niezerową liczbą glyphów;
7. zmianę x/y/z i świeżą sample identity;
8. powrót do 3D z żywym WebGL, niezerowym drawing bufferem i bez context loss.

## 11. Kryteria akceptacji

Implementacja jest zaakceptowana dopiero, gdy:

- istnieje jeden wspólny układ Inspectora, a nie dwa podobne panele;
- 3D zachowuje obecne funkcje i wygląd;
- 2D ma wszystkie wspólne passy oraz dodatkowe Source/Slice/Sampling;
- domyślny widok 2D jest ciągłą heatmapą bez mesh/boundaries;
- quiver, wireframe, points, bounds, contours i probes działają jako niezależne
  overlaye;
- ustawienia stylu są kanoniczne i round-tripują przez API;
- testy jednostkowe, kontraktowe, API/architecture hygiene i browser smoke są
  zielone albo ich zewnętrzny blocker jest udokumentowany bez deklarowania
  pełnej gotowości.

## 12. Poza zakresem

- zmiana numeryki próbkowania FDM/FEM;
- drugi renderer WebGL dla 2D;
- kopiowanie ECharts/Svelte/transportu Amumax;
- automatyczne tworzenie monitora przy wejściu do 2D;
- połączenie definicji `PlanarMonitor` z profilem quantity/palette;
- osobne Inspectory dla FDM i FEM.
