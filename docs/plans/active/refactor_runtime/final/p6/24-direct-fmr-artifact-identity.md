# P6-A — jawna tożsamość bezpośredniego writera FMR

Data: 29.09.2026

Status: **SOURCE VERIFIED / REGRESSION TESTS AUTHORED, NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

Rodzina `driven_response` ma identity-aware entrypointy dla pełnego oraz
przerwanego field-driven response sweep. Przyjmują wspólny
`FrequencyDomainArtifactIdentity`, walidują go przed solve i zapisem oraz
przenoszą dokładne `session_id`, `run_id`, `stage_id` i `runtime_id` do
`frequency_domain/manifest.v1.json`.

Walidacja odrzuca te same puste wartości, znaki sterujące i mutable aliasy co
writer modal-eigen. Błąd identity występuje przed utworzeniem trwałego
manifestu. Istniejące entrypointy bez kontekstu pozostają wyraźną granicą
legacy dla niemigrowanych callerów; nie są dowodem produkcyjnej publikacji.

## Dowody

- `cargo check -p fullmag-runner --lib`: **PASS**; ostrzeżenia pochodzą z
  wcześniejszych, nieskopowanych miejsc runnera i engine.
- Dodano regression checks zachowania czterech dokładnych ID oraz odmowy
  publikacji dla aliasu `current`.
- Testy pozostają **NOT RUN** zgodnie z tymczasowym zakazem budowania i
  uruchamiania testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Główne API `run_planned_problem*` nie ma jeszcze runner-owned execution
context, więc produkcyjny FMR nie wywołuje nowego writera. Transportowe
`resources` nadal zawierają `/v2/sessions/current`; wymagają identity-only
referencji oraz projekcji route po stronie API. Osobno otwarte są native FEM
writer plumbing, copy-on-write migrator historycznych plików, managed runtime
i kwalifikacja wszystkich lane'ów.
