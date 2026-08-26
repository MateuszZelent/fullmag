# Task 2 — raport wykonania

## RED 1: hierarchia modala

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx -t "auto-opens one precise failure dialog"
```

Wynik: `FAIL` — 1 test nie przeszedł, 10 pominięto. Asercja nie znalazła tekstu `What happened`; modal zawierał jeszcze `Detected constraints` i `Copy diagnostic report`.

## GREEN: Task 2 przed rozszerzeniem review Task 1

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx
```

Wynik: `PASS` — 1 plik, 11 testów przeszło. Obejmuje kopiowanie raportu, ponowienie po błędzie schowka i nawigację do Diagnostic Recorder.

## RED 2: niezależne ograniczenie analizy predykatów

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx -t "auto-opens one precise failure dialog"
```

Wynik: `FAIL` — 1 test nie przeszedł, 10 pominięto. Brakuje tekstu `Predicate analysis was truncated; the raw diagnostic report remains complete.`. Aktualny model nadal nie udostępnia `predicateAnalysisTruncated`; używa jedynie `omittedPredicateCount`, który dla ograniczenia tekstu błędnie pokazuje liczbę pominiętych predykatów.

## Dodatkowe kontrole

Polecenie:

```bash
pnpm --dir apps/control-room typecheck
```

Wynik: `PASS` — typy tras zostały wygenerowane, typecheck zakończył się powodzeniem.

Polecenie:

```bash
npx react-doctor@latest --verbose --scope changed
```

Wynik: zakończone z kodem 0 bez zgłoszeń.

## Zmienione pliki Task 2

- `apps/control-room/src/kernel/layout/SimulationPreparationMounted.test.tsx`
- `apps/control-room/src/kernel/layout/simulationPreparationTestDom.test-support.ts`
- `apps/control-room/src/kernel/layout/SimulationPreparationFailureDialog.tsx`
- `apps/control-room/src/design/styles/dialog-simulation-startup.css`
- `.superpowers/sdd/task-2-report.md`

`SimulationStartupOverlay.tsx` i `simulationPreparationDiagnostics.ts` nie wymagały zmiany: już przekazują pełny allowlistowany JSON do schowka i nie wprowadzają bezpośredniego transportu/API.

## Integracja z poprawką Task 1

Potwierdzony kontrakt to `failure.predicateAnalysisTruncated`, wyprowadzony w modelu z `analysisTruncated`. Fixture Task 2 skraca pojedynczy nieznany predykat, więc `predicateAnalysisTruncated` jest prawdziwe, a `omittedPredicateCount` pozostaje zerowe. Modal renderuje komunikat wyłącznie z booleana i nie wyprowadza z niego liczby pominiętych predykatów.

## GREEN: końcowy Task 2

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx
```

Wynik: `PASS` — 1 plik, 11 testów przeszło. Test obejmuje automatyczne otwarcie, trzy sekcje, zalecenie FEM CPU, kod błędu, correlation ID, domyślną etykietę kopiowania, kopiowanie, retry i nawigację do Diagnostic Recorder.

## Kontrola zakresu i self-review

Polecenie:

```bash
git diff --check
```

Wynik: `PASS` — brak błędów białych znaków.

Przegląd końcowy potwierdził:

- brak `unsupported_cubic_anisotropy` w fixture modala Task 2;
- ostrzeżenie zależy bezpośrednio od `failure.predicateAnalysisTruncated`;
- `omittedPredicateCount` pozostaje wyłącznie komunikatem o rzeczywistej liczbie pominiętych pozycji;
- pełny raport pozostaje allowlistowanym JSON-em w domyślnie zwiniętym `<details>`;
- brak zmian w `SimulationStartupOverlay.tsx`, serializerze, modelu Task 1, Rust, API, OpenAPI i dokumentacji projektowej;
- brak stagingu lub commitu.

## Remediacja review Task 2

### RED: rozłączne komunikaty i kompletność modala

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx
```

Wynik: `FAIL` — 1 plik, 2 testy nie przeszły, 10 przeszło. Modal nadal wyświetlał dwa sąsiadujące komunikaty (`2 additional predicate(s)...` i `Predicate analysis was truncated...`) oraz nie używał wymaganej precyzyjnej referencji do zwiniętego `Full diagnostic report`.

### GREEN: remediacja review Task 2

Polecenie:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx
```

Wynik: `PASS` — 1 plik, 12 testów przeszło.

Nowe asercje montowane dowodzą:

- dla skróconego predykatu bez pominiętej pozycji pokazuje się wyłącznie komunikat o ograniczonej analizie;
- dla 34 predykatów pokazuje się dokładnie raz `2 predicate(s) were omitted...`, bez drugiego komunikatu o truncation;
- oba warianty wskazują precyzyjnie zwinięty `Full diagnostic report`;
- `<details>` istnieje, nie ma `open` domyślnie i po kliknięciu natywnego `<summary>` uzyskuje `open`;
- requested `fem · gpu · double · strict · mfem` i resolved `fem · cpu · double · strict · mfem` są widoczne w `<dl>`;
- raport schowka zawiera correlation ID, 9 etapów, oba execution summaries i ostatnie 200 logów, bez wstrzykniętych `host_path` ani `secret`.

### Kontrole po remediacji

Polecenie:

```bash
pnpm --dir apps/control-room typecheck
```

Wynik: `PASS` — generowanie typów tras i typecheck zakończone powodzeniem.

Polecenie:

```bash
git diff --check
```

Wynik: `PASS` — brak błędów białych znaków.

Polecenie:

```bash
git diff --cached --name-only
```

Wynik: `PASS` — brak plików w stagingu.

Scoped search nie znalazł `fetch(`, `/v2/` ani `unsupported_cubic_anisotropy` w zmienionym modalu i jego teście. Zmiana `simulationPreparationTestDom.test-support.ts` emuluje natywny toggle `<summary>`/`<details>` wyłącznie w harnessie testu montowanego; nie jest testem ani modelem Task 1.

Browser smoke nie został uruchomiony zgodnie z przekazaniem tej bramki kontrolerowi po integracji.
