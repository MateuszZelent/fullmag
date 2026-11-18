# ADR 0080: warstwy pól 2D, kadr z dopróbkowaniem i sonda najbliższego węzła

- Status: przyjęte (Accepted)
- Data: 2026-11-12
- Uzupełnia: [ADR 0020](0020-planar-field-map-and-monitor.md), decyzje 1 i 4
- Kontrakt fizyczny:
  [`docs/physics/0970-planar-monitor-sampling-and-projection.md`](../physics/0970-planar-monitor-sampling-and-projection.md),
  sekcje `planar-monitor-sampling-window` i `planar-monitor-nearest-node`
- Specyfikacje:
  [15 — widok 2D](../specs/frontend-v2/15-viewport-2d-module.md),
  [23 — wizualizacja per obiekt](../specs/frontend-v2/23-per-object-visualization-control.md),
  [12 — wstążka i komendy](../specs/frontend-v2/12-ribbon-toolbar-command-system.md)
- Plan wdrożenia:
  [`docs/superpowers/plans/2026-11-12-viewport-2d-toolbar-layers-crop-node-inspect.md`](../superpowers/plans/2026-11-12-viewport-2d-toolbar-layers-crop-node-inspect.md)

## Kontekst

Widok 2D (`field-map`) ma nad płótnem tekstowy pas kontrolek
(`FieldMapToolbar`, `PlanarSectionStrip`): Quantity, Component, Scope,
XY/XZ/YZ, Single layer/Average, Free section oraz przełączniki
Arrows/Lines/Mesh/Slices. Zoom kółkiem, pan, fit dwuklikiem, sonda i profil
(Shift+przeciąganie) istnieją, ale bez przycisków i jawnych trybów. O tym, co
jest rysowane, decydują jednocześnie pole bazowe (`planar.quantity_id`,
`component`, `view_scope`, …) i lista nakładek `planar.field_overlays`
ograniczona do 4 (`PLANAR_FIELD_OVERLAYS_MAX`). Klient nie dostaje węzłów
siatki, a `/probe` zwraca tylko wartość w punkcie. Nie da się ograniczyć
próbkowania do fragmentu ramki — zoom powiększa raster o stałej
rozdzielczości.

ADR 0020 ustala: stan prezentacji 2D jest sesyjny i nie trafia do
`SceneDocument`, `ProblemIR` ani Pythona (pkt 1–2), dane pól płaskich są
osobnymi, ograniczonymi zasobami OpenAPI v2 (pkt 4), a płótno 2D to Canvas 2D +
worker, bez WebGL (pkt 5).

## Decyzja

### Decyzje użytkownika (2026-11-12)

| # | Decyzja |
|---|---|
| U1 | Kontrolki Quantity, Component, Scope, XY/XZ/YZ, Single layer/Average, Free section oraz tekstowe Arrows/Lines/Mesh/Slices znikają znad płótna. |
| U2 | Nad płótnem jest pasek narzędzi z ikonami (wzorzec 3ds Max). |
| U3 | Wszystko, co decyduje o tym, co jest wyświetlane, ustawia się w zakładce 2D inspektora, per obiekt, jak w 3D. |
| U4 | Suwak pozycji przekroju zostaje w cienkim pasku pod płótnem. Wybór płaszczyzny i trybu przekroju idzie do inspektora. |
| U5 | Inspektor węzła powstaje od razu z rozszerzonym backendem: `/probe` zwraca najbliższy węzeł FEM lub środek komórki FDM. |
| U6 | Kadr ogranicza widoczny zakres u/v, a backend próbkuje raster ponownie tylko dla kadru. Eksport obejmuje kadr. Kadr jest zapisywany w stanie sesji. |
| U7 | Jedna lista warstw: znika rozróżnienie pole bazowe / nakładki, limit 4 zostaje podniesiony. |

### Decyzje wykonawcze

| # | Decyzja | Uzasadnienie |
|---|---|---|
| W1 | Pasek narzędzi jest poziomy, zadokowany nad płótnem. | Nie zabiera szerokości płótna. |
| W2 | Nazwa pola `planar.field_overlays` na drucie zostaje. W UI i dokumentach nazywa się „warstwy pól” (*field layers*). | Zmiana nazwy łamałaby zapisane sesje i klienta bez zysku funkcjonalnego. |
| W3 | Limit warstw: `PLANAR_FIELD_LAYERS_MAX = 16`. Dane ładują się tylko dla warstw widocznych. | Każda warstwa to osobna próbka (meta + skalar + wektory + maska); koszt ogranicza widoczność. |
| W4 | Warstwa ma cel `monitor_target` („Wszystkie obiekty”), `airbox` albo konkretny obiekt/region. Nowa sesja startuje z jedną warstwą `all` (m, kierunek). | Backend nie zna obiektów w chwili tworzenia stanu domyślnego; klient nie może zapisywać stanu przy montowaniu. |
| W5 | Przełączniki w pasku narzędzi to maski całego widoku (`planar.layers.*`). Flagi per warstwa decydują, które warstwy w danej masce uczestniczą. Efekt = maska widoku AND flaga warstwy. | Jedno kliknięcie wyłącza przebieg bez utraty ustawień per obiekt. |
| W6 | Zoom ramką zmienia tylko `planar.interaction` (bez dopróbkowania). Kadr zmienia okno próbkowania. | Dwa narzędzia o różnym koszcie, rozdzielone ikoną i nazwą. |
| W7 | Wieloprzekrój (Slices) rysuje pierwszą widoczną warstwę z listy. | Panele współdzielą jedną wielkość; reguła deterministyczna, bez nowego stanu. |
| W8 | Wybór obiektu kliknięciem na płótnie 2D jest poza zakresem. | Wymaga osobnego kontraktu trafień. |
| W9 | Odczyt węzła przy operatorze `slab_average` i `depth_projection` jest niedostępny i jawnie tak oznaczony. | Wartość uśredniona po grubości nie ma jednego węzła źródłowego. |

### Model warstw (`planar`, `schemas/visualization_state.rs`)

- `PLANAR_FIELD_LAYERS_MAX = 16` zastępuje `PLANAR_FIELD_OVERLAYS_MAX = 4` we
  wszystkich użyciach.
- `PlanarVisualizationState.layer_model: PlanarLayerModel` (`legacy | layers`,
  domyślnie przy deserializacji `legacy`) oraz
  `crop: Option<PlanarCropState>` (`u_min_m`, `u_max_m`, `v_min_m`,
  `v_max_m`; `deny_unknown_fields`).
- `PlanarVisualizationPatch.layer_model: Option<PlanarLayerModel>` oraz
  `crop` z podwójną opcją: pominięcie nie zmienia kadru, `"crop": null` go
  czyści.
- `PlanarFieldOverlayState` dostaje flagi z wartościami domyślnymi:
  `visible = true`, `points_visible`, `mesh_visible`, `contours_visible`,
  `streamlines_visible` = `false`. Istniejące `raster_visible` i
  `vectors_visible` pozostają.
- Przy `layer_model = layers` pola bazowe `quantity_id`, `component`,
  `colormap`, `range`, `raster_opacity`, `view_scope` nie są rysowane. Próbka
  bazowa służy wyłącznie do `meta` (ramka, przekrój, liczba przeciętych
  elementów) oraz `mesh-overlay`, gdy maska siatki jest włączona.
- Stan domyślny nowej sesji: `layer_model = layers` i jedna warstwa
  `{ id: "all", view_scope: monitor_target, quantity_id: "m",
  component: magnitude, colormap: "hsl_direction", visible: true,
  raster_visible: true }`.
- Kolejność listy jest kolejnością rysowania: pierwsza warstwa leży na
  wierzchu, rysowanie przebiega od końca listy.
- Efektywny przebieg warstwy (`raster`, `vectors`, `points`, `mesh`,
  `contours`, `streamlines`) to `planar.layers.<pass> AND flaga warstwy`,
  pod warunkiem `visible = true`. Flaga włączona przy wyłączonej masce widoku
  ma stan „masked” i jest pokazywana jako włączona z dopiskiem „ukryte w pasku
  narzędzi”.
- Walidacja PATCH: najwyżej 16 warstw, unikalne niepuste `id`, znana
  wielkość, niepusta mapa kolorów; komunikat
  `planar.field_overlays must contain at most 16 entries`.
- Walidacja kadru: wszystkie wartości skończone, `u_min_m < u_max_m`,
  `v_min_m < v_max_m`; inaczej 400 `invalid_planar_crop`. Zmiana
  `default_slice.plane` albo `source` w patchu bez nowego kadru czyści `crop`
  w tym samym patchu (kadr w osiach u/v starej płaszczyzny traci sens).

### Migracja `legacy → layers`

Wykonuje ją `migrate_planar_layer_model` przy odtwarzaniu sesji
(`session_persistence.rs`), tylko dla `layer_model = legacy`:

1. Jeśli `planar.layers.raster` lub `planar.layers.vectors` było włączone,
   pole bazowe staje się warstwą `all` na **końcu** listy (rysowaną pod
   spodem), z `view_scope` pola bazowego i flagami
   `raster_visible`/`vectors_visible` skopiowanymi z `planar.layers`. Gdy oba
   były wyłączone, warstwa `all` nie powstaje.
2. Istniejące nakładki zachowują kolejność i dostają `visible = true`.
3. `layer_model` zmienia się na `layers`.

Migracja jest idempotentna: ponowne wywołanie na stanie `layers` nic nie
zmienia. Po migracji użytkownik widzi ten sam obraz co przed nią (ta sama
wielkość pod spodem, te same nakładki nad nią).

### Okno próbkowania (kadr)

- `PlanarFieldQuery`, `PlanarFieldProbeQuery` i `PlanarFieldProfileQuery`
  przyjmują opcjonalne `window_u_min_m`, `window_u_max_m`, `window_v_min_m`,
  `window_v_max_m`: wszystkie cztery albo żaden; częściowy zestaw to 400
  `invalid_planar_window`.
- Okno jest przycinane do pełnych granic ramki; puste przecięcie to 400
  `invalid_planar_window: window does not intersect the frame`.
- Raster jest próbkowany w oknie zgodnie z istniejącą polityką rozdzielczości
  zastosowaną do rozmiaru okna; `PlanarFieldFrameResource.bounds_uv_m` opisuje
  okno, nowe `full_bounds_uv_m: [f64; 4]` — pełną ramkę.
- Okno wchodzi do `PlanarSampleIdentity`, więc `sample_token` i ETagi różnią
  się między kadrami. Linki zasobów (`scalar`, `vectors`, `empty-mask`,
  `mesh-overlay`, `probe`, `render.png`) przenoszą parametry okna; eksport CSV
  i PNG używa tego samego okna.
- Sonda i profil liczą punkty względem pełnej ramki; okno tylko wskazuje
  próbkę, do której należą.
- Dotyczy źródła `Default` i monitorów autorskich. Kadr nie zmienia
  autorskiego monitora, `SceneDocument`, `ProblemIR` ani Pythona.

Definicja naukowa: równanie `eq-planar-sampling-window` w nocie 0970.

### Najbliższy węzeł w `/probe`

- `PlanarFieldProbeQuery.nearest: Option<String>`; jedyna dozwolona wartość
  to `node`, inna daje 400 `invalid_planar_probe`.
- `PlanarFieldProbeResource` dostaje `nearest_node:
  Option<PlanarProbeNodeResource>` oraz `nearest_node_status`.
  `PlanarProbeNodeResource` = `{ kind: "fem_node" | "fdm_cell_center",
  node_id: u32, world_m: [f64; 3], u_m, v_m, in_plane_distance_m,
  normal_offset_m (ze znakiem), scalar: Option<f64>,
  vector: Option<[f64; 3]> }`.
- FEM: spośród węzłów elementu zawierającego punkt sondy wybierany jest węzeł
  o najmniejszej odległości euklidesowej 3D od punktu; remis rozstrzyga niższy
  indeks węzła. Wartość to wartość stopnia swobody w tym węźle, bez
  interpolacji. FDM: środek komórki zawierającej punkt; wartość komórki.
  Składowa przechodzi przez `evaluate_point_component` z tym samym żądaniem
  co wartość w punkcie.
- `nearest_node_status`: `not_requested` (brak `nearest=node`), `ok`,
  `empty` (punkt poza celem albo poza ramką), `unsupported_operator`
  (operator inny niż `plane_sample`), `unsupported_quantity` (wielkość bez
  wartości węzłowych ani komórkowych). Wartość w punkcie jest zwracana zawsze
  niezależnie od statusu węzła.
- Implementacja: `PlanarTarget::nearest_node(point, entity_id) ->
  Option<PlanarNearestNode>` w `planar_sampling/target.rs`.

Definicja naukowa: równanie `eq-planar-nearest-node` w nocie 0970.

### Interfejs (szczegóły w specyfikacjach 15, 23 i 12)

- Układ widoku A/B/C/D: pasek narzędzi, płótno z osiami, legenda (karta na
  widoczną warstwę), pasek stanu z suwakiem pozycji, współrzędnymi kursora,
  zoomem i znacznikiem kadru.
- Narzędzia `navigate | zoom-box | crop | inspect | profile | measure` są
  efemerycznym stanem klienta (`kernel/visualization/planarToolStore.ts`),
  nie trafiają do stanu sesji; zamknięcie lub przełączenie widoku 2D wraca do
  `navigate`.
- Pasek, wstążka, skróty i paleta renderują te same komendy
  `field-map.tool.*`, `field-map.toggle-*`, `field-map.zoom-in`,
  `field-map.zoom-out`, `field-map.fit`, `field-map.clear-crop`.

## Relacja do ADR 0020

- **Uzupełnia pkt 1:** `layer_model`, lista warstw, kadr i narzędzia są tak jak
  `Default` stanem sesji; nie powstaje żaden monitor, wpis `SceneDocument`,
  `ProblemIR` ani linia kanonicznego Pythona.
- **Uzupełnia pkt 4:** okno próbkowania i odczyt węzła są nowymi parametrami
  istniejących zasobów v2 pól płaskich (próbka, `probe`, `profile`), z
  regeneracją OpenAPI i typów TS; WebSocket pozostaje wyłącznie unieważnianiem.
- **Nie zmienia pkt 5:** płótno 2D pozostaje Canvas 2D + worker. Nakładki
  narzędzi są DOM/SVG; żadnego Three.js, R3F ani WebGL w `field-map`.
- Pkt 8 (sparse `target_overrides`) pozostaje bez zmian; warstwy pól nie są
  drugim rejestrem tożsamości celów, a ich `view_scope` używa tej samej
  kanonicznej tożsamości.

## Konsekwencje

- Jedna lista warstw zastępuje parę „pole bazowe + nakładki”; inspektor 2D
  pokazuje ją per obiekt, a zaznaczenie obiektu lub Airboxa w drzewie zaznacza
  jego warstwę.
- Liczba zapytań danych rośnie z liczbą widocznych warstw (najwyżej 16);
  warstwy ukryte nie generują zapytań. Pomiar przy 1, 4 i 16 warstwach jest
  wymaganą bramką.
- Kadr kosztuje nowe próbkowanie przy każdej zmianie; zoom ramką nic nie
  kosztuje po stronie backendu.
- Stare sesje odtwarzają się bez zmiany obrazu dzięki migracji `legacy →
  layers`; stary klient czytający `field_overlays` nadal działa (nowe pola mają
  wartości domyślne).
- Odczyt węzła jest dostępny tylko dla `plane_sample`; dla operatorów
  uśredniających klient pokazuje wartość w punkcie i powód niedostępności.

## Walidacja

- Testy Rust z planu (Zadania 2–4) są pisane, ale **NIE URUCHOMIONE**, dopóki
  obowiązuje zakaz kompilowania testów jednostkowych; dozwolone są
  `just check-api-source` i `just check-cli-source`.
- Bramki naukowe PM-N30 (okno) i PM-N31 (najbliższy węzeł) w nocie 0970.
- Testy Vitest i scenariusze `smoke-viewport-2d.mjs` wymienione w
  specyfikacji 15 §6; dowód przeglądarkowy na grupie Docker DEV worktree.
  Wynik bez dowodu z uruchomienia oznacza „NIE ZWERYFIKOWANO”.
- Regresja inspektora dla Obiektu i Airboxa (`smoke-inspector.mjs`): bez
  remontowania panelu i resetu przewijania po mutacji listy warstw.

## Wycofanie

Pasek narzędzi, pasek stanu i inspektor 2D można wycofać bez zmiany stanu
sesji. Wycofanie modelu warstw (powrót do pola bazowego i limitu 4) wymaga
osobnej, jawnej migracji `layers → legacy`; nie wolno przy tym po cichu usuwać
warstw użytkownika ani zmieniać `ProblemIR`. Parametry `window_*` i `nearest`
są addytywne; ich usunięcie nie zmienia próbek bez okna.
