# Audyt frontendu dyspersji i eigenmodes

Data: 2026-09-19
Checkout: `codex/eigensolve-dispersion-plan-20260912`
HEAD audytu: `a7723cf0b3dd179f32da5294dbda8dcd685b6e14`

## Zakres i dowody

Audyt obejmuje wyłącznie `apps/control-room` oraz kontrakt, który ten frontend
zużywa dla manifestu frequency-domain, `eigen/dispersion.csv`,
`eigen/branches.v2.json` i `path_metadata`. Przejrzane zostały w szczególności:

- `src/shared/domain/analysis/frequencyDomainChartModels.ts` — routing trybów,
  parser CSV, identyfikacja branchy, jednostki osi i referencja analityczna;
- `src/modules/analysis-plots/hooks/useAnalysisFrequencyData.ts` — wybór
  zasobu przez manifest i blokada nieopublikowanego trybu;
- `src/shared/analysis-charts/frequencyRenderModels.ts` oraz
  `src/modules/inspector/panels/FrequencyDomainCharts.tsx` — model renderera i
  interakcja z wykresem;
- `src/modules/inspector/panels/frequency-domain/EigenDispersionInspector*`
  — inspektor punktu i podsumowanie DE/BV;
- istniejące testy modeli, hooka, inspektora i renderera;
- `docs/specs/frequency-domain-artifacts-v2.md`, sekcja „Frontend contract”.

Weryfikacja była statyczna na aktualnym checkoutcie. Nie uruchamiałem managed
runnera, buildu native ani przeglądarki/WebGL; dlatego dowód renderowania UI w
przeglądarce pozostaje `NOT VERIFIED`.

## Ustalenia

### F1 — tryb obliczeń był utożsamiany tylko z rodziną wykresu (P1, błąd)

`frequencyDomainManifestSupportsChartRoute` porównywał dla każdej trasy innej
niż comparison wyłącznie `primaryChart` (`frequencyDomainChartModels.ts:688-695`),
a dla comparison sprawdzał artefakty bez zgodności `publishedRoute.mode`.
W rezultacie manifest `free_modes` mógł zostać uznany za opublikowany dla trasy
`fmr_modal`, ponieważ oba tryby używają `modal-spectrum`. Analogicznie
`frequency_response` mógł zostać uznany za `fmr_response`, ponieważ oba tryby
używają `response-sweep`. Hook `useAnalysisFrequencyData.ts:135-143` używa tego
wyniku do odblokowania zasobu i widoku, więc interfejs mógł nadać wynikowi
fizycznie mocniejszą etykietę FMR niż wynikało z manifestu.

To narusza zasadę, że requested calculation mode i resolved/published mode są
częścią provenance i nie mogą być zastępowane samą rodziną wykresu.

### F2 — referencja analityczna była budowana, ale specjalizowany wykres ją
odrzucał (P1, błąd)

`buildEigenDispersionChartModel` poprawnie tworzy serię numeryczną oraz serię
`analytic_frequency` z tym samym `path_s` i przeskalowaną częstotliwością
(`frequencyDomainChartModels.ts:932-1005`). Jednak
`frequencySeriesRenderModel` wywołuje `compatibleFrequencySeries`, które
akceptuje tylko serie o tym samym `quantity` (`frequencyRenderModels.ts:73-125`).
`frequency` i `analytic_frequency` są więc filtrowane do samej serii
numerycznej w `FrequencyDomainDispersionChart`.

Skutek: inspektor i jego wykres nie pokazywały porównania z analityką, mimo że
CSV i model ją zawierały. To bezpośrednio łamie kontrakt v2 wymagający
analitycznej nakładki na wspólnej osi `path_s` oraz kompaktowego podsumowania
DE/BV. Podsumowanie w `EigenDispersionInspectorModel` już zachowuje geometrie i
maxymalny błąd; brakowało tylko przejścia serii do renderera.

### F3 — parser CSV jest celowo wąski, ale nie jest obecnie potwierdzonym
błędem kontraktu (P2, ryzyko)

Parser używa prostego podziału po przecinku. Nie obsługuje cytowanych pól CSV,
np. etykiety zawierającej przecinek. Aktualny writer runnera publikuje jednak
kanoniczne etykiety bez takiego escapowania, a kontrakt endpointu waliduje
`path_metadata` i zgodność próbek przed ekspozycją do UI. Nie zmieniam tego w
zakresie frontendu; ewentualna zmiana musi być wspólna z writerem i jego
walidatorem, aby nie wprowadzić dwóch różnych dialektów CSV.

### F4 — jednostki, brak danych i identyfikacja punktu są poprawne

Potwierdzone pozytywnie:

- oś X używa `path_s_rad_per_m`/`path_s` i jest oznaczona `rad/m`;
- puste komórki opcjonalne stają się `null`, a nie zerem;
- wiersze bez skończonej częstotliwości, `path_s` albo bez nieujemnych,
  bezpiecznych indeksów są odrzucane;
- branch identity jest dołączane po `(sample_index, raw_mode_index)`;
- etykiety punktów wysokiej symetrii są odtwarzane z CSV lub typed
  `path_metadata`;
- kliknięcie zachowuje `rowIndex`, branch/sample/mode oraz kompletny wektor
  `kx,ky,kz`, jeżeli opublikował go CSV;
- inspektor zachowuje linewidth, residual, overlap, geometrię walidacji,
  analityczny max relative error i intent walidacji manifestu.

## Plan naprawy

1. Porównywać dokładny `requestedRoute.mode` z trybem rozwiązanym przez
   manifest dla wszystkich tras, w tym modal-driven comparison; dodać regresje
   dla `free_modes` vs `fmr_modal`, `frequency_response` vs `fmr_response` oraz
   nieuprawnionego comparison.
2. Dopuścić wyłącznie parę `frequency` + `analytic_frequency` do wspólnego
   renderera, zachowując dotychczasową blokadę niezgodnych jednostek/quantities
   dla innych wykresów; dodać test render-modelu dowodzący obecności obu serii.
3. Po poprawkach uruchomić wyłącznie skupione testy Vitest modeli/renderera oraz
   `git diff --check`. Browser/WebGL proof i pełna kwalifikacja runtime pozostają
   osobną bramką.

## Wykonane poprawki i weryfikacja

F1 naprawiono w `frequencyDomainChartModels.ts`: trasa jest teraz uznana za
opublikowaną tylko wtedy, gdy zgadza się zarówno dokładny `mode`, jak i
`primaryChart`, także dla modal-driven comparison. Dodano regresje dla par
`free_modes`/`fmr_modal`, `frequency_response`/`fmr_response` oraz comparison.

F2 naprawiono w `frequencyRenderModels.ts`: zachowana została dotychczasowa
blokada serii o różnych jednostkach, a jedynym dodatkowym dozwolonym zestawem
jest para `frequency` + `analytic_frequency` dla wspólnej osi dyspersji. Dzięki
temu wyspecjalizowany wykres inspektora rysuje serię numeryczną i analityczną.

Uruchomione lekkie bramki frontendowe:

- `frequencyDomainChartModels.test.ts` i `frequencyRenderModels.test.ts` —
  2 pliki, 52 testy, wszystkie zielone;
- `EigenDispersionInspectorPanel.test.tsx`,
  `AnalysisFrequencySurface.test.tsx` i
  `useAnalysisFrequencyData.mismatch.test.tsx` — 3 pliki, 13 testów, wszystkie
  zielone;
- `pnpm --dir apps/control-room typecheck` — zakończone kodem 0;
- `git diff --check` — bez błędów.

Nie uruchamiałem managed runnera, buildu native ani przeglądarki/WebGL.
Frontendowy browser proof, rzeczywisty runtime API oraz naukowa kwalifikacja
solvera pozostają `NOT VERIFIED` i wymagają osobnej bramki. F3 pozostaje
udokumentowanym ryzykiem kontraktu CSV poza zakresem tej lokalnej poprawki.
