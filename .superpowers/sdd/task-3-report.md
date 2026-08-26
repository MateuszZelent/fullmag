# Task 3 — końcowa weryfikacja modala diagnostycznego

## Focused test suite

Polecenie:

```text
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/simulationPreparationDiagnostics.test.ts src/kernel/layout/simulationPreparationModel.test.ts src/kernel/layout/SimulationPreparationMounted.test.tsx
```

Wynik: exit 0; 3 pliki i 43/43 testy przeszły.

## Typecheck i integralność diffu

Polecenia:

```text
pnpm --dir apps/control-room typecheck
node --check apps/control-room/scripts/smoke-simulation-preparation.mjs
git diff --check
```

Wynik: wszystkie exit 0; typy tras wygenerowano bez błędów.

## React Doctor

Polecenie:

```text
npx react-doctor@latest --verbose --scope changed
```

Pierwsza próba w sandboxie nie uzyskała DNS do npm (`EAI_AGAIN`). Powtórzenie z zatwierdzonym dostępem sieciowym zakończyło się exit 0: 8 zmienionych plików, wynik 100/100, brak problemów.

## Browser smoke

Istniejący `apps/control-room/scripts/smoke-simulation-preparation.mjs` otrzymał ukierunkowany tryb:

```text
CONTROL_ROOM_SIMULATION_PREPARATION_FAILURE_ONLY=1
```

Tryb używa prawdziwego `/workspace`, Radix Dialog, kanonicznego `GET /v2/sessions`, zasobu statusu oraz początkowego zasobu HTTP `GET /v2/sessions/current/simulation/preparation`. Trasa WebSocket jest jedynie skonfigurowana; narrow lane nie wysyła, nie czeka na ani nie weryfikuje invalidacji WebSocket. Nie montuje niepowiązanych zasobów viewportu po stanie ready.

Polecenie:

```text
env TMPDIR=/tmp CONTROL_ROOM_URL=http://127.0.0.1:3107/workspace CONTROL_ROOM_SIMULATION_PREPARATION_FAILURE_ONLY=1 pnpm --dir apps/control-room smoke:simulation-preparation
```

Wynik: exit 0. Potwierdzone asercje:

- failure-dialog-auto-open;
- known-predicate-action dla `gpu_dmi_kernel_not_mixed_p1`;
- full-report-collapsed;
- full-report-expanded;
- copy-full-report;
- viewport-blocked;
- dialog-geometry-in-viewport;
- dialog-focus-trapped;
- dialog-reduced-motion-stable;
- network-failures-none;
- console-errors-none;
- page-errors-none;
- http-errors-none.

Dowody wizualne:

- `.superpowers/sdd/evidence/simulation-preparation-failure-collapsed.png`
- `.superpowers/sdd/evidence/simulation-preparation-failure-expanded.png`

Ręczna kontrola screenshotów potwierdziła: modal mieści się w viewport 1440x900, zwinięty raport nie wypiera stopki, rozwinięty raport ma własny scroll, a stopka pozostaje widoczna. Te własności są dodatkowo objęte automatycznymi pomiarami geometrii i fokusu opisanymi poniżej.

## Diagnostyka starego broad smoke

Pełny historyczny przebieg najpierw ujawnił brak fixture `GET /v2/sessions`, a po jego dodaniu dotarł do nieaktualnego oczekiwania na dwa zasoby po stanie ready. Zamiast poszerzać ten modalowy gate o kilkadziesiąt niepowiązanych zasobów workspace dodano failure-only lane. Ograniczony zrzut stanu przy błędzie pozostaje w skrypcie, aby kolejne drifty raportowały body, requesty i błędy zamiast kończyć się samym timeoutem.

## Granica API

Zmiana produkcyjna jest frontend-only. Nie zmieniono OpenAPI v2, wygenerowanych typów/transportu, API facade, hooków ani codeców. HTTP v2 pozostaje źródłem prawdy; WebSocket przenosi tylko zdarzenie/invalidation. Komponent nie wykonuje bezpośredniego `fetch()` i nie tworzy ścieżek endpointów.

## Fix po review — dowody

### Bounded diagnostics

`consoleErrors`, `failedResponses`, `networkFailures` i `pageErrors` są teraz
ograniczane przy zapisie do 12 wpisów. Teksty mają limit 400 znaków, URL-e 600
znaków, a body zrzutu 2 000 znaków; każdy collector raportuje liczbę `dropped`.
Oba bloki `catch` wywołują wspólny `boundedFailureSnapshot`, więc nie mogą
serializować nieograniczonych tablic. W narrow lane `networkFailures` jest
asertywnie puste, podobnie jak pozostałe trzy klasy błędów.

TDD: przed implementacją uruchomiono celowy kontrakt
`CONTROL_ROOM_SIMULATION_PREPARATION_ASSERT_BOUNDS=1 node apps/control-room/scripts/smoke-simulation-preparation.mjs`.
Zakończył się oczekiwanym RED: `Diagnostic collector did not retain a fixed
number of entries.` Po dodaniu limitu, obcinania i licznika wynik to exit 0:
`bounded-diagnostic-collector-contract`.

### Dialog, fokus i reduced motion

Po rozwinięciu raportu smoke mierzy `boundingBox()` dialogu i wszystkich
przycisków stopki względem viewportu 1440×900. Sprawdza, że
`document.activeElement` pozostaje wewnątrz dialogu po auto-open, kliknięciu
`summary` oraz kopiowaniu. Dla failure dialog `reducedMotion: "reduce"` jest
włączane przed auto-open, sprawdzane są stabilna geometria i fokus, po czym
ustawienie jest przywracane do `no-preference`. Te same pomocniki są użyte w
zachowanym broad lane; jego semantyka connecting/planning/meshing/reconnect/
ready/failure i revision-only invalidation nie została zawężona.

Świeży narrow smoke po fixie:

```text
TMPDIR=/tmp CONTROL_ROOM_URL=http://127.0.0.1:3107/workspace CONTROL_ROOM_SIMULATION_PREPARATION_FAILURE_ONLY=1 pnpm smoke:simulation-preparation
```

Wynik: exit 0. Potwierdzone: `failure-dialog-auto-open`,
`full-report-collapsed`, `full-report-expanded`, `dialog-geometry-in-viewport`,
`dialog-focus-trapped`, `dialog-reduced-motion-stable`, `copy-full-report`,
`network-failures-none`, `console-errors-none`, `page-errors-none` i
`http-errors-none`.

### Broad lane

**NOT VERIFIED — fresh broad execution.** Broad lane został przejrzany jako
zachowany w źródle, ale nie został uruchomiony świeżo po tym fixie. Jego
WebSocket invalidation należy kwalifikować osobnym pełnym przebiegiem, nie na
podstawie narrow lane.
