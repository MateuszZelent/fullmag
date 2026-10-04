# P3-A — typed study contract

## Zakres

P3-A zamyka kontrakt authoringowy, który opisuje kolejność i zależności
studium bez uruchamiania solvera. `StudyPlan` jest wersjonowanym dokumentem
z jawnym `study_id`, rewizją i listą `StudyStep`. Każdy krok przypina model,
solver preset, recipe dyskretyzacji oraz execution profile jako osobne
referencje. Dzięki temu zmiana profilu wykonania nie zmienia definicji modelu,
a planner może odrzucić brakującą capability przed kosztownym przygotowaniem.

## Porty i źródła

Krok ma typowane porty wejścia i wyjścia. Źródło wejścia musi być jedną z
czterech wartości:

- authored initial state;
- pinned artifact z wymaganym SHA-256;
- output poprzedniego kroku wskazany przez `step_id`, port i `case_id`;
- explicit continuation do konkretnego `run_id`.

Nie istnieje źródło `latest` ani odczyt bieżącej sesji. Walidacja porównuje
`StudyPortDataKind` źródła i portu, pilnuje niepowtarzalności identyfikatorów
oraz odrzuca nieistniejące kroki i porty. Zależności grup i portów przechodzą
przez topologiczne sortowanie; cykl jest błędem kontraktu.

## Migracja i dane nieobsługiwane

`StudyPlan::from_pipeline()` jest adapterem starego
`StudyPipelineDocument`. Primitive, macro i group zachowują identyfikator,
etykietę, enabled/source, payload/config oraz stan collapsed w
`legacy_payload`. Model, preset, dyskretyzacja i execution profile pochodzą z
jawnych `StudyPlanMigrationDefaults`; adapter nie uzupełnia ich z `current` i
nie uruchamia żadnego backendu.

Nieznany rodzaj kroku jest dekodowany jako `StudyStepKind::Unsupported` z
pełnym wejściowym JSON-em. `StudyPlan::validate()` pozwala taki dokument
zachować i audytować, natomiast `validate_for_execution()` zwraca blokadę.
To tworzy bezpieczną granicę dla przyszłych typów oraz wyklucza ciche
pomijanie danych podczas migracji.

## Dowód i granica

`cargo check --locked -p fullmag-authoring --lib` przechodzi. Testy źródłowe
obejmują zachowanie nieznanego rodzaju i zachowanie payloadu migracji, ale nie
zostały uruchomione, ponieważ bieżąca polityka repozytorium tymczasowo zabrania
kompilowania testów jednostkowych Rust.

`fullmag-plan::lower_study_plan` oraz `study_problem_catalog.v1` wykonują już
jawne lowering i przyjęcie immutable snapshotów `ProblemIR`. Katalog wiąże
każdy włączony krok z digestem konkretnego `StudyPlan`, rewizją i czterema
referencjami authoringowymi; niepełny albo stary katalog jest odrzucany przed
plannerem.

Ten przyrost nadal nie dowodzi producerów meshu, materializacji
`RunSpecification`, transportu workerów ani runtime. Te elementy pozostają
jawnie otwarte.
