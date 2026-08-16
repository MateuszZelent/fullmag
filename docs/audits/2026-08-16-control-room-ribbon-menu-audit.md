# Audyt frontendu: główna belka menu + ribbon (apps/control-room)

Data: 2026-08-16
Zakres: `apps/control-room` — powierzchnia „main menu / ribbon":
`src/modules/ribbon/` (~20,7 tys. linii łącznie z testami), `src/kernel/layout/`
(AppMenuBar, WorkspaceShell, dock layout, dialogi), powiązane style w
`src/design/styles/{ribbon,header,dropdown}.css` i system tokenów `--fm-*`.

Metoda: lektura kodu renderującego + skany statyczne (Tailwind/kolory/any/fetch/console)
+ uruchomione bramy: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run` (pełny suite oraz
skierowany na `src/modules/ribbon src/kernel/layout`), `eslint` wyłącznie dla ribbon+layout.

Stan worktree: **brudny** (WIP planar monitor + field-map + resources, w tym zmodyfikowany
`openapi-v2-types.ts` +859 wierszy). Wyniki bram są interpretowane z uwzględnieniem tego
faktu; żadna zmiana nie została przez audyt dotknięta.

---

## 1. Stan bram weryfikacyjnych (dowody)

| Brama | Wynik | Przyczyna (klasyfikacja) |
|---|---|---|
| `pnpm typecheck` | **RED** — 7 błędów TS | Całość w drifcie WIP: `active_monitor_id` (patrz klasa B) |
| `pnpm lint` (aplikacja) | **RED** — 1241 err / 4048 warn | Głównie 51 porzuconych katalogów `.next-audit-*` (patrz P1-1) |
| `pnpm lint` → `eslint src/modules/ribbon src/kernel/layout` | **GREEN — 0 problemów** | — |
| `pnpm vitest run src/modules/ribbon src/kernel/layout` (21 plików, 213 testów) | 197 pass / **16 fail (4 pliki, wszystkie w `kernel/layout`)** | Klasa A (dwie kopie React) |
| `pnpm vitest run` (pełny suite, 567 plików) | 550 plików pass / 16 fail, 77 testów fail | Klasy A, B, C |
| `smoke-transport-authoring-ui-cdp` poza sandboxem | **PASS 5/5** | Błędy w sandboxie to artefakt `EPERM` na bind 127.0.0.1 |

### Klasyfikacja porażek testów

**Klasa A — dublowanie instancji React (19.1.0 vs 19.2.4), błędy „Invalid hook call".**
`apps/legacy_web` pinuje `react@19.1.0`, `apps/control-room` pinuje `react@19.2.4`;
w store pnpm istnieją więc dwie instancje React i — co decydujące — buildy pakietów
`@radix-ui/*` rozstrzygnięte przeciwko peerowi `react@19.1.0`. Testy control-roomu
łapią te buildy (stacki wskazują `react@19.1.0/cjs/react.development.js` przy
rendererze `react-dom@19.2.4`):

- `kernel/layout/AppMenuBarRender.test.tsx` — 1 fail (`DropdownMenu` → `useScope`)
- `kernel/layout/SimulationPreparationMounted.test.tsx` — 8 fail
- `kernel/layout/SimulationStartupOverlay.test.tsx` — 6 fail
- `kernel/layout/ViewportTabHost.test.tsx` — 1 fail
- `inspector/panels/CrossSectionDraftEditor.test.tsx` — 1 fail (`Tabs` → `useDirection`)
- pliki `modules/analysis-plots/*` — większość pozostałych fail pełnego suite

Powtarzalne lokalnie; stan lockfile'u jest committed (lockfile nie jest brudny), więc
porażki są najpewniej pre-existing względem HEAD — do potwierdzenia na czystym worktree.

**Klasa B — drift niezaangażowanego WIP (planar monitor).**
Na dysku (niezaangażowany) `src/kernel/api/generated/openapi-v2-types.ts` **usuwa**
`active_monitor_id` (0 wystąpień vs 2 w wersji committed), a 6 committed plików nadal
używa tego pola. Skutki:

- 7 błędów `pnpm typecheck` (`planarPresentationProjection.test.ts`,
  `planarVisualizationProfile.test.ts`, `useVisualizationStateResource.test.tsx`,
  `CrossSectionDraftEditor.tsx`, `PlanarMonitorDraftInspectorPanel.tsx`,
  `PlanarVisualizationSection.tsx`)
- 6 fail `ObjectVisualizationPanel.route.test.tsx` (`visualizationSync.getSnapshot is
  not a function` — zmienione na dysku `ObjectVisualizationController.ts`)
- fail `CrossSectionInspectorPanel`, `PlanarVisualizationSection`, `ScopedMeshQualityPanels`
- 2 jedynego „prawdziwe" błędy lint w `src/` (react-compiler: memoizacja `source`
  z depem `[planar?.source]` vs inferowany `planar.source.monitor_id`) w
  `FieldMapModule.tsx:60` i `PlanarVisualizationSection.tsx:105` — oba w plikach WIP

**Klasa C — artefakt sandboxu.** `smoke-transport-authoring-ui-cdp` (2 fail, `EPERM`
na `listen 127.0.0.1`) przechodzi 5/5 poza sandboxem.

**Ribbon: wszystkie 12 plików testowych `src/modules/ribbon/*` przechodzi (100%).**

---

## 2. Znalezione problemy (kod ribbon/menu)

### P1

**P1-1. Bramę lint-a zasłania 2,1 GB porzuconych katalogów smoke-build.**
W `apps/control-room/` leży **51 katalogów `.next-audit-*`** (łącznie **2,1 GB**;
np. `.next-audit-target-smoke-1253103-*`, `.next-audit-spin-authoring-20260809`),
a `eslint.config.mjs` ignoruje tylko `.next/**` i `.next-audit/**`. Konsekwencja:
1239 z 1241 błędów i 4045 z 4048 warningów pochodzi ze zgenerowanego JS
w tych katalogach (polyfills.js, wygenerowane typy route), trwała czerwień bramy i utopiony sygnał
prawdziwych błędów.
Fix: rozszerzyć `globalIgnores` o `.next-audit-*` (i ewentualnie sprzątnąć katalogi,
po uzgodnieniu z właścicielem WIP) — po fixie jedynymi błędami src zostają 2 z klasy B.

**P1-2. Dwie instancje React w monorepo łamią testy powierzchni menu/layout.**
Zob. klasa A. Fix: wpiąć `apps/legacy_web` na `react@19.2.4` (albo `pnpm.overrides`
na wspólną wersję) i przejechąć suite; zweryfikować też, czy bundler produkcyjny
kontrolki (Next) nie miesza buildów radix (kontrolka ma własne piny 19.2.4 — ryzyko
produkcji nisko, ryzyko testów pewne).

### P2

**P2-1. Niekompletny wzorzec ARIA tab (tabstrip ribbon → panel grup).**
`RibbonTabStrip.tsx:47` definiuje `role="tablist"`, przyciski mają `role="tab"`
(`:56`) i `aria-selected`, ale **brak `id` na tabach i `aria-controls`**, a
`RibbonGroupsRow.tsx:292` renderuje `role="tabpanel"` **bez `aria-labelledby`**
wskazującego aktywny tab. Odczyt przez screen reader nie łączy panelu z zakładką.
Fix: `id={`fm-ribbon-tab-${tab.id}`}` + `aria-controls="fm-ribbon-tabpanel"`,
a panel: `aria-labelledby` do aktywnego taba.

**P2-2. Dialog błędu API otwiera się na hover/focus wskaźnika sesji.**
`AppMenuBar.tsx:548-549`: `onFocus={openApiDialog}` i `onPointerEnter={openApiDialog}`
na przycisku `.fm-header__session-indicator`. Gdy sesja ma błąd API, samo najechanie
myszą (lub dostarczenie fokusa klawiaturą) otwiera **modalny dialog z focus trapem** —
nieoczekiwane zachowanie blokujące dalszą pracę. Dialog ma się otwierać wyłącznie
na aktywnym geście (click/Enter); `aria-haspopup`/`aria-expanded` zostają.

**P2-3. `AppMenuBar` tworzy `commandContext` i kallbacki przy każdym renderze.**
`AppMenuBar.tsx:428` — `createCommandContext("menu", ...)` bez `useMemo`, plus
`runCommand`/`isCommandDisabled`/`isCommandActive` bez `useCallback`. Pask menu
re-renderuje się przy każdej zmianie statusu sesji; `RibbonModule.tsx` robi to
wzorcowo (`useMemo` z pełnym dependency array) — warto przenieść ten wzorzec.

**P2-4. Dwa równoległe systemy aliasów kolorów ikon; warstwa danych mówi „językiem Tailwinda".**
`RibbonGroupsRow.tsx:19` — `ICON_COLOR_ALIASES`: 21 nazw palety Tailwind
(`text-emerald-400` itd.) → 8 tokenów `--fm-*`; `ribbonCommon.tsx` — drugie `C`
(10 aliasów). Pliki danych (`ribbonContributions.tsx`, `ribbonTabViews.tsx`) używają
~40 łańcuchów `text-*-300/400`. Konsekwencje: (a) semantyka koloru żyje w słowniku
palety, nie w tokenach; (b) `resolveRibbonIconColor` dla nieznanej nazwy **cicho
zwraca `undefined`** (fallback bez sygnału); (c) dwa źródła prawdy.
Fix: jeden typ `iconTone: "success"|"warning"|"danger"|"accent"|"stale"|"degraded"|"muted"|"info"`
+ jedna mapa tone→`--fm-*` + test, że każda wartość w danych jest znanym tone.

### P3 (obserwacje)

- **P3-1.** `ribbonContributions.tsx` = **3737 linii**: dane tabów + buildery
  zależne od zasobów + logika stanu poleceń (`applyCommandState`, `isCommandDisabled`)
  + eksporty testowe. Zgodnie z regułą repo (limit rozmiaru = trigger przeglądu),
  jest tu realna mieszona odpowiedzialność; kandydat do podziału na
  `data/` (statyczne taby), `builders/` (dynamiczne) i `commandState.ts`.
- **P3-2.** `ribbonStructure.test.ts` = **4939 linii** — monolityczny test
  strukturalny (96 describe/it). Rozważyć podział per tab.
- **P3-3.** `ribbon.css:162,180,363,435` — `font-size: 8px/9px` dla podpisów grup
  (8px pod `@media (max-width: 1400px)`). Poniżej progu komfortowej czytelności;
  rozważyć minimum 10px.
- **P3-4.** `RibbonModule.tsx:351` — `void commandVersion;` w `useMemo` jako sygnał
  zależności (subskrypcja wersji rejestru poleceń). Działa, ale warto dodać komentarz
  lub jawną nazwę zmiennej zależnej.
- **P3-5.** `appMenuModel.tsx` — `HIDDEN_PLACEHOLDER_COMMAND_IDS` (16 ukrytych
  placeholderów menu) — pułapka konserwacyjna; pozycje „ukryte" powinny albo
  zniknąć z modelu, albo mieć jawną flagę `planned: true`.
- **P3-6.** `AppMenuBar.tsx:534` — pole `readOnly` jako spust palety poleceń
  (focus otwiera paletę i blur-uje input). Działa, ale dla SR ogłaszane jako pole
  tekstowe; `role="button"`/`aria-expanded` byłyby uczciwszym kontraktem.
- **P3-7.** `AppMenuBar.tsx:77-85` — ręczna brama hydratacji przez
  `useSyncExternalStore` z no-op subskrypcją (server=false/client=true). Wzorzec
  zgodny z regułą repo (first client render = SSR), lecz niekonwencjonalny —
  kandydat do wspólnego hooka `useHydrated()`.
- `reactStrictMode: false` w `next.config.ts:52` — **udokumentowana wyjątkowość**
  (AGENTS.md: R3F/Three w dev force-lose'uje WebGL) — nie jest błędem.

---

## 3. Mocne strony (potwierdzone w kodzie)

- **Zero Tailwinda w DOM ribbon/menu**: wszystkie klasy to `fm-*` (BEM); 0
  wystąpień utility-class w `className` w audytowanych ścieżkach. Tailwind pełni
  rolę warstwy utility + mostu `@theme inline` bez kopii palet (egzekwowane
  przez `designStyles.test.ts`).
- **Token-first CSS**: `ribbon.css`/`header.css` — 96/98 użyc `var(--fm-*)`,
  **zero surowych hex/rgba**; tone'y grup przez `color-mix()` na tokenach.
- **Brak antywzorów w audytowanej powierzchni**: 0 `any`, 0 `console.*`, 0 `fetch()`
  (centralny klient API), 2 style inline (tylko zmienne CSS `--fm-ribbon-icon-color`,
  `--pct`).
- **Shadcn/ui-style primitives** dla menu, dialogów, dropdownów, resizable/sortable
  docków — zgodne z inwariansem frontendu.
- **Polityka ładowania zasobów per tab** (`ribbonResourcePolicy.ts`) + selektory
  z custom `isEqual` (`ribbonRuntimeStatusEquals`, `headerSessionSourceEquals`) —
  świadome ograniczanie re-renderów; `WorkspaceRenderProfiler` na module i docku.
- **Klawiatura tabstripu**: strzałki/Home/End + roving `tabIndex`
  (`RibbonTabStrip.tsx:18-44`).
- **Testy**: ~5,3 tys. linii testów ribbon (12 plików, 100% pass), testy struktury
  HTML przez `renderToStaticMarkup`, testy ARIA nagłówka, testy wydajności
  (`useLayout.performance.test.ts`, `RibbonMenuRenderer.performance.test.ts`).
- `RibbonModule` — wzorcowe memoizowanie contextu i contentu taba z pełnymi
  dependency array.

---

## 4. Rekomendacje (kolejność)

1. **P1-1** (5 min): `.next-audit-*` do `globalIgnores` + decyzja o sprzątaniu 2,1 GB
   artefaktów. Brama lint wraca do pomiaru prawdziwych problemów.
2. **P1-2**: ujednolicić React na 19.2.4 (legacy_web/overrides) → zielone suite w
   obszarze menu/layout (16 fail).
3. **Klasa B**: dokończyć WIP planar (dodać z powrotem `active_monitor_id` do
   wygenerowanych typów albo zaktualizować 6 plików) — przywraca typecheck i ~14 fail.
4. **P2-1/P2-2**: ARIA tab + dialog na aktywny gest (małe, czyste diffy).
5. **P2-4**: scentralizować tone'y kolorów ikon (usuwa 40 łańcuchów palety z danych).
6. **P2-3**: memoizacja w `AppMenuBar` (wzorzec z `RibbonModule`).
7. P3 — do kolejnych iteracji (podział `ribbonContributions.tsx`, font 10px itd.).

## 5. Komendy odtwarzające

```bash
cd apps/control-room
pnpm typecheck                                   # RED: klasa B (WIP planar)
pnpm lint                                        # RED: P1-1 (junk dirs) + 2 błędy src (klasa B)
pnpm exec eslint src/modules/ribbon src/kernel/layout   # GREEN (0 problemów)
pnpm vitest run src/modules/ribbon src/kernel/layout    # 197 pass / 16 fail (klasa A)
pnpm vitest run scripts/smoke-transport-authoring-ui-cdp.test.mjs  # PASS 5/5 poza sandboxem
```

Dowody pośrednie: logi w `/tmp/audit-{typecheck,lint,ribbon-tests}.log`
(bieżąca sesja), `git status --short` (brudny WIP), `pnpm why react`
(peery 19.2.4 w kontrolce; `apps/legacy_web` = 19.1.0).
