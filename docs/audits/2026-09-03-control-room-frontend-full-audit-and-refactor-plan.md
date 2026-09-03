# Audyt frontendu FullMag Control Room — stan na 2026-09-03

**Zakres:** `apps/control-room` (Next.js 16 / React 19 / TypeScript, ~475 000 linii w `src/`) — aktywny, rozwijany frontend platformy do konfiguracji i analizy symulacji mikromagnetycznych (FEM/FDM). Pobocznie: `apps/legacy_web` (poprzednia wersja, status omówiony niżej), `apps/desktop` (opakowanie Tauri budowane ze statycznego eksportu control-roomu), `apps/web` (pusty stub).

**Metodologia:** audyt kodu źródłowego, konfiguracji CI/CD, systemu stylów i biblioteki komponentów, wykonany bezpośrednio na repozytorium, uzupełniony syntezą **23 istniejących, wewnętrznych dokumentów audytowych/architektonicznych** (ADR-y, specyfikacja `frontend-v2`, audyty punktowe z okresu maj–wrzesień 2026). Celem nie jest powtórzenie tamtych, bardzo szczegółowych audytów domenowych (viewport 3D, wyniki/sweepy FDM, autoring symulacji), lecz danie jednego, przekrojowego obrazu: architektura i dług techniczny, design system i UX/a11y, gotowość produkcyjna (CI, testy, wydajność, bezpieczeństwo) — oraz jeden skonsolidowany plan działania.

**Werdykt w skrócie:** kod jest wyraźnie **lepszej jakości inżynierskiej, niż typowy projekt tej skali** — zdyscyplinowany TypeScript, zero `any`/TODO w źródłach, w pełni własny, czysty kernel (event bus / command bus / selection controller), automatyczny skrypt egzekwujący reguły architektoniczne, dojrzały trzywarstwowy system tokenów CSS. Jednocześnie **nie jest gotowy na wydanie produkcyjne w obecnym stanie**: zero error-trackingu w produkcji, zero nagłówków bezpieczeństwa, CI faktycznie uruchamia 2 z 24 istniejących testów smoke, część reguł design systemu jest łamana od maja i wciąż nierozwiązana, a kilkanaście plików „śmietników" (do 6500+ linii) czeka na podział obiecany już w ADR-ze z maja. To dobrze zbudowany, ale **niedokończony** system — najbliższy problem to nie jakość kodu, tylko rozjazd między tym, co zaprojektowano/zadeklarowano (specyfikacja `frontend-v2`, kryteria cutover), a tym, co faktycznie zweryfikowano i wpięto w bramki CI.

---

## 1. Architektura i dług techniczny

### 1.1 Stan migracji „module-kernel"

Projekt jest w trakcie zaplanowanej migracji z `apps/legacy_web` (992 pliki, ~212 000 linii, m.in. kontekst `ControlRoomContext.tsx` na 1930 linii) do `apps/control-room`, zbudowanego wg architektury opisanej w ADR 0013 (2026-05-11): kernel jako jedyny stabilny rdzeń (routing, `KernelApi`, rejestr modułów, event bus, rejestr komend, sloty layoutu, fasada API, inwalidacja zasobów), moduły komunikujące się wyłącznie przez zdarzenia/komendy/resource hooki — bez importów między modułami i bez bezpośredniego `fetch()`. Wg dokumentu migracji (`docs/specs/frontend-v2/07-migration-strategy.md`, ostatnia aktualizacja 2026-08-03) projekt znajduje się w **Fazie 6 (parytet modułów)** z 8 zaplanowanych faz; cutover (wygaszenie legacy) nie został zadeklarowany, a Faza 8 (packaging Tauri) jeszcze się nie zaczęła.

ADR 0015 (2026-05-22) dopuszcza tymczasowe przekroczenie limitów rozmiaru pliku dla już istniejących „grzeszników" (ribbon, viewport-3d, panele inspektora, `ControlRoomApi.ts`) pod warunkiem, że mają testy i nie łamią granic modułowych — **ale zastrzega, że muszą zostać podzielone przed cutover**. To zobowiązanie nie zostało dotychczas zrealizowane (patrz 1.3).

### 1.2 Rozkład wielkości modułów

`src/modules` liczy 970 plików w 12 modułach, ale rozkład jest skrajnie nierówny: **`inspector` (406 plików, 42%) i `viewport-3d` (290 plików, 30%) odpowiadają razem za 72% kodu modułów**, podczas gdy `app-menu` ma 2 pliki, `status-bar` 5, a `ribbon` 16. Te dwa moduły nie mają też spójnej struktury wewnętrznej z resztą (własne, głęboko zagnieżdżone podkatalogi), podczas gdy mniejsze moduły są całkowicie płaskie. W praktyce `inspector` i `viewport-3d` funkcjonują jak dwa mini-monolity osadzone w architekturze, która miała temu zapobiegać.

### 1.3 Mega-pliki

Zidentyfikowano **21 plików produkcyjnych powyżej 1500 linii** (nie licząc testów i kodu generowanego). Najbardziej problematyczne, zweryfikowane treściowo:

| Plik | Linie | Ocena |
|---|---|---|
| `modules/viewport-3d/hooks/useViewport3DSceneModel.ts` | 6575 | 93 eksportowane funkcje/interfejsy — plik-śmietnik złożony z niezależnych funkcji domenowych (skala wektorów, nakładki regionów, bufory pól). Uzasadniona złożoność domenowa, ale zerowa nawigowalność. |
| `modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` | 5994 | **70 osobnych komponentów React w jednym pliku.** To już nie jest kwestia domeny — każdy panel (Eigen Spectrum, FMR Peaks, Frequency Response…) powinien mieć własny plik. |
| `kernel/api/ControlRoomApi.ts` | 4256 | Jedna klasa, 12 namespace’ów zasobów API — strukturalnie sensowny „fasada/SDK", ale rozmiar utrudnia review; łatwo dzielony per-namespace. |
| `modules/inspector/panels/StudyStageAuthoringModel.ts` | 4108 | — |
| `modules/ribbon/ribbonContributions.tsx` | 3827 | — |
| `modules/viewport-3d/Viewport3DModule.tsx` | 3359 | — |
| `modules/inspector/panels/ObjectVisualizationPanelModel.ts` | 3235 | — |
| `modules/viewport-3d/viewport3dRenderModel.ts` | 3172 | — |
| `kernel/runtime/studyRuntimeCommandContributions.ts` | 2861 | — |

Te same pliki (zwłaszcza `useViewport3DSceneModel.ts` i `ribbonContributions.tsx`) pojawiają się jako „znane problemy" w audytach z 2026-05-30 i 2026-06-24 — od tego czasu **urosły**, zamiast zostać podzielone.

### 1.4 Kernel i zarządzanie stanem

Kernel jest w 100% własną implementacją — brak zustand/redux/jotai/mobx. `EventBus` (typed pub-sub), `CommandRegistry` (z dedykowanym kontrolerem diagnostyki komend) i `SelectionController` (bogato typowany, osobne typy selekcji per domena: FDM, wizualizacja modalna, postprocessing) tworzą architekturę zbliżoną do systemu wtyczek IDE (styl VS Code). To dobra, przemyślana decyzja architektoniczna — jest jednak w pełni bespoke, więc cały ciężar utrzymania (dokumentacja, onboarding nowych osób) spoczywa na zespole, bez wsparcia ekosystemu.

### 1.5 Jakość kodu — bardzo dobra dyscyplina

Zero realnych użyć `any`/`as any` w `src`, tylko 2 uzasadnione `@ts-expect-error` (oba w testach), zero `TODO`/`FIXME`/`HACK` w całym drzewie źródłowym. 640 plików testowych na ~877 plików produkcyjnych (~73%) — bardzo wysoka gęstość testów jak na projekt tej wielkości. 16 wystąpień `eslint-disable`, skoncentrowanych wokół reguł React Compiler/hooks (5 z nich w `useViewport3DSceneModel.ts` — kolejny argument za rozbiciem tego pliku).

### 1.6 Egzekwowanie granic architektonicznych

`scripts/check-architecture-hygiene.mjs` (uruchamiany w CI, obecnie **PASSED**) faktycznie egzekwuje 8 reguł: zakaz plików tymczasowych (`.orig`/`.bak`), zakaz importów kernela do wnętrza modułów, zakaz importów między modułami poza `/public`, zakaz mutujących callbacków w ribbonie (musi być command-id, nie `onSelect`), obowiązkowe hostowanie `AppMenuBar` przez slot, zakaz „szerokich" wzorców inwalidacji cache w komendach runtime, zakaz odwołań do ścieżek legacy w aktywnej konfiguracji i zakaz surowych kolorów hex poza `src/design/styles/`. To rzadkość na tę skalę projektu — realny, egzekwowany guardrail, a nie tylko dokumentacja.

**Istotna luka:** reguła nr 3 (izolacja modułów) **nie obejmuje plików testowych** — testy swobodnie importują z innych modułów z pominięciem `/public`, więc granice architektoniczne są miękkie dokładnie tam, gdzie najłatwiej złapać regresję integracyjną.

---

## 2. Design system, style i UX/dostępność

### 2.1 System tokenów — dojrzały, ale niekonsekwentnie egzekwowany

`src/design/styles/` to nie garstka plików, lecz **49 plików CSS, ~14 300 linii**, zorganizowanych w pięć warstw CSS (`@layer fm-tokens/fm-base/fm-primitives/fm-components/fm-modules`), zgodnie ze specyfikacją `docs/specs/frontend-v2/09-css-design-system.md`. Motyw Catppuccin (Mocha jako dark domyślny, Latte jako light) z precyzyjną skalą spacing, wysokości kontrolek i promieni jest zmapowany na natywne klasy Tailwind v4 przez `@theme inline` (`bg-fm-panel`, `text-fm-sm` itd.) — to solidne, ponadprzeciętne rozwiązanie jak na projekt naukowy.

Problem nie leży w projekcie tokenów, lecz w **egzekwowaniu**: raw hex-y poza tokenami i odwołania do niezdefiniowanych zmiennych (`--fm-bg-surface`, `--fm-bg-elevated`) są zgłaszane w kolejnych audytach od **2026-05-30**, powtórzone 2026-06-24 i 2026-06-30 — czyli problem trwa **ponad trzy miesiące** mimo istnienia automatycznej reguły hygiene zakazującej hex poza `src/design/styles/`. Osobno: specyfikacja zakłada, że style modułów mają leżeć „obok modułu", a w praktyce niemal wszystkie (`inspector.css` 24 KB, `viewport-3d.css` 19 KB) są scentralizowane w `src/design/styles/` — rozjazd między dokumentem a implementacją.

### 2.2 Biblioteka komponentów

`src/shared/ui/` (30 plików, shadcn/ui „new-york" + 15 pakietów `@radix-ui/*`) pokrywa większość podstaw (Button, Dialog, Select, Tooltip, Popover, Sheet, ContextMenu, DropdownMenu, Command, Slider, Switch, Tabs, komponenty resizable/sortable), ale **brakuje generycznych prymitywów: `Card`, `Table`, `Textarea`, `RadioGroup`, `Avatar`** — ich brak przy 391 plikach modułów `.tsx` to ryzyko, że kolejne moduły „wynajdują" własne, niespójne odpowiedniki zamiast sięgać po wspólną bibliotekę. Pozytywnie: inline style (`style={{`) występują zaledwie 28 razy w całym `src/modules`, a `cva` (class-variance-authority) jest trzymane tam, gdzie powinno — w bibliotece bazowej, nie rozlane po modułach. Helper `cn()` (rozszerzenie `tailwind-merge` o grupy tokenów `fm-*`) jest dobrze zaprojektowany i konsekwentnie używany.

### 2.3 Font, który nigdy się nie ładuje

`tokens.css` deklaruje `--fm-font-ui: Inter`, ale w całym repo **nie ma `next/font`, `@font-face` ani linku do Google Fonts** — aplikacja realnie renderuje się fontem systemowym/fallbackiem, niezgodnie z zamierzonym wyglądem. To błąd niskiego kosztu naprawy o zauważalnym wpływie wizualnym.

### 2.4 Dostępność (a11y)

877 wystąpień `aria-*` i 352 `role=` w `src` to solidny wynik. `:focus-visible` jest zdefiniowany globalnie, drag&drop (`@dnd-kit`) poprawnie deklaruje `KeyboardSensor` obok `PointerSensor`. Braki: **zero skip-linków** (istotne przy tak gęstym, klawiaturowym interfejsie), oraz Storybook z **skonfigurowanym `@storybook/addon-a11y`, ale zaledwie 2 plikami `.stories.tsx` w całym repo** na 400+ komponentów — addon działa, ale praktycznie nie ma czego skanować. Storybook jest de facto martwym narzędziem dokumentacji/testowania wizualnego mimo poniesionej inwestycji konfiguracyjnej.

### 2.5 Wzorce UX — brak spójności poza viewportem 3D

`ErrorBoundary` istnieje w zaledwie 4 plikach, wyłącznie wokół `viewport-3d` — pozostałe moduły nie mają zunifikowanej obsługi błędów runtime. Podobnie: zero wystąpień `isLoading`/`isPending` w `src/modules` — nie ma spójnej konwencji stanu ładowania, każdy moduł radzi sobie inaczej. Wspólny komponent `EmptyState` używany jest tylko 2 razy w całym repo. To największa systemowa luka UX: użytkownik może doświadczać zupełnie innego zachowania przy błędzie/ładowaniu/pustym stanie w zależności od tego, w którym module aktualnie pracuje.

### 2.6 Layout i responsywność

`WorkspaceDockLayout.tsx` na `react-resizable-panels` (zagnieżdżone grupy paneli, `autoSaveId` per konfiguracja, persystencja układu) jest dobrze zaprojektowanym, elastycznym systemem doku — odpowiednim dla aplikacji typu „control room", nie wymagającej mobile-first RWD.

---

## 3. Gotowość produkcyjna: CI/CD, testy, wydajność, bezpieczeństwo

### 3.1 CI faktycznie sprawdza dużo mniej, niż sugeruje liczba skryptów

Realny, blokujący gate frontendu to job `control-room-contracts` w `bootstrap.yml`: `check:architecture-hygiene` → `audit:idle-performance` → `typecheck` (custom) → `eslint --max-warnings=0` → `vitest run` → `audit:compute-performance` → `bench:compute-performance` → `next build`. To dobrze zbudowany łańcuch bramek statycznych i jednostkowych.

Problem leży w warstwie E2E/smoke: w `package.json` control-roomu jest **41 skryptów** typu `smoke:*`/`audit:*`/`diagnostic:*`/`verify:*`/`check:*` (w tym dokładnie **24 skrypty `smoke:*`**), ale job `browser-fixture-smoke` uruchamia w CI **tylko 2 z nich** (`audit:viewport-3d-memory-churn`, `audit:viewport-3d-fem-topology-uploads`). Nie istnieje żaden zbiorczy skrypt typu `smoke:all` — reszta (viewport 2D, autoring FDM/FEM, live-charts, results navigator, sweep’y modalne…) wymaga ręcznego uruchomienia przez developera. To wygląda na nagromadzenie narzędzi diagnostycznych budowanych punktowo pod konkretne regresje, a nie na utrzymywany, systematyczny E2E suite — mimo imponującej liczby skryptów, rzeczywiste pokrycie regresyjne w CI dla największych, najbardziej złożonych modułów (viewport-3d, inspector) jest wąskie.

Dodatkowo `react-doctor.yml` (skaner bundle-size/performance/a11y/security) działa **wyłącznie w trybie doradczym** — nie blokuje builda, tylko komentuje PR.

### 3.2 Wydajność

Pozytyw: `src/kernel/performance/` to realna, nietrywialna infrastruktura (rejestr budżetu pamięci, profiler renderowania React, diagnostyka aktywności przeglądarki, sonda wydajności wizualizacji) — rzadkość w projektach tej skali. Minus: **tylko 3 pliki w całym `src` używają `next/dynamic`/`React.lazy`** — przy zależnościach takich jak `three`/`@react-three/fiber`, `echarts` i `recharts` ładowanych jednocześnie, to realne ryzyko dużego, niepodzielonego bundla startowego. Brak w CI jakiegokolwiek budżetu wydajności (Lighthouse, bundle-size gate) — jedyne metryki to własne skrypty audytowe, luźno powiązane z realnym UX. Osobny, istotny kompromis: `reactStrictMode: false` jest wyłączony **globalnie** w `next.config.ts` z powodu problemu z WebGL w jednym module (viewport-3d przy R3F v9) — to gasi siatkę bezpieczeństwa React na efekty uboczne w **całej** aplikacji, nie tylko w module, którego dotyczy problem.

Plan naprawczy wydajności GPU FEM (`docs/performance/fem-gpu-performance-remediation-2026-09-01/`) sam siebie oznacza jako **`NOT VERIFIED`** — nie ma potwierdzonych liczb wydajności na realnym GPU. To dotyczy warstwy solvera, nie samego frontendu, ale bezpośrednio wpływa na to, czego może oczekiwać UI (progress, cancelowanie, timeouty) od backendu w warunkach produkcyjnych.

### 3.3 Bezpieczeństwo

Brak `middleware.ts` i brak jakichkolwiek nagłówków bezpieczeństwa (CSP, X-Frame-Options, Referrer-Policy) w `next.config.ts` — zerowa warstwa hardeningu HTTP. `.env.example` zawiera tylko placeholdery infrastrukturalne (`POSTGRES_PASSWORD=change-me` itp.) — bez procesu rotacji sekretów przy wdrożeniu to ryzyko operacyjne, nie kodowe. Brak `dependabot.yml`/`renovate.json` w całym repo, przy jednocześnie bardzo świeżych wersjach kluczowych zależności (React 19.2.4, Next 16.2.11, Tailwind 4.2.2, Vite 8.0.16) — brak zautomatyzowanego patchowania to podwyższone ryzyko przy stacku, który sam w sobie jest mniej „przetestowany bojowo".

### 3.4 Legacy jako martwy kod

`apps/legacy_web` to wciąż pełnoprawna, osobna aplikacja Next.js (~212 000 linii wg wcześniejszych audytów) — ale nie występuje **ani razu** w `.github/workflows/`, `compose.yaml`, `compose.windows.yaml`, `Makefile` ani `justfile`. Nie jest budowana ani deployowana w obecnym pipeline. To martwy kod: koszt utrzymania (czas CI, miejsce, dezorientacja nowych osób „który frontend jest prawdziwy") bez żadnej korzyści, skoro migracja formalnie go zastępuje, a nie synchronizuje z nim funkcje.

### 3.5 Obserwowalność

Zero integracji z narzędziem do error-trackingu w produkcji (Sentry/LogRocket/Datadog). Przy architekturze tej złożoności (viewport 3D/WebGL, długotrwałe obliczenia, streaming wyników) awarie u realnych użytkowników będą praktycznie niewidoczne dla zespołu poza zgłoszeniami ręcznymi. Pozytywnie: zero `console.log`/`console.debug` w kodzie produkcyjnym (poza testami) — dyscyplina jest, brakuje tylko właściwego kanału telemetrii.

---

## 4. Skonsolidowany plan działania

Priorytety łączą świeże ustalenia z tego audytu z nierozwiązanymi problemami powtarzającymi się w dokumentacji wewnętrznej od maja 2026. Szacunki nakładu są rzędu wielkości (S = dni, M = 1–2 tygodnie, L = 2–4 tygodnie), do skalibrowania przez zespół.

### Faza 0 — blokery przed jakimkolwiek wydaniem produkcyjnym (P0)

| # | Działanie | Dlaczego to blokuje release | Nakład |
|---|---|---|---|
| 1 | Wdrożyć error-tracking w produkcji (Sentry lub odpowiednik), spiąć z istniejącymi `ErrorBoundary` i kernelowym systemem diagnostyki | Bez tego awarie u użytkowników są niewidoczne dla zespołu | S–M |
| 2 | Dodać nagłówki bezpieczeństwa (CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy) przez `middleware.ts` lub `headers()` w `next.config.ts` | Zerowa warstwa hardeningu HTTP dziś | S |
| 3 | Uruchomić w CI realny podzbiór istniejących 24 skryptów `smoke:*` (priorytet: viewport-3d, study-authoring, live-charts, results) albo zbudować jeden skrypt `smoke:critical` | Dziś CI faktycznie sprawdza 2 z 24 istniejących testów E2E | M |
| 4 | Przełączyć `react-doctor` z trybu doradczego na blokujący (przynajmniej dla progu bundle-size i krytycznych a11y) | Istniejące narzędzie jest, ale nie chroni niczego | S |
| 5 | Dodać `dependabot.yml`/`renovate.json` | Bardzo świeży stack (Next 16, React 19, Tailwind 4) bez automatycznego patchowania | S |
| 6 | Podjąć i wykonać decyzję o `apps/legacy_web`: usunąć albo formalnie zarchiwizować z jawnym dokumentem statusu | Martwy kod (~212k linii) niepotrzebnie obciąża repo i myli | S–M |
| 7 | Ograniczyć `reactStrictMode: false` wyłącznie do subdrzewa `viewport-3d` (np. przez wydzielony wrapper/segment), przywrócić strict mode wszędzie indziej | Dziś wyłączona jest siatka bezpieczeństwa React w całej aplikacji z powodu jednego modułu | M |
| 8 | Formalnie ukończyć wymóg z ADR 0015: podzielić `FrequencyDomainResultInspectors.tsx` (70 komponentów) i `useViewport3DSceneModel.ts` (93 eksporty) na pliki tematyczne | ADR wprost wymaga tego **przed cutover**; zobowiązanie z maja niedotrzymane, pliki od tego czasu urosły | M–L |

### Faza 1 — dokończenie refaktoryzacji architektonicznej (P1)

| # | Działanie | Nakład |
|---|---|---|
| 1 | Rozbić `ControlRoomApi.ts` na pliki per namespace (`sessions/`, `platform/`, `analysis/`, itd.) w `kernel/api/` | M |
| 2 | Zamknąć dryf design tokenów: usunąć raw hex spoza `src/design/styles/`, zdefiniować lub usunąć `--fm-bg-surface`/`--fm-bg-elevated` — problem otwarty od 2026-05-30 | S–M |
| 3 | Naprawić potwierdzone naruszenia granic modułów (kernel → wnętrze `viewport-3d`; Explorer → wnętrze Inspectora) i rozszerzyć `check-architecture-hygiene.mjs` tak, by ostrzegał (docelowo blokował) na cross-module importy również w plikach testowych | M |
| 4 | Ustandaryzować wewnętrzną strukturę modułu (jeden szablon: `components/`, `hooks/`, `model/`, `public.ts`) i rozważyć rozbicie `inspector`/`viewport-3d` (72% kodu modułów) na mniejsze, samodzielne pod-moduły | L |
| 5 | Załadować font `Inter` przez `next/font` w `app/layout.tsx`, zgodnie z tym, co już deklarują tokeny | S |
| 6 | Zbudować i wdrożyć wspólne `ErrorBoundary` + `EmptyState` w `shared/ui`, wyjść poza `viewport-3d` na wszystkie moduły; ustalić jedną konwencję stanu ładowania (`isLoading`/`isPending`) | M |

### Faza 2 — utwardzenie produkcyjne i porządki (P2)

| # | Działanie | Nakład |
|---|---|---|
| 1 | Wprowadzić code-splitting (`next/dynamic`) dla ciężkich zależności (`three`/R3F, `echarts`, `recharts`) tam, gdzie nie są potrzebne przy pierwszym renderze | M |
| 2 | Dodać budżet wydajności do CI (np. `size-limit` na bundlach, próg web-vitals) | M |
| 3 | Skonsolidować 24 skrypty `smoke:*` w udokumentowany, warstwowy suite (`smoke:critical` w CI per PR, `smoke:extended` nightly) z jednym punktem wejścia | M–L |
| 4 | Ożywić Storybook: story dla każdego prymitywu `shared/ui` (dziś 2 na 400+ komponentów), żeby `@storybook/addon-a11y` faktycznie coś skanował; rozważyć regresję wizualną (np. zrzuty ekranu w Playwright) | M |
| 5 | Dodać brakujące prymitywy UI: `Card`, `Table`, `Textarea`, `RadioGroup`, `Avatar` | S |
| 6 | Zaktualizować lub usunąć nieaktualną dokumentację (`layout-handle-guide.md`, `docking-layout-contract.md` odwołują się do ścieżek `apps/web/...`, które już nie istnieją) | S |
| 7 | Dodać skip-linki i przegląd nawigacji klawiaturowej poza `@dnd-kit` | S |
| 8 | Potwierdzić/włączyć branch protection i wymagane checki na `master` (zgłoszone jako brak w audycie 2026-08-24) | S |
| 9 | Prowadzić jeden „żywy" dokument statusu kryteriów cutover (spec 21) — dziś odpowiedź na pytanie „czy jesteśmy gotowi produkcyjnie" jest rozproszona po kilkunastu audytach z różnymi werdyktami | S, ale wymaga dyscypliny utrzymania |

---

## 5. Co warto świadomie zachować (nie psuć przy refaktoryzacji)

- Zerowe `any`/`as any`, zdyscyplinowany strict TypeScript.
- Zero `TODO`/`FIXME`/`HACK` w źródłach — dług jest śledzony, nie zostawiany w kodzie.
- W pełni własny, czysty kernel (`EventBus`, `CommandRegistry`, `SelectionController`) bez zależności od zewnętrznych bibliotek stanu.
- Działający, egzekwowany `check-architecture-hygiene.mjs` — rzadkość na tę skalę, fundament pod dalszą refaktoryzację.
- Bardzo wysoka gęstość testów (640 plików testowych, ~73% względem produkcyjnych).
- Dojrzały, trzywarstwowy system tokenów CSS (Catppuccin, `@theme inline`) — problemem jest egzekwowanie, nie projekt.
- Zero `console.log` w kodzie produkcyjnym.
- Realna infrastruktura profilowania wydajności (`kernel/performance`) i deterministyczny gate generowanego API OpenAPI.

---

## Źródła

Audyt własny (kod, konfiguracja CI, style) + synteza dokumentów wewnętrznych: `docs/adr/0013-frontend-v2-module-kernel.md`, `docs/adr/0015-frontend-v2-migration-governance-boundary.md`, `docs/specs/frontend-v2/00…22`, `docs/plans/completed/frontend-architecture.md`, `docs/architecture/control-room-frontend-audit-2026-05-30.md`, `docs/audits/2026-08-04-fdm-ui-audit.md`, `docs/audits/2026-08-05-fem-fdm-frontend-full-audit.md`, `docs/audits/2026-08-20-frontend-3d-visualization-fem-fdm-audit-addendum.md`, `docs/audits/2026-08-24-scratch-simulation-authoring-frontend-audit.md`, `docs/audits/2026-09-01-results-mode-sweep-ui-audit-and-refactor-plan.md`, `docs/reviews/frontnend/Fullmag_Audyt_Wizualizacji_3D_FEM_FDM_2026-08-24.md`, `docs/diagnostics/control-room-frontend-error-audit-2026-06-30.md`, `docs/diagnostics/control-room-frontend-3d-architecture-diagnostic-2026-06-24.md`, `docs/performance/fem-gpu-performance-remediation-2026-09-01/`.
