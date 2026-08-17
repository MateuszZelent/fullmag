# Audyt produkcyjny głównego menu i ribbonu Control Room (frontend v2)

Data: 2026-08-16
Zakres: `apps/control-room`
Branch audytowany: `master` (stan roboczy worktree, nie `HEAD`)

## 1. Zakres i metoda

Audyt obejmuje powierzchnię „głównego menu / ribbonu" aplikacji Control Room:

| Obszar | Pliki |
|---|---|
| Górny pasek aplikacji (App menu) | `src/kernel/layout/AppMenuBar.tsx`, `appMenuModel.tsx`, `AppMenuBarHeaderModel.ts`, `src/modules/app-menu/*` |
| Moduł Ribbon | `src/modules/ribbon/*` (15 plików, ~13,3 tys. linii) |
| Style ribbonu i headera | `src/design/styles/ribbon.css`, `src/design/styles/header.css` |

Metoda: audyt statyczny kodu (HTML/JS/TS/CSS) + weryfikacja bramek repozytorium
(testy, typecheck, lint). Nie wykonywano browser smoke (wymaga działającego dev-servera;
zob. §2 — stan bramek i tak jest obecnie czerwony na niepowiązanym pliku).

## 2. Wyniki weryfikacji narzędziowej (stan faktyczny)

| Bramka | Wynik | Dowód |
|---|---|---|
| Testy ribbonu/headera (scope) | PONIESIONE | `vitest run src/modules/ribbon src/kernel/layout/AppMenuBar*.test*` -> 7 plików, 127 testów pass |
| Lint ribbon/header/design (scope) | CZYSTE | `eslint src/modules/ribbon src/kernel/layout/AppMenuBar*.ts* src/design/styles --max-warnings=0` -> 0 problemów |
| Typecheck (pełny) | CZERWONE | 1 błąd: `ObjectVisualizationController.ts:716` `TS2339: Property 'renderMode' does not exist on type 'VisualizationStoredTargetPatch'` |
| Lint (pełny, `pnpm lint`) | CZERWONE | 6331 problemów (1407 errors, 4924 warnings); dominuje `react-hooks/preserve-manual-memoization` (React Compiler) |

Ważna interpretacja: obie czerwone bramki nie dotyczą ribbonu. `typecheck` czerwienieje
przez niezacommitowaną zmianę w `ObjectVisualizationController.ts` (plik `M` w worktree),
a `lint` czerwienieje przez pliki aktywnego refaktoru 2D viewport
(`FieldMapModule.tsx`, `PlanarVisualizationSection.tsx`, `ObjectVisualizationPanel.tsx`)
zostały potwierdzone niezależnym lintem scope. Kod ribbonu/headera jest przy obecnych
typach czysty typowo i lintowo.

Stan worktree: branch `master`, 66 zmienionych plików (~5,8 tys. insertions), w tym
`src/modules/ribbon/ribbonCommands.ts` i `ribbonStructure.test.ts`. Audyt oddaje stan
roboczy, a sama branża `master` nie ma obecnie zielonego pełnego `typecheck`/`lint`.

## 3. Ocena architektury (pozytywna)

- Ribbon jest **data-driven**: deklaratywny katalog zakładek
  (`RibbonTabContent` -> `RibbonGroup` -> `RibbonAction` -> `RibbonMenuNode`) w
  `ribbonTabViews.tsx` / `ribbonContributions.tsx`, a stan poleceń (disabled / active /
  tooltip) jest nakładany w runtime przez `applyCommandState` i
  `applyCommandStateToMenuNode` na podstawie `CommandRegistry` (`commandId ?? id`).
  To czyste oddzielenie treści od zachowania.
- Wykonanie poleceń przechodzi przez kanoniczny `CommandRegistry` (13 kontrybucji w
  `ribbonCommands.ts` z poprawnymi `isEnabled`/`disabledReason`), a zasobów przez warstwę
  resource hooks z warunkowym `enabled` i drobnoziarnistą równością
  (`selectRibbonRuntimeStatus` + `ribbonRuntimeStatusEquals` w `RibbonModule.tsx`).
  To dobra higiena wydajnościowa (brak zbędnych fetchy dla nieaktywnych zakładek).
- Rejestracja modułów przez manifest + sloty (`ribbon`, `app-menu`) zgodna z architekturą
  modułów frontend-v2.
- Brak w module ribbon `any`, `@ts-ignore`, `TODO`/`FIXME`/`HACK` — dobra higiena.

## 4. Tailwind / CSS / system designowy

**Stan:** ribbon i header nie używają ani jednej klasy utility Tailwind — wyłącznie
niestandardowe klasy `fm-*` zbudowane na tokenach `--fm-*` w `src/design/styles/*`.
Jest to spójne z doktryną repo (tokeny = źródło prawdy; Tailwind = warstwa utility),
ale warstwa utility jest tu de facto nieużywana.

Ustalenia:

1. **Niezgodności tokenowe.** `ribbon.css` używa surowych rozmiarów
   `font-size: 9px` (linie 162, 363), `font-size: 8px` (linie 180, 435) oraz surowych
   wysokości `18px`/`22px` zamiast tokenów. Najmniejszy token to `--fm-font-size-2xs`
   (10px), więc etykiety grup schodzą poniżej skali tokenów.
2. **Czytelność/a11y.** Etykiety grup ribbonu i podpisów to uppercase 8–9 px — poniżej
   komfortowego minimum czytelności (WCAG 1.4.4 + praktyka desktop ~12 px).
3. **Niespójna składnia media queries.** `header.css` używa nowoczesnej range syntax
   (`@media (width < 1180px)`), `ribbon.css` legacy (`@media (max-width: 1400px)`).
4. **Martwy CSS.** `.fm-header__spacer` (`header.css:107`) nie ma żadnego użycia w `src/`.
5. **Sprzężenie z desktop-shell.** `.fm-header` i dzieci używają
   `-webkit-app-region: drag/no-drag` (`header.css:10,14,22,66,118,144,175,228`).
   W zwykłej przeglądarce nieszkodliwe, ale jeśli build jest także webowy, powinno być
   warunkowane pod wrapper Electron/Tauri.
6. **Dwie rozbieżne tabele kolorów.** `ICON_COLOR_ALIASES` (`RibbonGroupsRow.tsx:19–42`)
   i `C` (`ribbonCommon.tsx:314–325`) duplikują mapowanie nazwa koloru -> token. Ponadto
   `iconColor` to wolny string — nieznane wartości są po cichu pomijane
   (`resolveRibbonIconColor` zwraca `undefined`), bez walidacji na etapie kompilacji.

## 5. Jakość HTML / JS / TS

1. **Fałszywe pole wyszukiwania (`AppMenuBar.tsx:526–541`).** `readOnly` `<input>` w
   `<label onClick=...>`, a `onFocus` natychmiast robi `blur()` i otwiera command palette.
   Kliknięcie labelekta wywołuje `onClick` labela **i** `onFocus` inputa -> potencjalne
   podwójne wywołanie `runCommand("workspace.command-palette")`. Placeholder hardkoduje
   skrót. To hack, nie komponent.
2. **Wskaźnik sesji otwiera dialog na focus/pointer-enter (`AppMenuBar.tsx:543–567`).**
   `onFocus={openApiDialog}` i `onPointerEnter={openApiDialog}` otwierają modal po
   tabulacji / najechaniu (gdy błąd sesji). Otwarcie modal po focus jest nietypowym
   zachowaniem klawiszowym.
3. **Split-button — prawdopodobny defekt (wymaga smoke).** `RibbonGroupsRow.tsx:150–169`:
   ciało split-buttona obsługuje `onPointerDownCapture` (`preventDefault()` + wykonanie
   komendy), ale Radix `DropdownMenuTrigger` (zweryfikowane w `node_modules/@radix-ui/*`
   `dist/index.mjs`) otwiera menu na `onPointerDown` w fazie bubble **bez sprawdzania
   `event.defaultPrevented`**. Skutek statyczny: klik ciała split-buttona najpewniej
   wykonuje komendę **i jednocześnie** otwiera dropdown. Pokrycie testowe dotyczy tylko
   funkcji czystej `resolveRibbonActionTriggerState`, nie przepływu zdarzeń. Klasyfikacja:
   `prawdopodobny defekt / niezweryfikowany w przeglądarce`.
4. **Niepełny/niewłaściwy wzorzec ARIA tabs.** `RibbonTabStrip.tsx` ustawia
   `role="tablist"`/`role="tab"`/`aria-selected`, ale bez `aria-controls`, a
   `RibbonGroupsRow.tsx:292` renderuje jeden statyczny `<div role="tabpanel">` obejmujący
   wszystkie grupy — bez `id`, `aria-labelledby` i bez związku z aktywną zakładką.
   Semantycznie `tabpanel` powinien zawierać treść aktywnej zakładki. Należy domknąć
   wzorzec (per-tab panel + `aria-controls`/`aria-labelledby`) albo zrezygnować z roli
   `tabpanel` i zostawić zwykły pasek przycisków/nawigację.
5. **Query DOM z handlera (`RibbonTabStrip.tsx:538`).** `container.querySelectorAll`
   po `[role="tab"]` z wnętrza `onKeyDown` — działa, ale sprzęga nawigację z DOM zamiast
   z referencjami React.
6. **Slider: brak guarda dzielenia przez zero.** `RibbonMenuRenderer.tsx:209`
   `(node.max - node.min)` da `NaN%`, gdy `min === max` (obecnie niewystępujące, ale
   model danych na to pozwala).
7. **Helper `menu()`/`radioMenu()` hardkoduje `disabled: true`** dla wszystkich pozycji
   (`ribbonCommon.tsx:340,366`). Typ `RibbonMenuNode` opisuje funkcjonalne węzły, a helper
   produkuje wyłącznie wyłączone. To zapach warstwy danych.

## 6. Dostępność

- Wzorzec tabs niekompletny (patrz §5.4).
- Przyciski run-control (`AppMenuBar.tsx:611–627`) są ikonowe (`size="icon"`) z `title`,
  ale bez `aria-label`; `title` nie jest wiarygodnie ogłaszany przez czytniki ekranu.
- Przycisk „Detail" (`RibbonGroupsRow.tsx:205–212`) — mikroskopijny tekst + `title`,
  brak `aria-label`.
- Etykiety 8–9 px (patrz §4.2).
- Wiersz grup ma `overflow-x: auto` + `scrollbar-width: none` (`ribbon.css:86–92`) bez
  `aria-label` na kontenerze — użytkownicy klawiaturowi mogą nie odkryć niewidocznych grup.
- `pointer-events: none` na wyłączonych akcjach (`ribbon.css:246–250`) usuwa hover/tooltip
  pomocniczy dla elementów wyłączonych.
- Selektor koloru: swatch z `role="button"` + obsługa Enter/Space — akceptowalne.

## 7. Wydajność

- Warunkowe ładowanie zasobów per zakładka w `RibbonModule.tsx` i drobnoziarniste
  selektory z `isEqual` — wzorcowa higiena (brak zbędnych pobrań dla nieaktywnych tabów).
- `WorkspaceRenderProfiler` oplata całość modułu; istnieją testy wydajnościowe
  (`RibbonMenuRenderer.performance.test.ts`, `useLayout.performance.test.ts`).
- Brak widocznych gorących ścieżek w renderze menu (render menu jest leniwy — tylko po
  otwarciu dropdownu przez Radix).

## 8. Gotowość produkcyjna / placeholdery

Ribbon frontend-v2 świadomie eksponuje dużą liczbę **wyłączonych placeholderów** bez
komend. Miary statyczne: 38 wystąpień `disabled: true` w `ribbonTabViews.tsx`, 74 w
`ribbonContributions.tsx` (akcje + węzły menu).

Najistotniejsze:

- Zakładka **Definitions** jest w całości wyłączona (Parameters / Functions / Coordinates).
- **Geometry**: Boolean, Transform, większość Viewport/Lifecycle oraz Focus są w dużej
  mierze wyłączone; włączone akcje mają często menu-placeholdery (`menu()` — wszystkie
  pozycje disabled), np. `geometry.add-box` z wariantami „Block / Thin film / Cuboid".
- **Materials**: Parameters, DMI, Ku, Texture Inspector, Bloch/Néel Sky wyłączone.
- **Physics**: RF Sources wyłączone.
- **Home**: Open, 3D Visual preset, Focus, Reset layout wyłączone.
- **Study/Results/Automation**: Sync Script (x2), Chart wyłączone.
- Klasa `study.add-*` (Relax/Antenna/Table/Autosave/FFT/Run) i `mesh.build-*` są
  split-buttonami z realną komendą w ciele, ale ich dropdowny to placeholdery z samymi
  wyłączonymi pozycjami.

Dla wypuszczenia produkcyjnego to jawne „martwe sterowanie" w widocznej powierzchni:
albo podpiąć komendy, albo nie renderować akcji bez komend w buildzie produkcyjnym.

Asymetria app-menu vs ribbon: app menu **ukrywa** niezaimplementowane komendy
(globalna lista `HIDDEN_PLACEHOLDER_COMMAND_IDS` + `hidePlaceholderMenuNodes` w
`appMenuModel.tsx:47–78`), natomiast ribbon **pokazuje** wyłączone placeholdery. Spójna
polityka produkcyjna (renderuj tylko akcje z zarejestrowaną komendą) usunęłaby ten
rozdźwięk.

## 9. Klasyfikacja stanu (wg wymagań produkcyjnych)

- **Zaimplementowane:** architektura data-driven ribbonu, warstwa komend, warunkowe
  ładowanie zasobów, obsługa stanu aktywnego/wyłączonego, menu/podmenu/slider/kolor/text,
  app menu z dialogami narzędziowymi.
- **Częściowe:** wzorzec ARIA tabs (role bez powiązań), spójność tokenów typograficznych,
  walidacja `iconColor`.
- **Produkcyjnie wykonywalne:** TAK warunkowo — w obecnym stanie worktree pełny
  `typecheck`/`lint` nie przechodzi (poza scope ribbonu), a powierzchnia zawiera widoczne
  placeholdery.
- **Zweryfikowane:** testy ribbonu/headera 127/127 zielone; lint scope ribbon/header
  czysty; pełne bramki repo czerwone z przyczyn niepowiązanych z ribbonem.

## 10. Rekomendacje (priorytet)

1. **P1 — Split-button:** zweryfikować w browser-smoke podwójne „run + open dropdown" na
   ciele split-buttona i poprawić (np. zatrzymać otwarcie w fazie capture lub przenieść
   split na dedykowany komponent z osobnym triggerem).
2. **P1 — ARIA tabs:** domknąć `tablist/tab/tabpanel` (`aria-controls` + `id` +
   `aria-labelledby`, per-tab panel) albo usunąć role i zostawić prostą nawigację.
3. **P1 — Fałszywe pole search:** zamienić na przycisk, uniknąć podwójnego wywołania,
   usunąć samoblur-hack.
4. **P2 — Placeholdery produkcyjne:** nie renderować akcji/menu bez zarejestrowanej
   komendy w buildzie produkcyjnym (flaga), zanim feature nie ma komendy.
5. **P2 — Tokeny:** wprowadzić tokeny typograficzne min. 10px i usunąć surowe 8–9 px;
   ujednolicić składnię media queries; usunąć martwy `.fm-header__spacer`.
6. **P2 — Kolory:** zunifikować `ICON_COLOR_ALIASES` i `C`; zawęzić typ `iconColor` do
   unii znanych aliasów, aby błędy pisowni były błędem kompilacji.
7. **P3 — Rozmiar plików:** rozważyć wydzielenie statycznych definicji 8 zakładek z
   `ribbonContributions.tsx` (3737 linii) do katalogu katalogu (precedens:
   `homeTab`/`viewTab` już w `ribbonTabViews.tsx`), pozostawiając builder dynamiczny.
8. **P3 — A11y:** `aria-label` dla ikonowych przycisków run-control i „Detail";
   `aria-label` na scrollowalnym wierszu grup.

## 11. Stan sprzed audytu (background)

Worktree `master` zawiera niezacommitowane zmiany z aktywnych strumieni (refaktor
2D viewport / wizualizacja airbox / rejestr wizualizacji). Audyt @HEAD nie został
wykonany; powyższe ustalenia dotyczą stanu roboczego.
