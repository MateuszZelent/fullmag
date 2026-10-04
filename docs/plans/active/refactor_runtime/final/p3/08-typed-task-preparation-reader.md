# Typowany odczyt task preparation receipt

Data: 25.09.2026

Zakres: P3/P5-A — odczyt trwałego task receipt na granicy runtime-control.

## Wynik

`AcceptedStudySnapshot::read_task_preparation_receipt` odczytuje receipt przez
`SessionStore`, który wcześniej weryfikuje envelope, digest payloadu, RunIntent,
run catalog, task ID i wejściowy fingerprint. Runtime-control deserializuje
payload jako application `PreparationReceipt`, uruchamia jego pełną walidację
(w tym plan fingerprint i certyfikaty), porównuje ID receiptu z envelope i
wiąże plan z immutable RunSpec, study step, ProblemIR oraz wynikiem kanonicznego
planera.

`AcceptedStudySnapshot::resolve_task_input_from_store` łączy ten odczyt z
konkretnym `TaskRecord`, `TaskClaim` i krokiem: najpierw wyprowadza oczekiwany
task ID z `(run_id, step_id)`, odrzuca rozbieżną tożsamość i claim niezgodny
z durable catalog (attempt, epoch, resource, readiness i lifecycle), wymaga
aktywnego resource lease z tym samym heartbeat, kind i budget, a potem
przekazuje receipt do walidacji resolved input. Regresja API dla przyjętego ProjectRun
porównuje materializowany receipt z wersją wczytaną z trwałego store i używa
tej metody; sprawdza też odmowę dla obcego kroku, starego heartbeat i budżetu
lease niezgodnego z claimem. Brak receiptu albo payload bez poprawnego typu
application kończy się błędem.

## Weryfikacja i granice

- `rustfmt --edition 2021 --config skip_children=true --check` dla zmienionych
  modułów Rust: **PASS**.
- `git diff --check` dla zmienionych plików: **PASS**; Git zgłasza tylko
  konwersję LF/CRLF.
- Regresja API i kompilacja: **NOT RUN / NOT VERIFIED**. Managed runner nadal
  zgłasza `Container profile allow-list mismatch`; `runner-doctor` nie
  poświadcza kontekstu Docker Desktop. Builda hostowego nie uruchamiałem.

To jest typed reader i boundary validation, nie produkcyjny worker ani
admission. Metoda wymaga gotowego claimu, lecz go nie tworzy ani nie zapisuje;
odczyt lease nie jest atomowy z późniejszą publikacją komendy, więc granica
dispatch musi ponownie zweryfikować lease pod writer lock. Metoda nie zmienia
lifecycle/readiness, nie rozwiązuje zależności, nie uruchamia solvera i nie
dowodzi trwałości po restarcie procesu. Następny krok musi wywołać ją w
rzeczywistym adapterze claim/worker oraz odmówić admission dla taska bez jego
receiptu lub nierozstrzygniętych zależności. Zestaw wielu receiptów nie jest
transakcją; replay materializacji naprawia brakujące wpisy, a brakujący task
pozostaje zablokowany.

Procenty nie zmieniają się bez przejścia właściwej bramki: P3 **49%**, P4
**50%**, P5 **0%**, całość około **27%**.
