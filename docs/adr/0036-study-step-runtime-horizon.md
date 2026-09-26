# ADR-0036: Horyzont czasu w typowanym kroku Study

- Status: accepted for implementation
- Data: 2026-09-25
- Decydenci: Fullmag core
- Powiązany plan: `docs/plans/active/refactor_runtime/final/03-plan-refaktoryzacji.md` (P3-B)
- Powiązana decyzja: [ADR-0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)

## Kontekst

`ProblemIR::StudyIR::TimeEvolution` opisuje dynamikę i próbkowanie, ale nie
zawiera czasu, przy którym solver ma zakończyć bieg. Publiczny runner przyjmuje
`until_seconds` osobno. Dotychczasowy `StudyPlan` zachowywał ustawienia starego
pipeline wyłącznie w nieinterpretowanym `legacy_payload`, a
`study_execution_plan.v1` nie przenosił wartości do granicy wykonania.

Przyszły supervisor nie mógłby odtworzyć dokładnego zaakceptowanego zadania:
musiałby zgadnąć czas, odczytać mutable UI albo uruchomić nieograniczoną
TimeEvolution. Sampling i interwały autosave określają wyjścia, nie czas
zakończenia solvera.

## Decyzja

1. `StudyPlan v2` dodaje opcjonalne per-step `until_seconds` w jednostkach SI.
   Dla uruchamianego kroku, którego immutable `ProblemIR` ma
   `StudyIR::TimeEvolution`, lowering wymaga wartości skończonej i większej od
   zera. Wartość jest częścią canonical bytes i digestu zaakceptowanego planu.
2. Jawny adapter dotychczasowego pipeline mapuje tylko
   `PrimitiveStageKind::Run.payload.until_seconds` do typed field. Akceptuje
   liczbę lub tekst liczbowy, waliduje dodatnią skończoną wartość i równocześnie
   zachowuje pełny oryginalny `legacy_payload` do audytu. Pozostałe payloady
   nie stają się kontrolą solvera.
3. `study_execution_plan.v2` przenosi `until_seconds` bez modyfikacji. Worker
   odtwarza wartość z zaakceptowanego execution planu i przekazuje ją runnerowi;
   nie wyprowadza czasu z próbkowania, autosave, UI, zegara ściennego ani
   wartości domyślnej.
4. `StudyPlan v1` oraz `study_execution_plan.v1` pozostają czytelne dla
   historycznych rekordów bez nowego pola. v1 nie może deklarować
   `until_seconds`. Legacy v1 TimeEvolution bez jawnego horyzontu jest
   nieuruchamialny i kończy się błędem przed efektem solvera; archiwum ani
   zaakceptowany rekord nie są przepisywane.
5. Pozostałe typy badań zachowują swoje istniejące stop controls. Ta decyzja
   nie przenosi kryteriów zbieżności, limitów iteracji ani harmonogramów
   pętli do `until_seconds`.

## Konsekwencje

- Czas solvera jest częścią niezmiennego wejścia wykonania, a nie właściwością
  autosave ani późniejszym parametrem supervisora.
- `RunSpecification.study.plan_version` i `plan_sha256` przypinają nową
  wersję oraz jej wartość per krok.
- Przyjęcie zadania z TimeEvolution bez horyzontu jest blokowane przez
  canonical lowering; brak danych nie jest naprawiany przez fallback.
- Implementacja supervisora musi pobrać dokładny `StudyStepExecutionPlan` z
  zaakceptowanego runu i przekazać `until_seconds` do istniejącego runnera.
  Zmiana samej wartości nie zmienia wybranego backendu, urządzenia ani
  fizyki `ProblemIR`.

## Weryfikacja

- Adapter migracyjny zachowuje legacy payload i wyprowadza dodatni horyzont.
- Zero, wartości ujemne, niefinity i nie-numeryczne wartości są odrzucane.
- Historyczny plan v1 bez pola nadal się parsuje; dodanie pola bez bumpu wersji
  jest odrzucane.
- Lowering TimeEvolution bez horyzontu fail-closed, a z horyzontem przenosi
  dokładną wartość do execution planu.
- Testy source/contract nie zastępują uruchomienia przez managed worker,
  sprawdzenia rzeczywistej długości symulacji ani kwalifikacji naukowej.
