# Trwała publikacja `Prepare` dla zaakceptowanego taska

Data: 25.09.2026
Zakres: P3/P5-B — połączenie typed preparation receipt z coordinator outbox.

## Wynik

`fullmag-runtime-control::publish_accepted_task_prepare` wiąże istniejący
`DurableWorkerCoordinator` z `AcceptedStudySnapshot` i `SessionStore`. Adapter
odczytuje task oraz claim z checkpointu koordynatora, sprawdza je wobec
durable run catalog i aktywnego resource lease, pobiera typed task receipt,
wiąże go z immutable RunSpec/study/ProblemIR, a następnie buduje
`ResolvedTaskInput`. Komenda `WorkerCommand::Prepare` trafia do istniejącego
`DurableWorkerCoordinator::commit_command`; publisher zapisuje transition i
checkpoint jednym `commit_transition` w coordinator journal przed zwróceniem
envelope.

Przed pierwszym `Prepare` adapter zapisuje dodatkowo `FmsCoordinatorGenesis`
w run catalog. Store wiąże checkpoint o sekwencjach zero z run/task/attempt/epoch
i aktywnym resource lease; recovery może zatem odróżnić nowy stream od pustej
historii. Zapis genesis nie wysyła komendy ani nie zwalnia z wymogu aktywnego
lease przy późniejszej publikacji.

Przed pierwszym `Prepare` adapter zapisuje dodatkowo `FmsCoordinatorGenesis`
w run catalog. Store wiąże checkpoint o sekwencjach zero z task/attempt/epoch
i aktywnym resource lease; recovery może zatem odróżnić nowy stream od pustej
historii. Zapis genesis nie wysyła komendy ani nie zwalnia z wymogu aktywnego
lease przy późniejszej publikacji.

Jeżeli publikacja magazynowa zawiedzie, adapter zwraca oryginalny błąd
`SessionStore`, a `DurableWorkerCoordinator` zachowuje dokładny pending
transition do retry. Publikacja ponownie sprawdza lease w transakcji zapisu,
więc wcześniejszy odczyt lease nie jest samodzielną zgodą na dispatch.

Regresja w `crates/fullmag-api/src/router_v2/tests/project_documents.rs`
sprawdza, że adapter emituje sekwencję `Prepare=1`, wejście zgadza się z
niezależnie rozwiązanym wejściem, a dokładny envelope jest trwale zapisany w
journalu jako `CoordinatorMessage::Command`.

## Weryfikacja

- `rustfmt --edition 2021 --config skip_children=true --check` dla
  `fullmag-runtime-control/src/{study,lib}.rs`: **PASS**.
- `git diff --check` dla zmienionych plików śledzonych: **PASS**; nowy raport
  sprawdzono pod kątem końcowych spacji i poprawnego zakończenia linii.
- Test API i kompilacja: **NOT RUN / NOT VERIFIED**. Managed runner nadal
  zgłasza `Container profile allow-list mismatch`, a `runner-doctor` nie
  poświadcza kontekstu Docker Desktop. Nie uruchamiałem builda hostowego.

## Granice i dalsza praca

To jest trwały adapter outboxa, nie worker ani transport. Nie wysyła wiadomości,
nie rozpoczyna solvera, nie zmienia task readiness/lifecycle, nie rozwiązuje
zależności study i nie dowodzi wykonania po restarcie procesu. CLI/supervisor
muszą odzyskać coordinator journal, dostarczyć komendę transportem i
reconcile'ować ACK/replay. Task bez gotowego receipt albo aktywnego claimu
pozostaje odrzucony.

Procenty nie zmieniają się bez przejścia bramki testów i kolejnych integracji:
**P3 49%, P4 50%, P5 0%, całość około 27%**.

## Stan checkoutu i zasobów

Praca pozostaje w istniejącym, współdzielonym checkoutcie `master` przy HEAD
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`; checkout był dirty przed tym
przyrostem i nie został czyszczony. Nie tworzono ani nie usuwano worktree i nie
uruchomiono zadania build/test w runnerze. Następny krok: wznowić kontrolowaną
bramkę managed, a potem zaprojektować fenced wybór/claim taska i konsumenta CLI
na podstawie istniejącego lease — bez przekazywania arbitralnego claimu z
wiersza poleceń.
