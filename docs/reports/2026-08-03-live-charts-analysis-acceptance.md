# Live Charts / Analysis — raport akceptacyjny

Data: 2026-08-03  
Zakres: refaktoryzacja powierzchni wykresów w `apps/control-room` zgodnie z
[planem](../superpowers/plans/2026-08-02-live-charts-analysis-separation.md)
i ADR-em `docs/adr/0022-live-charts-analysis-boundary.md`.

## Wynik

Refaktoryzacja jest zrealizowana. Workspace ma trzy rozdzielone powierzchnie:

- `Live Charts` (`live-charts`) — tylko historie czasu podążające za aktywnym
  przebiegiem;
- `Analysis` (`analysis-plots`) — analiza jawnie wybranego datasetu lub artefaktu:
  Dynamics, Spectrum, Frequency Response, Eigenmodes, Dispersion, Hysteresis i
  Comparison;
- `Quick Chart` (`transport-footer`) — niezależny wykres w dolnym docku, bez
  własnego store modułu i bez ingerencji w viewport 3D.

Moduły nie importują wzajemnie swoich store'ów. Dane pozostają w zasobach API v2,
a zdarzenia realtime jedynie unieważniają zasoby. Nie dodano pollingu ani nowych
endpointów.

## Potwierdzone poprawki

- Wartości bezwymiarowe nie są już automatycznie przeliczane na prefiksy SI:
  `mx = 0.97982`, `my = 0.10317`, `mz = 4.4470e-6` pozostają tymi samymi
  wartościami w legendzie, tooltipie i eksporcie. Oś ma nazwę `Normalized
  magnetization m`; nie pojawiają się `m1`, `u1`, `µ1` ani podobne jednostki.
- Widoczność serii ma jednego właściciela (`selectedSeriesIds`). Przetestowano
  wszystkie 8 kombinacji `mx/my/mz`, w tym stan z zerem zaznaczonych serii.
- Podczas odświeżania zachowany jest poprzedni canvas, legenda i układ; overlay
  ładowania dotyczy wyłącznie pierwszego ładowania bez danych.
- Jawnie wybrany dataset w `Analysis` nie odświeża się samoczynnie od aktywnego
  przebiegu. Fixture potwierdził dataset `analysis-fixture`, revision `17`, 256
  wierszy i zero nieoczekiwanych żądań `rows.bin` w stanie idle.
- Zamknięcie Quick Chart zwalnia instancję ECharts, obserwery, listenery, URL-e
  obiektów i workery; powrót do 3D nie traci kontekstu WebGL ani kamery.
- Żądania zasobów są coalescowane i anulowane przy zmianie źródła. Dowód abortu:
  source revision `17`, latest revision `18`, `requested=true`,
  `adoptedAfterAbort=false`, brak widocznych wartości z rewizji nieaktualnej.

## Dowody uruchomieniowe

Wszystkie poniższe testy browserowe wykonano na produkcyjnym buildzie z pełnym
commitem `d60ca26d2b5f0a8edae072fc67a1a8b2f0022883`.

| Dowód | Wynik |
| --- | --- |
| `pnpm --dir apps/control-room build` | PASS — Next.js 16.2.6, kompilacja, TypeScript i strony statyczne |
| `audit:chart-performance` — 100 przełączeń Analysis | PASS — utworzono 105 / zwolniono 104 / aktywna 1 instancja ECharts; brak wycieku po zamknięciu |
| `audit:chart-performance` — 100 cykli Quick Chart | PASS — szczyt 1 canvas ECharts; po zamknięciu 0 |
| `audit:chart-performance` — idle | PASS — 0 żądań, 0 callbacków `requestAnimationFrame`, 0 live redraws |
| `smoke:live-charts` | PASS — dokładne wartości, 8 kombinacji widoczności, canvas zachowany, 0 błędów odpowiedzi |
| `smoke:analysis-plots` | PASS — jawny dataset/revision, canvas 589×326, 256 wierszy, 0 błędów i 0 `rows.bin` w obserwacji |
| `smoke:analysis-quick-chart` | PASS — WebGL `contextLost=false`, bufor 617×556, 0 żądań pól, 0 dirty frames |
| `smoke:viewport-3d` | PASS — WebGL `contextLost=false`, bufor 617×478; gesty kamery bez patchy stanu wizualizacji i bez żądań danych |
| `audit:idle-performance` | PASS |

W audycie chartów wystąpiło dokładnie jedno kontrolowane `404` dla
`/v2/sessions/current/simulation/preparation`; jest to oczekiwany brak zasobu w
fixture smoke i nie jest błędem wykresów.

Screenshoty akceptacyjne są w:
`apps/control-room/.fullmag/reports/live-charts-analysis-acceptance/`.

## Testy kodu i znane granice

- Skupiony pakiet wykresów: 20/20 testów kontraktowych oraz 94 testy modułowe —
  PASS.
- Pełny Vitest: 4 275 testów PASS, 1 skipped; pozostał jeden wcześniejszy,
  niezwiązany z tą zmianą test `VisualizationDebugPanel.dom.test.tsx` w
  niezmienionym pliku (oczekuje starego komunikatu `Health is unknown...`).
- Lint plików objętych zmianą — PASS. Pełny lint zachowuje cztery wcześniejsze
  problemy w niezmienionych plikach (`ExplorerModule.tsx`, `BoundsLayers.tsx`).
- React Doctor: 75/100; pozostałe ostrzeżenie jest fałszywym alarmem dla
  `EChartsSurface.tsx`, gdzie efekt zwraca poprawny unsubscribe z `EventBus.on()`.
- Wbudowany bridge przeglądarki Codex zatrzymał się przed załadowaniem strony z
  błędem środowiskowym `sandboxCwd is not a local file URI`. Dowód UI wykonano
  niezależnym Playwright smoke na tym samym buildzie.

## Granica kwalifikacji

To jest kwalifikacja kontraktu UI, zasobów v2, cyklu życia wykresów i zachowania
przeglądarki na fixture'ach. Nie jest to kwalifikacja dokładności solvera ani
walidacja naukowa danych produkcyjnego przebiegu. Zmiana nie modyfikuje równań,
DSL Python ani `ProblemIR`. Branch nie został wypchnięty do zdalnego repozytorium.

## Uzupełnienie: Inspector i pusty wykres

W kolejnym przebiegu naprawiono dwa regresyjne zachowania zgłoszone dla `Live Charts`:

- wejście do modułu ustawia selekcję `live.chart`, otwiera prawy dock i skupia
  `panel-right`, więc Inspector pojawia się bez wcześniejszego kliknięcia legendy;
- Inspector pokazuje preset, tryb podążania, okno danych oraz checkboxy sygnałów;
  zmiany przechodzą przez zarejestrowane komendy kernela;
- zapisane aliasy i nieaktualne identyfikatory serii są mapowane na bieżące
  identyfikatory zasobu. Niepusta, całkowicie nieaktualna selekcja wraca do
  domyślnych serii presetu, natomiast jawne `[]` pozostaje stanem „Select at
  least one signal”;
- brak serii podczas pierwszego ładowania ma jawny komunikat (`Loading live
  samples`/`No live samples`), a nie pustą powierzchnię.

Dowody tej poprawki:

| Dowód | Wynik |
| --- | --- |
| focused Vitest: Live Charts, resolver, Inspector, registry | PASS — 23/23 testy |
| resource integration + smoke contract | PASS — 12/12 testów |
| `pnpm --dir apps/control-room typecheck` | PASS |
| `pnpm --dir apps/control-room lint` | PASS |
| bezpośredni headless Playwright na lokalnym workspace | PASS — po wejściu w `Live Charts` Inspector zawiera `Live Chart`, `Display`, `Signals`, `mx`, `my`, `mz`; brak danych pokazuje `No live samples` |
| pełny `smoke:live-charts` z fixture na buildzie webpack | PASS — produkcyjny build, Inspector przed interakcjami, `mx=0.97982`, `my=0.10317`, `mz=4.4470e-6`, canvas `591×326`, 8 kombinacji widoczności, 0 błędnych odpowiedzi |

Artefakty tego przebiegu zapisano w:
`apps/control-room/.fullmag/reports/live-charts-analysis-acceptance/live-charts-2026-08-03T16-37-26-254Z/`.
Wcześniejsze timeouty na współdzielonym dev serverze były wyłącznie blokadą
środowiskową; nie występują na zweryfikowanym buildzie produkcyjnym.
