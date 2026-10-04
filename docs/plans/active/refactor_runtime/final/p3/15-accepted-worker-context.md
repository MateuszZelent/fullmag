# P3-B — odtworzenie wejścia accepted task po stronie workera

Data: 25.09.2026

## Zakres

`fullmag-runtime-control::load_accepted_worker_step` materializuje workerowy
kontekst z zaakceptowanego `RunSpec`, study, katalogu `ProblemIR` i
`WorkerCommandEnvelope::Prepare`. Nie czyta mutable `current` i nie zmienia
kontraktu solvera.

Przed zwróceniem kontekstu funkcja sprawdza:

- że task ma aktualny claim i aktywny lease zgodne z envelope;
- że task jest `Ready` w lifecycle `Preparing`;
- że task ID wskazuje dokładnie jeden włączony krok accepted study;
- że plan odtworzony z `ProblemIR` przez canonical planner jest identyczny
  z pinned `ExecutionPlanIR`, a jego digest zgadza się z `ResolvedTaskInput`;
- że RunSpec fingerprint i requested execution są identyczne z accepted run;
- że dokładne `until_seconds` zgadza się między planem authoringowym i
  execution planem; TimeEvolution bez dodatniej, skończonej wartości jest
  odrzucany;
- że preparation receipt, study dependencies oraz wpisy StepOutput/manifestu
  odpowiadają temu taskowi i zaakceptowanemu katalogowi;
- że exact `Prepare` znajduje się w trwałym coordinator journalu, jego
  checkpoint odtwarza się, a run-catalog watermark nie jest za journale'em.

Wynik `AcceptedWorkerStep` zawiera current claim, step ID, immutable `ProblemIR`,
canonical `ExecutionPlanIR`, `until_seconds` i dokładny `ResolvedTaskInput`.
Integrator procesu może więc przekazać plan i horyzont bez ponownego wyboru
backendu lub pobierania ustawień z UI.

## Weryfikacja

`just verify-api-project-runs` — **4 PASS, 2 ignored**, exit 0, receipt
`1e1b8077acc9466da18b4853882df717`, źródła bez driftu. Rozszerzona regresja
odtwarza krok TimeEvolution z `until_seconds=1e-9`, porównuje problem, plan i
claim, a następnie odrzuca podmieniony plan digest oraz Prepare bez wpisu w
outboxie.

`git diff --check` — PASS; pozostało jedynie ostrzeżenie Git o normalizacji
LF/CRLF. Całościowy `rustfmt --check` dla istniejących, szeroko zmienionych
plików zwraca różnice w niezwiązanych hunks; raport nie wskazuje nowych hunks
adaptera ani asercji. Nie formatowano całych plików, aby nie rozszerzać diffu.

## Granica odbioru

To jest workerowy resolver accepted input, nie supervisor. Nie tworzy ani nie
rezerwuje procesu, nie zapewnia atomowego fencing'u pomiędzy odczytem claimu i
spawnem, nie dekoduje/materiałuje wartości stanu jako initial state konsumenta
i nie wywołuje runnera. Nie dowodzi wykonania solvera. Następne wymagane części
to atomowe process admission, supervisor z prywatnym katalogiem attemptu,
jawny transfer stanu zgodny z source/target space identity oraz publikacja
allow-listy outputów przed terminalnym `Completed`.

Zasoby: checkout `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9` pozostaje
brudny; nie wykonano stage/commit ani cleanup. Test receipt i log są zachowane
w canonical storage pod `builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-project-run-tests/1e1b8077acc9466da18b4853882df717/`.
