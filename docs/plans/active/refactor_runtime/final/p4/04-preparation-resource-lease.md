# P4-B — dzierżawa zasobu przygotowania FEM

Data: 27.09.2026
Decyzja: `1da0ce57746c8fb46293fb8543ef75066d6742d1`
Implementacja: `22654cce493ade6f6e1333b05a1ca869939aba59`

## Cel przyrostu

Proces accepted FEM potrafił utworzyć native mesh/H1 i preparation receipt,
ale nie miał trwałej, rozłącznej od solvera własności zasobu. Użycie
`resource_lease.v1` wymagałoby przedwczesnego claimu taska i mieszałoby fazę
meshowania z wykonaniem solvera. ADR-0037 definiuje dlatego osobną granicę
`preparation_resource_lease.v1`.

## Zaimplementowany kontrakt

- FEM task zaczyna jako `Accepted/Blocked` z jednoznacznym powodem
  `accepted_task_awaiting_preparation`. Preparer wymaga tego stanu i nadal nie
  tworzy solverowego attemptu ani ownership epoch.
- `FmsPreparationResourceLease` utrwala RunId, TaskId,
  `preparation_attempt_id`, zasób, budżet CPU/RAM/storage, token, sekwencję
  heartbeat i jawny stan zwolnienia. Pierwsza wersja odrzuca zerowe budżety
  CPU/RAM/storage oraz jakąkolwiek rezerwację VRAM.
- Store pozyskuje lease atomowo pod writer lockiem. Wymaga istniejącego
  katalogu, właściwego nieprzejętego taska i braku preparation receiptu.
  Identyczne ponowienie jest replayem; konflikt tożsamości kończy się przed
  zapisem.
- Wyłączność `resource_id` działa w obu kierunkach. Aktywny preparation lease
  blokuje solver lease, a aktywny solver lease blokuje preparation lease.
  Heartbeat jest sekwencyjny i fenced pełną tożsamością; zwolnienie odrzuca
  starszy heartbeat.
- Eksport FMS uwzględnia preparation lease. Store walker oraz archive
  preflight walidują typ, bezpieczną ścieżkę i jej zgodność z RunId,
  resource_id oraz tokenem. Lease accepted runu jest kontrolowany także wtedy,
  gdy solverowy `run_manifest.json` jeszcze nie istnieje.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Managed native FEM i process E2E | **NOT VERIFIED** — koordynator Docker Desktop pozostaje niedostępny |

Kompilacja zgłasza istniejące ostrzeżenia w zależnościach; nie ma błędów w
zmienionych pakietach.

## Otwarte elementy

Ten przyrost dostarcza trwały prymityw własności i archiwizacji. Nie tworzy
jeszcze `preparation_resource_pool.v1`, schedulera ani supervisora procesu.
Preparer nie otrzymuje jeszcze tożsamości lease i publikacja receiptu nie jest
jeszcze fenced aktywnym lease. Brakuje także process exit receiptu, recovery i
atomowej finalizacji readiness po potwierdzonym zakończeniu procesu.

Następny przyrost powinien najpierw związać publikację preparation receiptu z
aktywnym lease, następnie dodać pulę, admission i supervisor. Dopiero pełny
managed FEM CPU E2E może rozszerzyć accepted worker o FEM CPU.

P4 pozostaje na **50%**, a cały plan na około **49%**. Kontrakt źródłowy jest
spójniejszy, lecz wymagane dowody procesu, native runtime, fizyki i wydania nie
zostały jeszcze wykonane.
