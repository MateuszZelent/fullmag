# Widok 2D: pasek narzędzi, warstwy pól per obiekt, kadr i inspektor węzła — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** Zastąpić tekstowy pas kontrolek nad widokiem 2D paskiem narzędzi z ikonami, przenieść wybór tego, co jest wyświetlane, do zakładki 2D inspektora jako jedną listę warstw pól per obiekt, oraz dodać brakujące narzędzia: zoom ramką, kadr z dopróbkowaniem, inspektor najbliższego węzła, linijkę i jawne przyciski nawigacji.

**Architektura:** Stan widoku 2D pozostaje sesyjnym `visualization/state.planar` (ADR 0020); nie trafia do SceneDocument, ProblemIR ani Pythona. `planar.field_overlays` staje się jedyną listą warstw pól, a pole bazowe zostaje wyłącznie nośnikiem ramki i przekroju. Pasek narzędzi, wstążka i skróty renderują te same komendy z rejestru; tryb narzędzia jest efemerycznym stanem klienta. Kadr i najbliższy węzeł są liczone w backendzie i wracają tym samym data plane co dziś.

**Stos:** Rust (`fullmag-api`, utoipa/OpenAPI), Next.js 16 / React / TypeScript, Canvas 2D + Web Worker, `lucide-react`, prymitywy `shared/ui`, Vitest, skrypty Playwright.

**Spec:** osobnego pliku spec nie ma — projekt jest w sekcjach 1–4 tego dokumentu. Obowiązujące kontrakty, które Zadanie 1 aktualizuje przed kodem: `docs/adr/0020-planar-field-map-and-monitor.md`, `docs/specs/frontend-v2/15-viewport-2d-module.md`, `docs/specs/frontend-v2/23-per-object-visualization-control.md`, `docs/specs/frontend-v2/12-ribbon-toolbar-command-system.md`, `docs/physics/0970-planar-monitor-sampling-and-projection.md`.

Wszystkie ścieżki frontendu poniżej są względne do `apps/control-room/src`, chyba że zaczynają się od `crates/`, `docs/` lub `apps/`.

---

## 1. Decyzje

### 1.1 Decyzje użytkownika (2026-11-12)

| # | Decyzja |
|---|---|
| U1 | Kontrolki Quantity, Component, Scope, XY/XZ/YZ, Single layer/Average, Free section oraz tekstowe Arrows/Lines/Mesh/Slices znikają znad płótna. |
| U2 | Nad płótnem jest pasek narzędzi z ikonami (wzorzec 3ds Max). |
| U3 | Wszystko, co decyduje o tym, co jest wyświetlane, ustawia się w zakładce 2D inspektora, per obiekt, jak w 3D. |
| U4 | Suwak pozycji przekroju zostaje w cienkim pasku pod płótnem. Wybór płaszczyzny i trybu przekroju idzie do inspektora. |
| U5 | Inspektor węzła powstaje od razu z rozszerzonym backendem: `/probe` zwraca najbliższy węzeł FEM lub środek komórki FDM. |
| U6 | Kadr ogranicza widoczny zakres u/v, a backend próbkuje raster ponownie tylko dla kadru. Eksport obejmuje kadr. Kadr jest zapisywany w stanie sesji. |
| U7 | Jedna lista warstw: znika rozróżnienie pole bazowe / nakładki, limit 4 zostaje podniesiony. |

### 1.2 Decyzje wykonawcze (moje — do potwierdzenia przy przeglądzie planu)

| # | Decyzja | Uzasadnienie |
|---|---|---|
| W1 | Pasek narzędzi jest poziomy, zadokowany nad płótnem. | Zgodny ze szkicem pokazanym użytkownikowi; nie zabiera szerokości płótna. |
| W2 | Nazwa pola `planar.field_overlays` na drucie zostaje. W UI i dokumentach nazywa się „warstwy pól" (*field layers*). | Zmiana nazwy pola łamałaby zapisane sesje i klienta bez zysku funkcjonalnego. |
| W3 | Limit warstw: `PLANAR_FIELD_LAYERS_MAX = 16`. Dane ładują się tylko dla warstw widocznych. | Każda warstwa to osobna próbka (meta + skalar + wektory + maska); 16 pokrywa typowe sceny, a koszt ogranicza widoczność. |
| W4 | Warstwa może mieć cel `monitor_target` („Wszystkie obiekty"), `airbox` albo konkretny obiekt/region. Nowa sesja startuje z jedną warstwą `all` (m, kierunek). | Backend nie zna obiektów w chwili tworzenia stanu domyślnego; klient nie może zapisywać stanu przy montowaniu. |
| W5 | Przełączniki w pasku narzędzi to maski całego widoku (`planar.layers.*`). Flagi per warstwa decydują, które warstwy w danej masce uczestniczą. Efekt = maska widoku AND flaga warstwy. | Szybkie włącz/wyłącz jednym kliknięciem bez utraty ustawień per obiekt. |
| W6 | Zoom ramką zmienia tylko `planar.interaction` (bez dopróbkowania). Kadr zmienia okno próbkowania. | Dwa różne narzędzia o różnym koszcie; rozdzielone ikoną i nazwą. |
| W7 | Wieloprzekrój (Slices) rysuje pierwszą widoczną warstwę z listy. | Panele wieloprzekroju współdzielą dziś jedną wielkość; reguła deterministyczna i bez nowego stanu. |
| W8 | Wybór obiektu kliknięciem na płótnie 2D jest poza zakresem. | Wymaga osobnego kontraktu trafień; nie blokuje żadnej z decyzji U1–U7. |
| W9 | Odczyt węzła przy operatorze `slab_average` i `depth_projection` jest niedostępny i jawnie tak oznaczony. | Wartość uśredniona po grubości nie ma jednego węzła źródłowego. |

### 1.3 Stan obecny, na którym plan się opiera

- Płótno: `modules/field-map/renderer/PlanarSurface.tsx` (Canvas 2D + worker). ADR 0020 pkt 5 zabrania tu WebGL.
- Pas kontrolek: `modules/field-map/components/FieldMapToolbar.tsx` (237 linii) i `PlanarSectionStrip.tsx` (260 linii).
- Zoom kółkiem, pan, fit dwuklikiem, sonda po kliknięciu i profil przez Shift+przeciąganie istnieją, ale bez przycisków i bez jawnych trybów.
- Odznaka „No sample" to odczyt sondy pod kursorem (`PlanarSurface.tsx` L398–415).
- Klient dostaje raster (domyślnie 512²), maskę i odcinki przecięcia siatki. Nie dostaje węzłów.
- `/probe`: `planar_probe_response` w `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` L1072–1153; punkt liczy `PlanarTarget::evaluate_point` w `crates/fullmag-api/src/planar_sampling/target.rs` L75.
- Limit nakładek: `PLANAR_FIELD_OVERLAYS_MAX = 4` w `crates/fullmag-api/src/schemas/visualization_state.rs` L253, walidacja w `router_v2/handlers/visualization/display.rs` L797–810.
- Stan sesji 2D odtwarza `crates/fullmag-api/src/session_persistence.rs` L178–274.
- Przycisk „Fit view" w stopce inspektora zawsze wykonuje `viewport-3d.fit` (`modules/inspector/InspectorModule.tsx` L67–74).
- `shared/ui/OverlayToolbar.tsx` istnieje i nie jest nigdzie używany.

---

## 2. Projekt interfejsu

### 2.1 Układ widoku

```
┌─ 3D Viewport │ 2D View │ Live Charts │ Analysis ───────────────────────────────┐
│ [✋][▭🔍][⌗][⌖][📈][📏] │ [+][−][⤢] │ [↗][⁙][△][≈][◌][▦][🎨] │ [📷][⭳]   ⋯   │  A
├────────────────────────────────────────────────────────────────────────────────┤
│  z (nm)                                                                        │
│   50 ┤   ┌──────────────────────────────────────────────┐                      │
│      │   │                                              │                      │
│    0 ┤   │   ════════════ film ═════════════            │                      │  B
│      │   │                                              │                      │
│  −50 ┤   └──────────────────────────────────────────────┘                      │
│      └────┬──────────┬──────────┬──────────┬───── y (nm)                       │
│  ┌ legenda: film · m [koło HSL]  Airbox · H_demag [koło HSL] ┐                 │  C
├────────────────────────────────────────────────────────────────────────────────┤
│ YZ │ ‹ ━━━━━━●━━━━━━ › │ x 0.00 nm │ 1 699 el. │ y 12.4 · z 0.0 nm │ 100% │ ⌗× │  D
└────────────────────────────────────────────────────────────────────────────────┘
```

- **A — pasek narzędzi** (wysokość 34 px, jedna linia, zawijanie zabronione; nadmiar trafia do menu `⋯`).
- **B — płótno** z osiami; nie zmienia renderera.
- **C — legenda**: jedna zwarta karta na widoczną warstwę, nakładka w lewym dolnym rogu płótna, chowana przełącznikiem z paska.
- **D — pasek stanu** (wysokość 28 px): etykieta płaszczyzny, suwak pozycji, współrzędna normalna, liczba przeciętych elementów, współrzędne kursora, zoom, znacznik kadru z przyciskiem wyczyszczenia.

### 2.2 Pasek narzędzi — pełna lista

Grupa 1 — narzędzia (dokładnie jedno aktywne, `role="radiogroup"`):

| Narzędzie | `PlanarToolId` | Komenda | Ikona lucide | Skrót | Gest |
|---|---|---|---|---|---|
| Nawigacja | `navigate` | `field-map.tool.navigate` | `Hand` | `H`, `Esc` | przeciąganie = pan, kółko = zoom |
| Zoom ramką | `zoom-box` | `field-map.tool.zoom-box` | `ScanSearch` | `B` | przeciągnij ramkę → widok dopasowany do ramki |
| Kadr | `crop` | `field-map.tool.crop` | `Crop` | `C` | przeciągnij ramkę → Enter zatwierdza, Esc anuluje |
| Inspektor | `inspect` | `field-map.tool.inspect` | `Crosshair` | `I` | ruch = odczyt węzła, klik = przypięcie |
| Profil | `profile` | `field-map.tool.profile` | `ChartSpline` | `P` | przeciągnij odcinek → wykres profilu |
| Linijka | `measure` | `field-map.tool.measure` | `Ruler` | `R` | przeciągnij odcinek → długość, Δu, Δv, kąt |

Grupa 2 — nawigacja (akcje jednorazowe): `field-map.zoom-in` (`ZoomIn`, `+`), `field-map.zoom-out` (`ZoomOut`, `-`), `field-map.fit` (`Maximize`, `F` i `0`).

Grupa 3 — maski widoku (przełączniki `aria-pressed`):

| Przełącznik | Komenda | Pole stanu | Ikona |
|---|---|---|---|
| Wektory | `field-map.toggle-vectors` | `planar.layers.vectors` | `MoveUpRight` |
| Punkty | `field-map.toggle-points` | `planar.layers.points` | `Grip` |
| Siatka | `field-map.toggle-mesh` | `planar.layers.mesh` | `Triangle` |
| Linie pola | `field-map.toggle-streamlines` | `planar.layers.streamlines` | `Waves` |
| Izolinie | `field-map.toggle-contours` | `planar.layers.contours` | `CircleDashed` |
| Wieloprzekrój | `field-map.toggle-multislice` | `planar.multislice.enabled` | `LayoutGrid` |
| Legenda | `field-map.toggle-legend` | `planar.viewport_colorbar_visible` | `Palette` |

Grupa 4 — eksport: `field-map.export-png` (`Camera`), `field-map.export-data` (`FileDown`). Obie komendy już istnieją.

Zasady:

- Każdy przycisk ma `Tooltip` z nazwą i skrótem oraz `aria-label`.
- Przycisk niedostępny zostaje widoczny z `disabledReason` (np. „Siatka niedostępna dla tego źródła").
- Istniejące skróty (`[`, `]`, `{`, `}`, `V`, `X`, `Y`, `Z`, `M`, `A`, `G`) zostają bez zmian; nowe litery nie kolidują z nimi. Shift+przeciąganie nadal rysuje profil w każdym narzędziu.
- Przed użyciem każdej ikony wykonawca sprawdza, że istnieje w zainstalowanej wersji `lucide-react`; brakującą zastępuje najbliższą i odnotowuje to w PR.

### 2.3 Stany narzędzi na płótnie

```
Kadr (w trakcie)                         Kadr (zatwierdzony)
┌───────────────────────────┐            ┌───────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░│            │                           │
│░░░┌┄┄┄┄┄┄┄┄┄┄┄┄┄┐░░░░░░░░░│            │  cały obszar płótna =     │
│░░░┆  50.0 × 60.0 nm ┆░░░░░│            │  okno kadru, dopróbkowane │
│░░░└┄┄┄┄┄┄┄┄┄┄┄┄┄┘░░░░░░░░░│            │  w pełnej rozdzielczości  │
│░░░░░░░ Enter ✓  Esc ✕ ░░░░│            │                           │
└───────────────────────────┘            └───────────────────────────┘
                                          pasek stanu: [⌗ y −25…25 · z −30…30 nm ×]

Inspektor (najechanie)                   Linijka
        ◎ ← pierścień na węźle           ●━━━━━━━━━━━━━━━●
        ┌──────────────────────────┐          42.7 nm
        │ film · węzeł 18 204      │      Δy 40.1 nm · Δz 14.6 nm · 20.0°
        │ y 12.40 nm · z 0.00 nm   │
        │ Δ w płaszczyźnie 0.31 nm │
        │ Δ od płaszczyzny 0.00 nm │
        │ m = (0.969, 0.121, 0.000)│
        │ ─────────────────────────│
        │ Airbox · H_demag  —      │
        └──────────────────────────┘
```

- Kadr: obszar poza ramką przyciemniony; ramka ma osiem uchwytów; etykieta podaje rozmiar w jednostkach osi.
- Inspektor: krzyżyk kursora pokazuje punkt żądany, pierścień pokazuje rzut węzła; odczyt ma po jednym bloku na każdą widoczną warstwę zajętą w tym punkcie (najwyżej 4, w kolejności listy).
- Kliknięcie przypina odczyt; przypięty odczyt ma przycisk kopiowania wartości i zamknięcia.
- Gdy węzeł jest niedostępny, blok pokazuje wartość w punkcie i powód jednym zdaniem (np. „Węzeł niedostępny przy uśrednianiu po grubości").

### 2.4 Zakładka 2D inspektora

```
┌ Inspector ─────────────────────────┐
│ [ 3D ][ 2D ]                       │
│ ● Live   ● Siatka gotowa           │  1  stan w jednej linii (zamiast 4 kafli)
├ Warstwy pól ───────────── 2 / 16 ──┤
│ ⠿ 👁 film · m · kierunek   ▦ ↗  🗑 │  2  lista warstw
│ ⠿ 👁 Airbox · H_demag      ▦ ↗  🗑 │
│ [ + Dodaj pole ▾ ]                 │
├ Wybrana warstwa: film ─────────────┤
│ Wielkość   [ Magnetization m    ▾] │  3  ustawienia warstwy
│ Składowa   [Kier.][x][y][z][|v|]   │
│ Rysuj      [Raster][Wektory]       │
│            [Punkty][Siatka]        │
│            [Izolinie][Linie pola]  │
│ ▸ Kolorowanie  ▸ Wektory           │
│ ▸ Punkty       ▸ Siatka            │
├ Płaszczyzna przekroju ─────────────┤
│ Źródło     [ Default            ▾] │  4  wspólne dla wszystkich warstw
│ Płaszcz.   [XY][XZ][YZ]            │
│ Tryb       [Jedna warstwa][Średnia]│
│ Przekrój   [ Free section       ▾] │
│ Pozycja    [ 0.00 ] nm  ‹ ›        │
├ Kadr i widok ──────────────────────┤
│ u  [ −25.0 ] … [ 25.0 ] nm         │  5
│ v  [ −30.0 ] … [ 30.0 ] nm         │
│ [ Wyczyść kadr ]  Zoom 100% [Fit]  │
│ ▸ Rozdzielczość i jakość           │
├ ▸ Zaawansowane (pochodzenie) ──────┤
│ [ ⤢ Fit view ]   [ Reset display ] │  6  stopka zależna od kontekstu
└────────────────────────────────────┘
```

Zasady:

- Zaznaczenie obiektu lub Airboxa w drzewie modelu zaznacza jego warstwę. Gdy obiekt nie ma warstwy, sekcja 3 pokazuje stan pusty z jednym przyciskiem „Dodaj pole dla *film*".
- Wiersz warstwy: uchwyt kolejności, widoczność, nazwa `cel · wielkość · składowa`, szybkie przełączniki rastra i wektorów, usunięcie. Kolejność listy = kolejność rysowania (pierwsza na wierzchu).
- Menu „Dodaj pole" listuje cele bez warstwy: Wszystkie obiekty, Airbox, każdy obiekt sceny. Przy 16 warstwach przycisk zostaje aktywny i pokazuje powód odmowy.
- Każda kontrolka zapisuje od razu przez `visualizationSync` (bez Apply). Stan oczekiwania jest na poziomie pola; panel nie przygasa i nie przewija się.
- Sekcja 2D rejestruje sesję edycji `liveViewport`, więc stopka pokazuje „Reset display" zamiast „No staged edits in this view".
- „Fit view" w stopce wykonuje `field-map.fit`, gdy aktywny jest widok 2D.

---

## 3. Kontrakty danych

### 3.1 Stan `planar` (Rust, `schemas/visualization_state.rs`)

```rust
pub const PLANAR_FIELD_LAYERS_MAX: usize = 16;

#[serde(rename_all = "snake_case")]
pub enum PlanarLayerModel { Legacy, Layers }          // serde default: Legacy

pub struct PlanarCropState {                          // deny_unknown_fields
    pub u_min_m: f64, pub u_max_m: f64,
    pub v_min_m: f64, pub v_max_m: f64,
}

// PlanarVisualizationState: nowe pola
#[serde(default)] pub layer_model: PlanarLayerModel,
#[serde(default)] pub crop: Option<PlanarCropState>,

// PlanarVisualizationPatch: nowe pola
pub layer_model: Option<PlanarLayerModel>,
#[serde(default, deserialize_with = "deserialize_double_option")]
pub crop: Option<Option<PlanarCropState>>,            // Some(None) czyści kadr

// PlanarFieldOverlayState: nowe pola, wszystkie #[serde(default…)]
pub visible: bool,              // default true
pub points_visible: bool,       // default false
pub mesh_visible: bool,         // default false
pub contours_visible: bool,     // default false
pub streamlines_visible: bool,  // default false
```

Reguły:

- `layer_model = layers`: pola bazowe `quantity_id`, `component`, `colormap`, `range`, `raster_opacity`, `view_scope` nie są rysowane. Próbka bazowa służy tylko do `meta` (ramka, przekrój, liczba przeciętych elementów).
- Stan domyślny nowej sesji: `layer_model = layers`, jedna warstwa `{ id: "all", view_scope: monitor_target, quantity_id: "m", component: magnitude, colormap: "hsl_direction", visible: true, raster_visible: true }`.
- Migracja przy odtwarzaniu sesji (`session_persistence.rs`), tylko dla `layer_model = legacy`:
  1. Jeśli `planar.layers.raster` lub `planar.layers.vectors` było włączone, pole bazowe staje się warstwą `all` na **końcu** listy (rysowana pod spodem), z zakresem `view_scope` pola bazowego i flagami `raster_visible`/`vectors_visible` skopiowanymi z `planar.layers`.
  2. Istniejące nakładki zachowują kolejność i dostają `visible = true`.
  3. `layer_model` zmienia się na `layers`. Migracja jest idempotentna.
- Walidacja PATCH: najwyżej 16 warstw, unikalne niepuste `id`, znana wielkość, niepusta mapa kolorów (jak dziś); komunikat `planar.field_overlays must contain at most 16 entries`.
- Walidacja kadru: wszystkie wartości skończone, `u_min_m < u_max_m`, `v_min_m < v_max_m`; inaczej 400 `invalid_planar_crop`.

### 3.2 Okno próbkowania (kadr)

Nowe opcjonalne parametry zapytania w `PlanarFieldQuery`, `PlanarFieldProbeQuery` i `PlanarFieldProfileQuery` (`schemas/planar_fields.rs`):

```rust
pub window_u_min_m: Option<f64>, pub window_u_max_m: Option<f64>,
pub window_v_min_m: Option<f64>, pub window_v_max_m: Option<f64>,
```

- Albo wszystkie cztery, albo żaden; częściowy zestaw to 400 `invalid_planar_window`.
- Okno jest przycinane do pełnych granic ramki. Puste przecięcie to 400 `invalid_planar_window: window does not intersect the frame`.
- Raster jest próbkowany w oknie zgodnie z istniejącą polityką rozdzielczości zastosowaną do rozmiaru okna.
- `PlanarFieldFrameResource` dostaje pole `full_bounds_uv_m: [f64; 4]`; `bounds_uv_m` opisuje okno.
- Okno wchodzi do `PlanarSampleIdentity` (L833), więc `sample_token` i `etag` różnią się między kadrami.
- Dotyczy źródła Default i monitorów. Kadr nie zmienia autorskiego monitora.
- `render.png` i eksport CSV używają tego samego okna.

### 3.3 Najbliższy węzeł w `/probe`

```rust
// PlanarFieldProbeQuery
pub nearest: Option<String>,                 // jedyna wartość: "node"

// PlanarFieldProbeResource: nowe pola
pub nearest_node: Option<PlanarProbeNodeResource>,
pub nearest_node_status: String,             // patrz tabela

pub struct PlanarProbeNodeResource {
    pub kind: String,            // "fem_node" | "fdm_cell_center"
    pub node_id: u32,            // indeks węzła siatki albo indeks komórki
    pub world_m: [f64; 3],
    pub u_m: f64, pub v_m: f64,  // rzut na ramkę
    pub in_plane_distance_m: f64,
    pub normal_offset_m: f64,    // ze znakiem, wzdłuż normalnej
    pub scalar: Option<f64>,
    pub vector: Option<[f64; 3]>,
}
```

| `nearest_node_status` | Kiedy |
|---|---|
| `not_requested` | brak `nearest=node` |
| `ok` | węzeł znaleziony |
| `empty` | punkt poza celem albo poza ramką |
| `unsupported_operator` | operator inny niż `plane_sample` |
| `unsupported_quantity` | wielkość nie ma wartości węzłowych ani komórkowych |

Definicja (trafia do noty 0970 przed kodem):

- FEM: spośród węzłów elementu zawierającego punkt wybierany jest węzeł o najmniejszej odległości euklidesowej 3D od punktu sondy; remis rozstrzyga niższy indeks węzła. Wartość to wartość stopnia swobody w tym węźle, bez interpolacji.
- FDM: środek komórki zawierającej punkt; wartość komórki.
- `scalar`/`vector` przechodzą przez `evaluate_point_component` z tym samym żądaniem składowej co wartość w punkcie.

Nowa metoda w `crates/fullmag-api/src/planar_sampling/target.rs`:

```rust
pub(crate) struct PlanarNearestNode { pub kind: &'static str, pub node_id: u32,
                                      pub world_m: [f64; 3], pub values: Vec<f64> }
pub(crate) fn nearest_node(&self, point: [f64; 3], entity_id: u32) -> Option<PlanarNearestNode>;
```

### 3.4 Stan klienta

`kernel/visualization/planarToolStore.ts` (efemeryczny, `useSyncExternalStore` ze snapshotem serwerowym `navigate`):

```ts
export type PlanarToolId = "navigate" | "zoom-box" | "crop" | "inspect" | "profile" | "measure";
export interface PlanarToolState {
  activeTool: PlanarToolId;
  cropDraft: PlanarUvRect | null;            // ramka przed zatwierdzeniem
  measure: PlanarUvSegment | null;
  cursorUv: { u_m: number; v_m: number } | null;
}
export interface PlanarUvRect { u_min_m: number; u_max_m: number; v_min_m: number; v_max_m: number }
export interface PlanarUvSegment { u0_m: number; v0_m: number; u1_m: number; v1_m: number }
export const planarToolStore: {
  getSnapshot(): PlanarToolState; getServerSnapshot(): PlanarToolState;
  subscribe(listener: () => void): () => void;
  setActiveTool(tool: PlanarToolId): void;   // czyści cropDraft
  setCropDraft(rect: PlanarUvRect | null): void;
  setMeasure(segment: PlanarUvSegment | null): void;
  setCursorUv(uv: { u_m: number; v_m: number } | null): void;
};
```

Zamknięcie lub przełączenie widoku 2D resetuje narzędzie do `navigate`.

---

## 4. Mapa plików

### Backend (`crates/fullmag-api/src`)

| Plik | Zmiana |
|---|---|
| `schemas/visualization_state.rs` | `PlanarLayerModel`, `PlanarCropState`, nowe pola stanu/patcha/warstwy, limit 16, stan domyślny |
| `schemas/planar_fields.rs` | parametry okna, `full_bounds_uv_m`, `nearest`, `PlanarProbeNodeResource` |
| `router_v2/handlers/visualization/display.rs` | walidacja limitu i kadru, zastosowanie `crop` i `layer_model` |
| `session_persistence.rs` | migracja `legacy → layers` |
| `router_v2/handlers/data/planar_fields.rs` | okno w `build_planar_field_from_source`, tożsamość próbki, `planar_probe_response` |
| `router_v2/handlers/data/planar_profile.rs` | okno w profilu |
| `planar_sampling/target.rs` | `nearest_node` |
| `openapi_v2.rs` | rejestracja nowych schematów |
| `router_v2/handlers/visualization/display_field_overlay_tests.rs`, `router_v2/tests_planar_composition.rs` | testy |

### Frontend — nowe pliki

| Plik | Odpowiedzialność |
|---|---|
| `kernel/visualization/planarToolStore.ts` | stan narzędzia (sekcja 3.4) |
| `modules/field-map/fieldMapToolCommands.ts` | komendy narzędzi, nawigacji i masek |
| `modules/field-map/components/PlanarToolbar.tsx` | pasek ikon renderujący komendy |
| `modules/field-map/components/PlanarStatusBar.tsx` | pasek pod płótnem |
| `modules/field-map/renderer/PlanarToolOverlay.tsx` | nakładka SVG: ramka zoomu, kadr, linijka, pierścień węzła |
| `modules/field-map/model/planarToolGeometry.ts` | czysta geometria: ramka → interakcja, ramka → kadr, pomiar |
| `modules/field-map/components/PlanarNodeReadout.tsx` | odczyt węzła (najechanie i przypięcie) |
| `modules/field-map/hooks/usePlanarNodeProbes.ts` | zapytania `/probe?nearest=node` per warstwa |
| `modules/inspector/visualization/PlanarFieldLayerList.tsx` | lista warstw |
| `modules/inspector/visualization/PlanarSectionPlaneSection.tsx` | sekcja płaszczyzny przekroju |
| `modules/inspector/visualization/PlanarCropViewSection.tsx` | sekcja kadru i widoku |
| `modules/inspector/visualization/planarFieldLayers.ts` | operacje na liście warstw |

### Frontend — pliki zmieniane lub usuwane

| Plik | Zmiana |
|---|---|
| `modules/field-map/components/FieldMapToolbar.tsx` (+ test) | usunięty; zastępuje go `PlanarToolbar` |
| `modules/field-map/components/PlanarSectionStrip.tsx` (+ test) | usunięty; suwak przechodzi do `PlanarStatusBar`, reszta do inspektora |
| `modules/field-map/FieldMapModule.tsx` | nowy układ A/B/C/D, model warstw, okno w zapytaniach |
| `modules/field-map/renderer/PlanarSurface.tsx` | gesty zależne od narzędzia, usunięcie odznaki „No sample" |
| `modules/field-map/components/PlanarColorLegend.tsx` | zwarta karta per warstwa |
| `modules/field-map/components/PlanarCompositionSurface.tsx`, `PlanarMultisliceGrid.tsx` | flagi warstw, reguła W7 |
| `modules/field-map/model/fieldMapDataPlan.ts` | bez skalara/wektorów/maski dla próbki bazowej w modelu `layers` |
| `modules/field-map/fieldMapViewCommands.ts`, `manifest.ts` | rejestracja nowych komend |
| `kernel/resources/planarFieldResources.ts` | parametry okna i `nearest` w zapytaniach |
| `kernel/visualization/VisualizationRegistrySyncController.ts` | `queuePlanarCropPatch` |
| `kernel/api/apiTypes.ts`, `kernel/api/generated/*` | typy po `just docker-dev-codegen` |
| `modules/inspector/visualization/PlanarVisualizationSection.tsx` | nowa struktura z sekcji 2.4 |
| `modules/inspector/visualization/PlanarTargetFieldSection.tsx` | staje się edytorem wybranej warstwy |
| `modules/inspector/visualization/planarTargetFieldProfile.ts` | zastąpiony przez `planarFieldLayers.ts` |
| `modules/inspector/InspectorModule.tsx` | „Fit view" zależny od kontekstu |
| `modules/ribbon/ribbonTabViews.tsx`, `ribbonContributions.tsx` | grupa „2D View" z narzędziami |
| `design/styles/field-map.css` | style paska, paska stanu, nakładek |
| `apps/control-room/scripts/smoke-viewport-2d.mjs` | scenariusze przeglądarkowe |

---

## Global Constraints

- Raporty i plany po polsku; kod, identyfikatory, komentarze i commity po angielsku.
- Praca w worktree `worktrees/viewport-2d-toolbar`, gałąź `codex/viewport-2d-toolbar`; pełny cykl zakończenia z `AGENTS.md`. Nie ruszać niezatwierdzonych zmian innych agentów w głównym checkoucie.
- **Zakaz kompilowania testów jednostkowych** (`cargo test`, `just test`) do odwołania. Testy Rust są pisane, ale oznaczane „NIE URUCHOMIONE"; dozwolone są `just check-api-source` i `just check-cli-source`.
- Kod aplikacji kompiluje się wyłącznie w usłudze `backend` grupy Docker DEV; nigdy na hoście.
- Zmiana próbkowania wymaga najpierw noty w `docs/physics/` (Zadanie 1).
- Brak dryfu spec: specyfikacje 15, 23 i 12 są aktualizowane przed kodem.
- Tylko API v2 `/v2/sessions/current/...`, jeden typowany klient, zero `fetch()` w komponentach, zero ręcznych ścieżek poza warstwą API.
- Pasek, wstążka, skróty i paleta komend renderują jeden rejestr komend.
- Płótno 2D: Canvas 2D + worker; bez Three.js/WebGL (ADR 0020 pkt 5).
- Style: tokeny `--fm-*` (Catppuccin), klasy z prefiksem `fm-`, CSS w `src/design/styles/*`, bez kolorów na sztywno. Prymitywy z `shared/ui`; ikony z `lucide-react`.
- Inspektor: stan oczekiwania na poziomie pola, zachowany ostatni dobry panel, bez remontowania, resetu przewijania i animacji przezroczystości; mutacje mają regresję przeglądarkową dla Obiektu i Airboxa.
- Sklepy klienckie czytane przez `useSyncExternalStore` mają snapshot serwerowy zgodny z pierwszym renderem.
- Przed edycją frontendu załadować skille `.agents/skills/frontend-v2-module-architecture`, `-state-hygiene`, `-viewport-lifecycle`, `-api-hygiene`, `-performance-gates`.
- Zmiany JSON aktualizują OpenAPI i typy przez `just docker-dev-codegen "$PWD"`.
- Bramki frontendu: `just lint-control-room-source`, `just check-control-room-production-source`.

## Review Focus

1. **Stara sesja z zapisanym polem bazowym i nakładkami** — po odtworzeniu użytkownik widzi ten sam obraz co przed migracją (ta sama wielkość pod spodem, te same nakładki nad nią). Test: Zadanie 2.
2. **Kadr mniejszy niż jeden piksel albo całkowicie poza ramką** — narzędzie nie zatwierdza ramki poniżej 4 px ekranu, a backend odpowiada 400 zamiast pustym rastrem. Testy: Zadania 3 i 8.
3. **Zmiana płaszczyzny przy aktywnym kadrze** — kadr w osiach u/v starej płaszczyzny nie ma sensu w nowej; kadr jest czyszczony w tym samym PATCH-u co zmiana płaszczyzny lub źródła. Test: Zadanie 8.
4. **Szybki ruch kursora w narzędziu Inspektor** — odczyt nigdy nie pokazuje węzła z poprzedniej pozycji; spóźnione odpowiedzi są odrzucane, a stare żądania przerywane. Test: Zadanie 9.
5. **Maska widoku wyłączona, flaga warstwy włączona** — inspektor pokazuje flagę warstwy jako włączoną z dopiskiem „ukryte w pasku narzędzi", a nie jako wyłączoną. Test: Zadanie 10.

---

## Etap 0 — kontrakty

### Zadanie 1: Dokumenty przed kodem

**Pliki:**
- Utwórz: `docs/adr/0080-planar-field-layers-crop-and-node-probe.md` (jeśli 0080 jest zajęty, kolejny wolny numer)
- Zmień: `docs/physics/0970-planar-monitor-sampling-and-projection.md`
- Zmień: `docs/specs/frontend-v2/15-viewport-2d-module.md` (§4, §4.1, §5, §6)
- Zmień: `docs/specs/frontend-v2/23-per-object-visualization-control.md` (§5)
- Zmień: `docs/specs/frontend-v2/12-ribbon-toolbar-command-system.md` (§5, §6)

- [ ] **Krok 1:** ADR — decyzje U1–U7 i W1–W9, model `layers`, reguła migracji z 3.1, relacja do ADR 0020 (uzupełnia pkt 1 i 4, nie zmienia pkt 5).
- [ ] **Krok 2:** Nota 0970 — dwie nowe sekcje z etykietami równań `eq-planar-sampling-window` (okno jako przecięcie z ramką, rozmiar piksela z okna, tożsamość próbki) i `eq-planar-nearest-node` (definicja z 3.3 z regułą remisu i przypadkami `unsupported_*`).
- [ ] **Krok 3:** Spec 15 — nowy układ A/B/C/D, tabele narzędzi i skrótów z 2.2, kontrakt gestów per narzędzie, lista wymaganych testów (Vitest + scenariusze smoke z Zadania 12).
- [ ] **Krok 4:** Spec 23 §5 — lista warstw, reguła „maska widoku AND flaga warstwy", zachowanie zaznaczenia w drzewie.
- [ ] **Krok 5:** Spec 12 — identyfikatory komend `field-map.tool.*`, `field-map.toggle-*`, `field-map.zoom-in/out`.
- [ ] **Krok 6:** Commit `docs: define planar field layers, crop window and node probe contracts`.

## Etap 1 — backend (jeden PR)

### Zadanie 2: Model warstw i migracja sesji

**Pliki:** `schemas/visualization_state.rs`, `router_v2/handlers/visualization/display.rs`, `session_persistence.rs`, `openapi_v2.rs`, test `router_v2/handlers/visualization/display_field_overlay_tests.rs`.

**Interfejsy — produkuje:** typy i reguły z sekcji 3.1; funkcję

```rust
pub(crate) fn migrate_planar_layer_model(state: &mut PlanarVisualizationState);
```

- [ ] **Krok 1: testy** (pisane, NIE URUCHAMIANE do odwołania zakazu):
  - `legacy_base_field_becomes_last_layer`: stan `legacy` z bazą `h_demag`, `layers.raster = true` i jedną nakładką `object:film` → po migracji dwie warstwy, `[0].id == "object:film"`, `[1].id == "all"`, `[1].quantity_id == "h_demag"`, `layer_model == Layers`.
  - `migration_is_idempotent`: dwukrotne wywołanie daje identyczny stan.
  - `legacy_hidden_base_adds_no_layer`: `layers.raster = false` i `layers.vectors = false` → brak warstwy `all`.
  - `patch_rejects_seventeen_layers`: 17 warstw → 400 z komunikatem `planar.field_overlays must contain at most 16 entries`.
  - `patch_accepts_sixteen_layers`.
  - `crop_patch_rejects_inverted_bounds`: `u_min_m = 1.0, u_max_m = 0.0` → 400 `invalid_planar_crop`.
  - `crop_patch_null_clears_crop`: `{"crop": null}` → `state.crop == None`.
  - `overlay_without_new_flags_deserializes`: JSON warstwy sprzed zmiany daje `visible == true`, pozostałe nowe flagi `false`.
- [ ] **Krok 2:** Dodać typy, pola i stałą; zastąpić `PLANAR_FIELD_OVERLAYS_MAX` przez `PLANAR_FIELD_LAYERS_MAX` we wszystkich użyciach.
- [ ] **Krok 3:** Zaimplementować `migrate_planar_layer_model` i wywołać ją w odtwarzaniu `/visualization_planar`.
- [ ] **Krok 4:** Walidacja i zastosowanie `crop` oraz `layer_model` w `display.rs`; zmiana `default_slice.plane` albo `source` w tym samym patchu czyści `crop`, jeśli patch nie podaje nowego.
- [ ] **Krok 5:** `just check-api-source` → bez błędów.
- [ ] **Krok 6:** Commit `Make planar field overlays the single field layer list`.

### Zadanie 3: Okno próbkowania

**Pliki:** `schemas/planar_fields.rs`, `router_v2/handlers/data/planar_fields.rs`, `router_v2/handlers/data/planar_profile.rs`, test `router_v2/tests_planar_composition.rs`.

**Interfejsy — produkuje:** parametry z 3.2; funkcję

```rust
pub(crate) fn resolve_planar_window(full_bounds_uv_m: [f64; 4],
    window: Option<[f64; 4]>) -> Result<[f64; 4], ApiError>;
```

- [ ] **Krok 1: testy** (NIE URUCHAMIANE):
  - `window_none_returns_full_bounds`.
  - `window_is_clamped_to_frame`: ramka `[0,2,0,1]`, okno `[-1,1,0.25,3]` → `[0,1,0.25,1]`.
  - `window_outside_frame_is_rejected`: okno `[3,4,0,1]` → 400 `invalid_planar_window`.
  - `partial_window_is_rejected`: tylko `window_u_min_m` → 400.
  - `windowed_meta_reports_window_and_full_bounds`: `meta.frame.bounds_uv_m` = okno, `full_bounds_uv_m` = ramka, `pixel_size_m` = rozmiar okna / rozdzielczość.
  - `window_changes_sample_token`: ten sam stan z oknem i bez okna → różne `sample_token`.
  - `probe_inside_frame_outside_window_is_occupied`: sonda liczy punkt dokładnie także poza oknem, o ile leży w pełnej ramce.
- [ ] **Krok 2:** Dodać parametry do trzech struktur zapytań i `full_bounds_uv_m` do ramki.
- [ ] **Krok 3:** Zastosować okno w `build_planar_field_from_source` i włączyć je do `PlanarSampleIdentity`.
- [ ] **Krok 4:** Linki w `PlanarFieldLinksResource` przenoszą parametry okna, żeby `scalar`, `vectors`, `empty-mask`, `mesh-overlay`, `probe`, `render.png` dotyczyły tej samej próbki.
- [ ] **Krok 5:** `just check-api-source`.
- [ ] **Krok 6:** Commit `Add a sampling window to planar field requests`.

### Zadanie 4: Najbliższy węzeł w `/probe`

**Pliki:** `planar_sampling/target.rs`, `schemas/planar_fields.rs`, `router_v2/handlers/data/planar_fields.rs` (L1072–1153), `openapi_v2.rs`, test w `planar_sampling/` obok istniejących testów celu.

**Interfejsy — produkuje:** `PlanarTarget::nearest_node` i zasób z 3.3.

- [ ] **Krok 1: testy** (NIE URUCHAMIANE):
  - `fem_nearest_node_picks_closest_vertex_of_containing_element`: czworościan o znanych wierzchołkach, punkt bliżej wierzchołka 2 → `node_id` wierzchołka 2, wartość równa wartości węzłowej, nie interpolowanej.
  - `fem_nearest_node_tie_prefers_lower_index`: punkt w środku krawędzi.
  - `fdm_nearest_node_is_cell_centre`: `kind == "fdm_cell_center"`, `world_m` = środek komórki.
  - `probe_without_nearest_reports_not_requested`.
  - `probe_outside_target_reports_empty`.
  - `probe_with_slab_average_reports_unsupported_operator`.
  - `nearest_node_reports_signed_normal_offset`: węzeł 1 nm nad płaszczyzną → `normal_offset_m == 1e-9`.
  - `probe_rejects_unknown_nearest_value`: `nearest=cell` → 400 `invalid_planar_probe`.
- [ ] **Krok 2:** Zaimplementować `nearest_node` dla nośników FEM i FDM.
- [ ] **Krok 3:** Rozszerzyć `planar_probe_response`: rzut węzła na ramkę, odległości, składowa przez `evaluate_point_component`, status.
- [ ] **Krok 4:** `just check-api-source`.
- [ ] **Krok 5:** Restart kontenera `backend` grupy worktree, potem `just docker-dev-codegen "$PWD"`; w diffie `kernel/api/generated/` pojawiają się `PlanarCropState`, `PlanarLayerModel`, `PlanarProbeNodeResource`, parametry `window_*` i `nearest`.
- [ ] **Krok 6:** Commit `Return the nearest mesh node from planar probes`.

## Etap 2 — fundament paska narzędzi (jeden PR)

### Zadanie 5: Sklep narzędzi i komendy

**Pliki:** utwórz `kernel/visualization/planarToolStore.ts` (+ `.test.ts`), `modules/field-map/fieldMapToolCommands.ts` (+ `.test.ts`); zmień `modules/field-map/manifest.ts`, `modules/field-map/fieldMapViewCommands.ts`.

**Interfejsy — produkuje:** `planarToolStore` z 3.4 oraz

```ts
export const fieldMapToolCommands: CommandContribution[];   // identyfikatory z tabel 2.2
```

- [ ] **Krok 1: testy**
  - `planarToolStore`: snapshot początkowy i serwerowy mają `activeTool === "navigate"`; `setActiveTool("crop")` powiadamia subskrybentów raz; zmiana narzędzia zeruje `cropDraft`.
  - `fieldMapToolCommands`: każda komenda `field-map.tool.*` ma `isActive` zgodne ze sklepem; `field-map.toggle-vectors` wysyła patch `{ planar: { layers: { ...current, vectors: !current.vectors } } }`; wszystkie komendy mają `isEnabled === false` z `disabledReason`, gdy aktywny moduł to nie `field-map`; skróty `H B C I P R F` nie powtarzają żadnego istniejącego skrótu z `fieldMapViewCommands`.
  - `field-map.zoom-in` mnoży `interaction.zoom` przez 1.25 z kotwicą w środku widoku, `zoom-out` dzieli; wynik jest ograniczony tym samym zakresem co zoom kółkiem.
- [ ] **Krok 2:** Zaimplementować sklep i komendy; zoom przez istniejące `zoomPlanarInteractionAt` z `renderer/planarInteraction.ts`.
- [ ] **Krok 3:** Zarejestrować w manifeście.
- [ ] **Krok 4:** Bramki frontendu z Global Constraints.
- [ ] **Krok 5:** Commit `Add planar tool state and toolbar commands`.

### Zadanie 6: `PlanarToolbar` i `PlanarStatusBar`, usunięcie starego pasa

**Pliki:** utwórz `modules/field-map/components/PlanarToolbar.tsx` (+ test), `PlanarStatusBar.tsx` (+ test); zmień `FieldMapModule.tsx`, `renderer/PlanarSurface.tsx`, `design/styles/field-map.css`; usuń `FieldMapToolbar.tsx`, `PlanarSectionStrip.tsx` i ich testy.

**Interfejsy:**

```ts
export function PlanarToolbar(): JSX.Element;      // czyta rejestr komend; bez propsów danych
export interface PlanarStatusBarProps {
  planeLabel: "XY" | "XZ" | "YZ";
  section: PlanarSectionResource | null;
  positionFraction: number;
  onPositionCommit(fraction: number): void;
  onStep(direction: -1 | 1): void;
  zoom: number;
  crop: PlanarCropState | null;
  onClearCrop(): void;
}
```

- [ ] **Krok 1: testy**
  - Pasek ma `role="toolbar"` z `aria-label="2D view tools"`, cztery grupy, grupa narzędzi to `radiogroup` z sześcioma pozycjami.
  - Kliknięcie „Crop" wykonuje `field-map.tool.crop`; przycisk aktywnego narzędzia ma `aria-checked="true"`.
  - Przełącznik wektorów ma `aria-pressed` zgodne z `planar.layers.vectors`.
  - W DOM widoku 2D nie ma etykiet „Quantity", „Scope", „Free section", „Single layer".
  - Pasek stanu: przeciąganie suwaka nie wywołuje `onPositionCommit` przed puszczeniem; puszczenie wywołuje je raz; podpis `x: 0.00 nm · 1,699 el.` powstaje z `section.resolved_coordinate_m` i `cut_element_count`.
  - Pasek stanu pokazuje `—` zamiast współrzędnych kursora, gdy `cursorUv === null`; w DOM nie ma tekstu „No sample".
  - Znacznik kadru jest widoczny tylko przy `crop !== null`; jego przycisk wywołuje `onClearCrop`.
- [ ] **Krok 2:** Zaimplementować oba komponenty na `Button size="icon"`, `Tooltip`, `Separator`, `Slider` z `shared/ui`; nadmiar w `DropdownMenu`.
- [ ] **Krok 3:** Przebudować układ w `FieldMapModule.tsx` na A/B/C/D; pasek i pasek stanu zostają widoczne nad stanami ładowania i błędu (jak dziś `FieldMapStatus`).
- [ ] **Krok 4:** Przenieść logikę szkicu suwaka z `PlanarSectionStrip` do `PlanarStatusBar`; usunąć stare pliki.
- [ ] **Krok 5:** Usunąć odznakę sondy z `PlanarSurface.tsx`; pozycja kursora trafia do `planarToolStore.setCursorUv` raz na klatkę animacji.
- [ ] **Krok 6:** Style w `field-map.css`: `.fm-planar-toolbar`, `.fm-planar-statusbar`, wyłącznie tokeny `--fm-*`.
- [ ] **Krok 7:** Bramki frontendu; commit `Replace the 2D control strip with an icon toolbar and status bar`.

## Etap 3 — narzędzia na płótnie (jeden PR)

### Zadanie 7: Zoom ramką i linijka

**Pliki:** utwórz `modules/field-map/model/planarToolGeometry.ts` (+ test), `modules/field-map/renderer/PlanarToolOverlay.tsx` (+ test); zmień `renderer/PlanarSurface.tsx`.

**Interfejsy — produkuje:**

```ts
export const MIN_TOOL_DRAG_PX = 4;
export function interactionForUvRect(rect: PlanarUvRect, frameBounds: [number, number, number, number],
  viewport: { width: number; height: number }): PlanarInteractionState;
export function measureSegment(segment: PlanarUvSegment):
  { length_m: number; du_m: number; dv_m: number; angle_deg: number };
export function normalizeUvRect(a: { u_m: number; v_m: number }, b: { u_m: number; v_m: number }): PlanarUvRect;
```

- [ ] **Krok 1: testy**
  - `interactionForUvRect`: ramka równa pełnym granicom → `zoom === 1`, pan zerowy; ramka o połowie szerokości i wysokości w środku → `zoom === 2`; ramka o innych proporcjach niż widok mieści się w całości (zoom wyznacza dłuższy bok).
  - `measureSegment({u0_m:0,v0_m:0,u1_m:3e-9,v1_m:4e-9})` → `length_m === 5e-9`, `angle_deg ≈ 53.13`.
  - `normalizeUvRect` porządkuje rogi niezależnie od kierunku przeciągania.
  - Nakładka: w narzędziu `zoom-box` przeciągnięcie poniżej 4 px nie wysyła patcha; powyżej wysyła jeden patch `interaction` po puszczeniu, a narzędzie wraca do `navigate`.
  - Linijka: etykieta pokazuje długość w jednostce osi; `Esc` czyści pomiar.
- [ ] **Krok 2:** Zaimplementować geometrię i nakładkę SVG nad płótnem nakładek.
- [ ] **Krok 3:** W `PlanarSurface.tsx` rozgałęzić obsługę wskaźnika po `activeTool`: `navigate` zachowuje obecne gesty; pozostałe narzędzia przekazują przeciąganie do nakładki; kółko zawsze zoomuje.
- [ ] **Krok 4:** Bramki frontendu; commit `Add box zoom and ruler tools to the 2D view`.

### Zadanie 8: Kadr

**Pliki:** zmień `renderer/PlanarToolOverlay.tsx`, `kernel/visualization/VisualizationRegistrySyncController.ts` (+ test), `kernel/resources/planarFieldResources.ts`, `modules/field-map/model/fieldMapDataPlan.ts` (+ test), `FieldMapModule.tsx`, `modules/field-map/fieldMapCommands.ts`, `fieldMapViewCommands.ts`.

**Interfejsy — produkuje:**

```ts
// VisualizationRegistrySyncController
queuePlanarCropPatch(crop: PlanarCropState | null): void;   // flush natychmiast; resetuje interaction do zoom 1, pan 0
// planarFieldResources
export function planarWindowParams(crop: PlanarCropState | null): Record<string, string>;
```

- [ ] **Krok 1: testy**
  - Zatwierdzenie ramki (Enter albo przycisk ✓) wywołuje `queuePlanarCropPatch` raz z ramką w metrach; `Esc` nie wysyła nic i czyści `cropDraft`.
  - Ramka poniżej 4 px na którymkolwiek boku nie daje się zatwierdzić; przycisk ✓ ma `disabledReason`.
  - Ramka wychodząca poza `full_bounds_uv_m` jest przycinana przed wysłaniem.
  - `queuePlanarCropPatch(null)` wysyła `{ planar: { crop: null, interaction: { zoom: 1, pan_u_m: 0, pan_v_m: 0 } } }`.
  - `planarWindowParams(null)` zwraca `{}`; z kadrem zwraca cztery klucze `window_*`.
  - Plan danych dokłada parametry okna do zapytań każdej warstwy i próbki bazowej.
  - Zmiana płaszczyzny przy aktywnym kadrze: patch zmiany płaszczyzny zawiera `crop: null` (Review Focus 3).
  - Eksport CSV i PNG z kadrem używają tych samych parametrów okna.
  - `field-map.fit` przy aktywnym kadrze dopasowuje do kadru; nowa komenda `field-map.clear-crop` czyści kadr.
- [ ] **Krok 2:** Uchwyty i przyciemnienie w nakładce; etykieta rozmiaru.
- [ ] **Krok 3:** Zapis kadru i parametry okna w zasobach i planie danych.
- [ ] **Krok 4:** Osie (`PlanarAxes`) czytają `frame.bounds_uv_m` okna — sprawdzić, że podziałka pokazuje zakres kadru.
- [ ] **Krok 5:** Bramki frontendu; commit `Add a resampling crop tool to the 2D view`.

### Zadanie 9: Inspektor węzła

**Pliki:** utwórz `modules/field-map/hooks/usePlanarNodeProbes.ts` (+ test), `modules/field-map/components/PlanarNodeReadout.tsx` (+ test); zmień `kernel/resources/planarFieldResources.ts`, `renderer/PlanarToolOverlay.tsx`, `FieldMapModule.tsx`; usuń `components/PlanarPinnedProbe.tsx` po przeniesieniu jego roli.

**Interfejsy — produkuje:**

```ts
export const NODE_PROBE_DEBOUNCE_MS = 80;
export const NODE_PROBE_MAX_LAYERS = 4;
export interface PlanarNodeProbeResult {
  layerId: string; label: string; unit: string;
  status: "loading" | "ok" | "empty" | "unsupported_operator" | "unsupported_quantity" | "error";
  point: { scalar: number | null; vector: [number, number, number] | null };
  node: PlanarProbeNodeResource | null;
}
export function usePlanarNodeProbes(args: {
  enabled: boolean; uv: { u_m: number; v_m: number } | null;
  layers: PlanarFieldLayerRuntime[];           // widoczne warstwy z ich meta i maską
}): PlanarNodeProbeResult[];
```

- [ ] **Krok 1: testy**
  - Zapytania idą tylko do warstw, których lokalna maska jest zajęta w punkcie, w kolejności listy, najwyżej 4.
  - Dwa ruchy kursora w odstępie 20 ms dają jedno zapytanie na warstwę (dla drugiej pozycji).
  - Odpowiedź dla starej pozycji przychodząca po nowej jest odrzucana; stare żądanie dostaje `abort` (Review Focus 4).
  - `enabled === false` nie wysyła nic.
  - Odczyt: blok z `status === "ok"` pokazuje „węzeł 18 204", współrzędne w jednostce osi, obie odległości i wartość w notacji z jednostką; wektor jako trzy składowe, nie surowa krotka.
  - Blok `unsupported_operator` pokazuje wartość w punkcie i zdanie „Węzeł niedostępny przy uśrednianiu po grubości".
  - Kliknięcie przypina odczyt; przypięty odczyt zostaje po zmianie narzędzia i ma przyciski kopiowania i zamknięcia; `Esc` w narzędziu `inspect` zamyka przypięty odczyt.
  - Pierścień węzła rysuje się w `(node.u_m, node.v_m)`; przy `normal_offset_m !== 0` etykieta pokazuje „Δ od płaszczyzny".
- [ ] **Krok 2:** Rozszerzyć `usePlanarProbeResource` o parametr `nearest: "node"` i okno.
- [ ] **Krok 3:** Zaimplementować hook z debounce, `AbortController` i regułą „ostatni wygrywa".
- [ ] **Krok 4:** Zaimplementować odczyt i pierścień; pozycjonowanie odczytu tak, żeby nie wychodził poza płótno.
- [ ] **Krok 5:** Bramki frontendu; commit `Add a nearest-node inspect tool to the 2D view`.

## Etap 4 — inspektor 2D (jeden PR)

### Zadanie 10: Lista warstw i edytor warstwy

**Pliki:** utwórz `modules/inspector/visualization/planarFieldLayers.ts` (+ test), `PlanarFieldLayerList.tsx` (+ test); zmień `PlanarTargetFieldSection.tsx` (+ test), `PlanarVisualizationSection.tsx` (+ test), `modules/field-map/components/PlanarCompositionSurface.tsx`, `PlanarMultisliceGrid.tsx`, `PlanarColorLegend.tsx`, `modules/field-map/model/fieldMapDataPlan.ts`; usuń `planarTargetFieldProfile.ts` po przeniesieniu.

**Interfejsy — produkuje:**

```ts
export const PLANAR_FIELD_LAYERS_MAX = 16;
export type PlanarFieldLayer = PlanarFieldOverlayState;
export type PlanarLayerPass = "raster" | "vectors" | "points" | "mesh" | "contours" | "streamlines";
export function layerIdForTarget(target: VisualizationTargetRef | "all"): string;   // "all" | "airbox" | `object:${id}`
export function createFieldLayer(target: VisualizationTargetRef | "all"): PlanarFieldLayer;
export function addFieldLayer(layers: PlanarFieldLayer[], layer: PlanarFieldLayer):
  { layers: PlanarFieldLayer[] } | { refused: "max_layers" | "duplicate" };
export function removeFieldLayer(layers: PlanarFieldLayer[], id: string): PlanarFieldLayer[];
export function moveFieldLayer(layers: PlanarFieldLayer[], id: string, toIndex: number): PlanarFieldLayer[];
export function patchFieldLayer(layers: PlanarFieldLayer[], id: string, patch: Partial<PlanarFieldLayer>): PlanarFieldLayer[];
export function effectivePass(layer: PlanarFieldLayer, viewMasks: PlanarLayerState, pass: PlanarLayerPass):
  "on" | "off" | "masked";       // "masked": flaga warstwy włączona, maska widoku wyłączona
export function multisliceLayer(layers: PlanarFieldLayer[]): PlanarFieldLayer | null;   // pierwsza z visible === true
```

- [ ] **Krok 1: testy**
  - `addFieldLayer` przy 16 warstwach zwraca `{ refused: "max_layers" }`; przy istniejącym `id` zwraca `{ refused: "duplicate" }`.
  - `createFieldLayer("all")` ma `view_scope.kind === "monitor_target"`, `quantity_id === "m"`, `colormap === "hsl_direction"`, `visible === true`, `raster_visible === true`.
  - `moveFieldLayer` zachowuje wszystkie warstwy i zmienia tylko kolejność.
  - `effectivePass`: flaga `true` + maska `false` → `"masked"`; `visible === false` → `"off"` dla każdego przebiegu.
  - Lista: wiersz pokazuje `film · m · kierunek`; kliknięcie oka wysyła patch tylko `visible` tej warstwy z jej `id` jako dotkniętym; przeciągnięcie uchwytu wysyła listę w nowej kolejności; obsługa klawiaturą (`Alt+↑/↓`).
  - Zaznaczenie obiektu `film` w drzewie zaznacza wiersz `object:film`; brak warstwy pokazuje stan pusty z przyciskiem „Dodaj pole dla film".
  - Przebieg w stanie `"masked"` renderuje chip jako włączony z dopiskiem „ukryte w pasku narzędzi" (Review Focus 5).
  - Edytor warstwy: zmiana wielkości wysyła patch z natychmiastowym flush (tożsamość próbki); zmiana wielkości nie uruchamia żadnego żądania obliczeń.
  - Regresja dla Airboxa: dodanie warstwy `airbox` nie zmienia `planar.view_scope` bazy.
  - Kompozycja rysuje warstwy od końca listy do początku; warstwa z `visible === false` nie tworzy żadnego zapytania danych.
  - W modelu `layers` plan danych próbki bazowej zawiera tylko `meta` (i `mesh-overlay`, gdy maska siatki jest włączona).
  - Legenda ma jedną kartę na widoczną warstwę i znika przy `viewport_colorbar_visible === false`.
- [ ] **Krok 2:** Zaimplementować `planarFieldLayers.ts`; przenieść testy z `planarTargetFieldProfile.test.ts`.
- [ ] **Krok 3:** Zaimplementować listę (chipy przez istniejące `VisualizationDisplayPassesControl`).
- [ ] **Krok 4:** Przerobić `PlanarTargetFieldSection` na edytor wybranej warstwy z sześcioma przebiegami i zwijanymi grupami stylu.
- [ ] **Krok 5:** Zastosować flagi warstw i regułę W7 w kompozycji, wieloprzekroju i legendzie.
- [ ] **Krok 6:** Bramki frontendu; commit `Make the 2D inspector a per-object field layer list`.

### Zadanie 11: Sekcje płaszczyzny i kadru, stopka, wstążka

**Pliki:** utwórz `modules/inspector/visualization/PlanarSectionPlaneSection.tsx` (+ test), `PlanarCropViewSection.tsx` (+ test); zmień `PlanarVisualizationSection.tsx`, `modules/inspector/panels/ObjectVisualizationOverview.tsx` (tylko wariant 2D), `modules/inspector/InspectorModule.tsx` (+ test), `modules/ribbon/ribbonTabViews.tsx`, `ribbonContributions.tsx`, `ribbonStructure.test.ts`.

- [ ] **Krok 1: testy**
  - Sekcja płaszczyzny zawiera Źródło, Płaszczyznę, Tryb, Przekrój i Pozycję; wpisanie `12.5` nm i Enter wysyła `default_slice.position_fraction` przeliczone z `section.normal_min_m`/`normal_max_m` i ograniczone do `[0, 1]`; wartość nieliczbowa pokazuje błąd przy polu i nie wysyła nic.
  - Dla źródła monitora pola Płaszczyzna, Tryb i Pozycja są tylko do odczytu z powodem „Zdefiniowane przez monitor".
  - Sekcja kadru: cztery pola liczbowe w jednostce osi; `u_min ≥ u_max` pokazuje błąd przy polu; „Wyczyść kadr" wywołuje `queuePlanarCropPatch(null)`; bez kadru pola pokazują pełne granice jako placeholder.
  - Nagłówek 2D pokazuje stan danych i gotowość siatki w jednej linii; w wariancie 2D nie ma czterech kafli.
  - Stopka: przy aktywnym `field-map` „Fit view" wykonuje `field-map.fit`; przy `viewport-3d` nadal `viewport-3d.fit`.
  - Sekcja 2D rejestruje sesję `liveViewport`; „Reset display" wysyła stan domyślny `planar` z zachowaniem `source` i `default_slice`.
  - Wstążka: grupa `view-slice-2d` zawiera komendy narzędzi i masek z tymi samymi identyfikatorami co pasek.
- [ ] **Krok 2:** Zaimplementować sekcje (logika przeniesiona z `DefaultPlanarSourceSection` i dawnego `PlanarSectionStrip`).
- [ ] **Krok 3:** Ułożyć `PlanarVisualizationSection` według 2.4.
- [ ] **Krok 4:** Poprawić „Fit view" i rejestrację sesji edycji.
- [ ] **Krok 5:** Wstążka: dopisać komendy; przed usunięciem mapowań `view-slice-plane`/`view-slice-layers`/`view-slice-quality` w `buildViewSlice2DGroup` potwierdzić grepem, że żaden statyczny element ich nie używa — usunąć tylko wtedy.
- [ ] **Krok 6:** Bramki frontendu; commit `Move 2D plane and crop controls into the inspector`.

## Etap 5 — weryfikacja i zamknięcie

### Zadanie 12: Regresje przeglądarkowe i zakończenie gałęzi

**Pliki:** `apps/control-room/scripts/smoke-viewport-2d.mjs`, `smoke-viewport-2d.test.mjs`, `scripts/smoke-inspector.mjs`, `docs/status/2d-slice-capabilities.md`.

- [ ] **Krok 1:** Scenariusze w `smoke-viewport-2d.mjs`, każdy z asercją na atrybutach `data-planar-*` i na DOM:
  1. Pasek ma sześć narzędzi; nad płótnem nie ma kontrolek Quantity/Scope/Free section.
  2. Zoom ramką zwiększa `planar.interaction.zoom`; `F` przywraca 1.
  3. Kadr: po zatwierdzeniu `meta.frame.bounds_uv_m` równa się ramce, `sample_token` się zmienia, podziałka osi pokazuje zakres kadru; „×" w pasku stanu przywraca pełne granice.
  4. Inspektor: najechanie na obiekt FEM pokazuje blok z numerem węzła; ten sam scenariusz na scenie FDM pokazuje środek komórki.
  5. Warstwy: dodanie warstwy obiektu i Airboxa, ukrycie jednej, zmiana kolejności; liczba kart legendy równa liczbie widocznych warstw.
  6. Maska wektorów z paska ukrywa wektory wszystkich warstw bez zmiany flag warstw.
  7. Suwak pozycji w pasku stanu zmienia `default_slice.position_fraction` raz na puszczenie.
  8. Sesja zapisana przed zmianą (fixture `legacy`) otwiera się z tym samym obrazem (Review Focus 1).
- [ ] **Krok 2:** `smoke-inspector.mjs`: regresja Obiektu i Airboxa dla listy warstw — bez remontowania panelu i bez resetu przewijania po mutacji.
- [ ] **Krok 3:** Uruchomić scenariusze na grupie Docker DEV worktree, na checkoucie ext4 w WSL; zapisać wyniki i zrzuty w PR. Wynik bez dowodu z uruchomienia oznaczać „NIE ZWERYFIKOWANO".
- [ ] **Krok 4:** Pomiar wydajności: czas od zatwierdzenia kadru do pierwszej klatki oraz liczba zapytań przy 1, 4 i 16 widocznych warstwach; wpisać do `docs/status/2d-slice-capabilities.md` razem z listą nowych możliwości.
- [ ] **Krok 5:** Testy Rust z Zadań 2–4 uruchomić dopiero po odwołaniu zakazu; do tego czasu PR wymienia je jako „NIE URUCHOMIONE".
- [ ] **Krok 6:** Cykl zakończenia z `AGENTS.md`: commit → PR do `master` → merge → fast-forward głównego checkoutu → zatrzymanie i usunięcie grupy Docker zadania → `git worktree remove` → wpis w `storage/index`.

---

## Kolejność i zależności

| PR | Zadania | Zależy od | Dostarcza samodzielnie |
|---|---|---|---|
| 0 | 1 | — | kontrakty i nota fizyczna |
| 1 | 2, 3, 4 | 0 | API: warstwy, okno, węzeł (stary klient działa dalej) |
| 2 | 5, 6 | 0 | pasek ikon i pasek stanu na istniejących funkcjach |
| 3 | 7, 8, 9 | 1, 2 | zoom ramką, linijka, kadr, inspektor węzła |
| 4 | 10, 11 | 1, 2 | lista warstw i nowy inspektor 2D |
| 5 | 12 | 3, 4 | regresje, pomiary, zamknięcie |

PR 2 usuwa kontrolki Quantity/Component/Scope znad płótna, zanim PR 4 doda listę warstw. W tym oknie te ustawienia są dostępne w obecnym inspektorze 2D (sekcje Quantity, Component i „Shared 2D Plane" już tam są), więc żadna funkcja nie znika. PR 3 i PR 4 nie dotykają tych samych plików poza `FieldMapModule.tsx` i `fieldMapDataPlan.ts`; wykonywać je kolejno.

## Otwarte pytania do użytkownika

1. Czy zakaz kompilowania testów jednostkowych obejmuje także Vitest frontendu (`pnpm --dir apps/control-room test`)? Plan zakłada, że testy Vitest są pisane, a uruchamiane tylko, jeśli zakaz ich nie dotyczy.
2. Limit 16 warstw (W3) i start nowej sesji z jedną warstwą „Wszystkie obiekty" (W4) — do potwierdzenia.
3. Wybór obiektu kliknięciem na płótnie 2D (W8) jest poza zakresem — czy ma wejść do osobnego planu?
