# P4-B — supervisor procesu przygotowania FEM

Data: 28.09.2026
Implementacja: `bd8ec68bf`

## Zakres

Nowe binarium `fullmag-api-accepted-fem-preparation-supervisor` wykonuje jeden
preparation attempt na dokładnym, już przydzielonym preparation lease. CLI
wymaga RunId, TaskId, resource_id, preparation attemptu, lease tokenu, timeoutu
oraz interwału heartbeat. Domyślnie uruchamia sąsiednie binarium
`fullmag-api-accepted-fem-preparer`; jawna ścieżka jest sprawdzana jako zwykły
plik przed przekroczeniem trwałej granicy launch.

Supervisor najpierw rekoncyliuje stan trwały:

1. Istniejący exit receipt jest finalizowany bez nowego procesu.
2. Istniejący launch bez exit oznacza niejednoznaczny wynik wcześniejszego
   spawnu. Supervisor kończy się fail-closed i zachowuje lease.
3. Brak obu rekordów pozwala zapisać nowy launch intent. Wyłącznie wynik
   `Accepted` uprawnia do spawnu.

Po uruchomieniu procesu supervisor okresowo odnawia dokładny preparation lease.
Timeout lub błąd heartbeat kończy potomka i czeka na potwierdzony exit. PID,
opcjonalny start token, kod wyjścia, timeout oraz powód błędu trafiają do
immutable exit receiptu. Po jego trwałym zapisie supervisor wywołuje atomową
finalizację readiness/release. Błąd obserwacji przed potwierdzonym exit zachowuje
lease i nie tworzy fałszywego dowodu zakończenia.

Potwierdzony exit nie zostaje utracony wskutek błędu odczytu stdout/stderr:
supervisor zapisuje wtedy failed receipt z ograniczonym powodem błędu. Spawn
syscall po zaakceptowanym launch pozostaje celowo niejednoznaczny w razie
awarii procesu supervisora; restart nie uruchamia preparera drugi raz.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-api --bin fullmag-api-accepted-fem-preparation-supervisor --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `rustfmt --check` obu nowych plików | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Managed process E2E i native FEM | **NOT VERIFIED** |

Następny krok to rezydentny scheduler preparation: odczyt generacyjnej puli,
wybór zablokowanego accepted taska, atomowy admission lease i uruchomienie tego
supervisora. Następnie potrzebny jest managed process E2E z rzeczywistym native
FEM. P4 pozostaje na **50%**, cały plan na około **49%**.
