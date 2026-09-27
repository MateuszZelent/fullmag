# P4-B — atomowy admission i scheduler preparacji FEM

Data: 28.09.2026
Implementacja: `82ce8ed84`, `9846e5736`

## Atomowa granica admission

Store rozstrzyga teraz dostępność taska i zasobu w jednej transakcji pisarza.
`try_commit_preparation_resource_lease_from_pool` ponownie sprawdza dokładny
pool_id, generację, ofertę i budżet, a następnie weryfikuje, że task nadal jest
`Accepted/Blocked(accepted_task_awaiting_preparation)`, nie ma solver claimu,
preparation receiptu ani innego aktywnego preparation lease.

Zwykły wyścig schedulerów zwraca `None`, więc drugi proces odświeża snapshot
zamiast traktować zajęcie taska lub zasobu jako uszkodzenie store. Niezgodność
generacji, oferty lub payloadu pozostaje błędem fail-closed. Ta sama kontrola
unikalności taska działa także w starszej metodzie commit, więc dwa różne
zasoby nie mogą równocześnie przygotowywać tego samego taska.

Store udostępnia typowaną listę wszystkich aktywnych preparation lease. Pełna
walidacja ścieżek, symlinków i tożsamości RunId/resource/token poprzedza zwrot
rekordów.

## Rezydentny scheduler

Nowe binarium `fullmag-api-accepted-fem-preparation-scheduler`:

- odczytuje generacyjny `preparation_resource_pool.v1`;
- wykrywa accepted taski oczekujące na preparation we wszystkich trwałych run
  intentach i zachowuje ich immutable scheduling priority;
- przydziela ofertę tylko przez atomową granicę task+resource;
- ogranicza równoległość i liczbę wykonanych tasków;
- po restarcie najpierw odzyskuje każdy aktywny preparation lease, również gdy
  oferta zniknęła już z najnowszej puli;
- uruchamia dla lease produkcyjny supervisor, który wykonuje launch/heartbeat,
  exit receipt i finalizację;
- w trybie resident reaguje na sygnał zakończenia, przestaje admitować nowe
  taski i dołącza aktywne wątki przed wyjściem;
- odrzuca regresję generacji, zmianę payloadu bez nowej generacji oraz zmianę
  budżetu aktywnego resource_id;
- nie wykonuje automatycznego retry po trwałym failed exit. Taki retry wymaga
  przyszłej jawnej decyzji i limitu, aby awaria native FEM nie tworzyła pętli.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-accepted-fem-preparation-scheduler --bin fullmag-api-accepted-fem-preparation-supervisor --bin fullmag-api-accepted-fem-preparer --bin fullmag-api-preparation-resource-pool` | **PASS** |
| `rustfmt --check` nowego schedulera | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Managed scheduler/process/native FEM E2E | **NOT VERIFIED** |

Następny wymagany krok to zarządzany procesowy E2E: publikacja puli, accepted
FEM run, atomowy admission, rzeczywisty native preparer, receipt/readiness oraz
zwolnienie dokładnego lease. Później należy dodać jawny retry decision i trwały
kursor fairness. P4 pozostaje na **50%**, cały plan na około **49%** do czasu
dowodu runtime.
