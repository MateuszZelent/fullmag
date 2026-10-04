# P3-B/P5-B — anulowanie zadania przez operatora

Data checkpointu: 26.09.2026. Baza źródeł:
`master@60b69cd152ad4eb6314900926b2853eea351ed56`; bieżący przyrost jest
przypięty hashami treści w receiptach.

## Zrealizowany kontrakt

Operator może zażądać anulowania dokładnego zadania przyjętego runu przez
`POST /v2/persistence/projects/{project_id}/runs/{run_id}/tasks/{task_id}/cancellation`.
Endpoint sprawdza przynależność runu do projektu i zapisuje fenced
`WorkerCommand::Stop` wyłącznie dla aktualnego claimu w stanie `Running`.
Powtórzenie tej samej przyczyny zwraca ten sam command jako replay; inna
przyczyna, obcy task lub stan inny niż `Running`/`Stopping` są odrzucane bez
utworzenia drugiej sekwencji sterowania.

Supervisor obserwuje trwały katalog. Po stanie `Stopping` kończy potomka,
czeka na potwierdzony exit, zapisuje `WorkerEvent::Stopped`, przeprowadza task
do terminalnego `Cancelled` i zwalnia dokładną, najnowszą wersję lease.
Trwały `Succeeded` ma pierwszeństwo, jeżeli completion barrier został
opublikowany przed żądaniem zatrzymania. Późny `Completed` po `Cancelled` jest
odrzucany.

Control Room korzysta z wygenerowanego kontraktu OpenAPI. Inspector pokazuje
`Cancel` tylko dla taska `running`, prowadzi pending/error osobno dla taska i
po odpowiedzi unieważnia zasób szczegółów runu oraz bieżącej listy rewizją
katalogu zwróconą przez API. Stan `stopping` jest prezentowany jako
`Cancellation requested`.

## Weryfikacja

- `just verify-runtime-control`: **3/3 PASS**, receipt
  `2e95c96d95114b61aafa719c9f95c60b`;
- `just verify-project-application`: **PASS**, receipt
  `d7ff33f78d4b43ba8e5b5468eba594a4`;
- `just check-api-source`: **PASS**, receipt
  `31af50083eb2492792ad892c2be16880`;
- `just generate-api-openapi`: **PASS**, receipt
  `14de31ca54254276a21f0d134ba9d83c`;
- `just verify-api-accepted-supervisor`: **7/7 PASS**, receipt
  `dabe48e1506a46bfb2a579f7af94e496`;
- Control Room: typecheck, lint, API hygiene i architecture hygiene **PASS**;
  `ControlRoomApi.test.ts`: **141/141 PASS**;
- React Doctor dla zmienionego zakresu: **92/100**, jedna wcześniejsza uwaga
  o globalu przeglądarki w `ControlRoomApi.ts:706`, poza zmienionym przepływem;
- `scripts/test_verify_session_persistence.py`: **17/17 PASS**;
  repository consistency i scoped diff check **PASS**.

## Granica dowodu

Test procesu supervisora potwierdza zakończenie dziecka i odróżnia anulowanie
od timeoutu, a test runtime-control potwierdza trwały command, replay i
terminalny katalog. Brakuje jeszcze pełnego process E2E anulowania rzeczywistego
solvera, testu routera HTTP z uruchomionym store, zdalnego `StopAck`, anulowania
przed Start, polityki retry po anulowaniu oraz recovery osieroconego procesu po
awarii supervisora. Dowód dotyczy lokalnego supervisora i nie kwalifikuje FDM
GPU ani FEM CPU/GPU.

Ten przyrost podnosi P3 do około **65%**, P5 do około **18%**, a cały plan do
około **29%**.
