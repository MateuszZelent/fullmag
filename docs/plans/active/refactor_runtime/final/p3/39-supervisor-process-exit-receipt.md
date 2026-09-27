# P3-B / P5-B — trwały receipt wyjścia procesu i orphan recovery

Data: 27.09.2026
Stan: zaimplementowane i zweryfikowane dla lokalnego supervisora FDM CPU

## Cel przyrostu

Poprzedni checkpoint potrafił wznowić retry po trwałym journalu decyzji, ale
awaria supervisora po potwierdzonym wyjściu workera i przed zapisaniem tej
decyzji pozostawiała aktywny lease oraz zajęty slot. Restart nie mógł bezpiecznie
odróżnić zakończonego potomka od nadal działającego procesu.

Przyrost dodaje trwały dowód dokładnie tego zdarzenia. Nie opiera takeover na
wieku lease, braku PID ani timeoutcie obserwatora.

## Kontrakt

`worker_process_exit_receipt.v1` jest niezmiennym rekordem:

- identyfikuje run, task, attempt i ownership epoch;
- wiąże resource ID, lease token i dokładną ostatnią sekwencję heartbeat;
- zapisuje PID i opcjonalny systemowy token startu procesu;
- zapisuje exit code, success, timeout lub potwierdzone żądanie Stop;
- dla błędu zachowuje ograniczoną przyczynę używaną do terminalnego eventu i
  decyzji retry;
- powstaje dopiero po `wait`/reap procesu i przed eventem terminalnym, decyzją
  retry oraz release lease.

Store akceptuje rekord tylko przy zgodnym aktualnym catalog claimie i aktywnym
lease. Identyczny zapis jest replayem, a zmiana payloadu lub heartbeat fence
jest konfliktem. Receipt pozostaje w historii po zwolnieniu lease i przechodzi
przez reachability, GC oraz eksport/import `.fms`.

## Recovery

Przed każdym spawnem supervisor szuka najpierw trwałej decyzji retry, a potem
receiptu bieżącego attemptu. Stary globalny slot można przejąć wyłącznie po
potwierdzeniu śmierci jego właściciela i istnieniu jednego z tych dowodów.

Recovery receiptu:

1. odczytuje dokładny nadal aktywny lease;
2. rekonstruuje fenced claim z trwałych identyfikatorów i resource budget;
3. replayuje coordinator journal oraz worker inbox;
4. domyka `Succeeded`, `Cancelled` albo retryable `Failed`;
5. dla retry sprawdza brak prywatnego katalogu efektu i jawny limit;
6. zapisuje jedną deterministyczną decyzję przed release;
7. zwalnia exact lease i dopiero potem stosuje `Failed -> Queued`.

Nieistniejące binarium workera w drugim procesie jest częścią regresji: dodatni
wynik dowodzi, że recovery zakończyło się przed kodem spawnu.

## Zmienione powierzchnie

- `fullmag-session`: typ, walidacja, idempotentny store, odczyt exact lease,
  reachability i `.fms`;
- `fullmag-api`: publikacja po reap, recovery przed spawnem, obsługa sukcesu,
  anulowania i błędu oraz kontrolowany hook awarii; idempotentne odczyty
  trwałego claimu/inboxu/journalu i zapis payloadów do CAS ponawiają wyłącznie
  chwilowy `StoreWriterBusy` w ograniczonym oknie. Błąd pollingu kontroli kończy
  i reapuje potomka, a jego przyczyna trafia do receiptu. Błąd przed trwałym
  receiptem zachowuje slot supervisora fail-closed;
- wrapper weryfikacyjny: jawna zarządzana trasa
  `api-accepted-supervisor-process-exit-recovery-e2e`;
- ADR-0034: trwała decyzja o znaczeniu receiptu i granicach takeover.

## Dowody

| Bramka | Wynik | Receipt / tożsamość |
|---|---|---|
| Managed process E2E: crash po receipcie, restart bez binarium workera | **1 passed, 0 failed** | `2cc7eed7314f48f6b7a11163c242257f`; content `689d19d7f8fd5e11828f04a3fc166a1d1a71c861c8bf24167ae0c5b9c6dd615f`; `source_changed_during_run=false` |
| Managed process E2E: zwykły sukces | **1 passed, 0 failed** | `7d6fb25844954b45a6311f0ceed15ab8`; ten sam content; `source_changed_during_run=false` |
| Managed process E2E: anulowanie żywego workera przy konkurencyjnym writerze | **1 passed, 0 failed** | `81b3c2242b6c492db088a5aa7d0d2131`; ten sam content; `source_changed_during_run=false` |
| Błąd pollingu sterowania: kill, reap i zachowanie przyczyny | **1 passed, 0 failed** | test targetu `fullmag-api-accepted-supervisor` |
| `fullmag-session`: store, archive i integracje | **65 + 9 + 13 passed, 0 failed** | `c7768a2914ce4fe19dae02424d4894c5`; content `08dbc187ee1665b2eeee733369dcc5907195ff556dbc1da25d1811d6003875bc`; `source_changed_during_run=false` |
| Rejestr zarządzanych tras | **24 passed, 0 failed** | lokalny `pytest`; stała komenda i środowisko hooków |
| Kompilacja źródłowa | **PASS** | `fullmag-session --lib` i `fullmag-api-accepted-supervisor` |

Zarządzane receipty przypinają dirty
`master@9ce6680b0a6eb906c45e15c6784eda12e4cc4440` oraz hash pełnej treści objętej
trasą. Dokładny zweryfikowany zakres został zintegrowany w
`db1661c6b8bcbb01881b9193e2072abc03e1ed5d`.

## Granice

Ten dowód obejmuje lokalny proces FDM CPU i exact lease w jednym store. Nie
kwalifikuje FDM GPU, FEM CPU/GPU, zdalnego transportu, zwolnienia VRAM ani
braku starego procesu na innym hoście. P5-B nadal wymaga zdalnego ACK/liveness,
rezydentnej puli wielu runów, fairness oraz lane-specific resource-release
proof. Scientific correctness i release qualification są osobnymi bramkami.
