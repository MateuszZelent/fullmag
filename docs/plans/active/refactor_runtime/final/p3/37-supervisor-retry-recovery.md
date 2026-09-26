# P3-B/P5-B — restartowe recovery decyzji retry

Data checkpointu: 26.09.2026. Baza źródeł:
`master@f0eacfac059fe394f84bf5159e7c7564f918a630`; bieżący przyrost jest
przypięty hashami treści w receiptach.

## Zrealizowany kontrakt

Automatyczny retry publikuje teraz immutable `retry_decision.v1` przed
zwolnieniem resource lease. Dopiero po trwałym zapisie decyzji supervisor:

1. zwalnia dokładną, najnowszą wersję lease;
2. idempotentnie stosuje decyzję do run catalogu;
3. zwraca task do `Queued`.

Restart supervisora zajmuje najpierw globalny slot, a następnie szuka jednej
decyzji `Retry` dopasowanej do terminalnego `Failed`/`Interrupted`, bieżącego
attemptu i ownership epochu. Jeżeli decyzja istnieje, supervisor odczytuje
aktywny lease mimo terminalnego lifecycle, sprawdza pełny fence
run/task/attempt/epoch, zwalnia go i replayuje decyzję. Dopiero brak takiej
decyzji prowadzi do zwykłego ładowania aktywnego claimu i ewentualnego spawnu
workera.

Recovery nie używa wieku heartbeat ani samej obecności pliku jako dowodu
śmierci procesu. Przejęcie slotu jest dozwolone wyłącznie dla tego samego
run/task, gdy istnieje dopasowana trwała decyzja retry, a zapisany identyfikator
procesu wraz z tokenem czasu jego startu nie wskazuje już żywego supervisora.
Trwała decyzja jest publikowana wyłącznie po potwierdzonym wyjściu workera i
stanowi journal zakończonej rekonsyliacji. Więcej niż jedna decyzja dopasowana
do tego samego terminalnego attemptu kończy się fail-closed.

## Weryfikacja

- `just verify-api-accepted-supervisor-retry-recovery-e2e`: **1/1 PASS**,
  receipt `f45284acb8a8486e941aa5c74f949be0`;
- `just verify-api-accepted-supervisor-automatic-retry-e2e`: **1/1 PASS**,
  receipt `7d5a4b3504334db9a07edd6f56565009`;
- `just verify-api-accepted-supervisor-e2e`: **1/1 PASS**, receipt
  `6f6e37d997dd44cdaadffd7f6a8890a4`;
- `just verify-api-accepted-supervisor`: **PASS**, receipt
  `8f5024a658ff4fcbaf15db0b9605e790`;
- `just verify-session-persistence`: **PASS**, receipt
  `259e369a9c464d66b8137a359db773c9`;
- `just check-api-source`: **PASS**, receipt
  `3581f1198e414abba8e19e26b2099c18`;
- `python -m pytest -q scripts/test_verify_session_persistence.py`:
  **21/21 PASS**;
- `python -m py_compile`, `cargo metadata --locked`, repository consistency i
  scoped `git diff --check`: **PASS**.

Process E2E wymusza twarde wyjście pierwszego supervisora dokładnie po
trwałym zapisie decyzji, potwierdza pozostawiony terminalny task i aktywny
lease, a następnie
uruchamia drugi supervisor ze wskazaniem nieistniejącego pliku workera. Drugi
proces kończy recovery jako `retry_recovered`, zwalnia lease i ustawia `Queued`;
powodzenie z nieistniejącym workerem dowodzi, że child process nie został
uruchomiony.

## Granica dowodu

Domknięte są oba okna po publikacji decyzji: decision→release i release→apply.
Awaria po potwierdzonym wyjściu workera, ale przed publikacją decyzji, nadal
pozostawia terminalny task z aktywnym lease bez trwałego dowodu zakończonej
rekonsyliacji. Taki orphan wymaga osobnej, jawnej procedury operatora lub
trwałego process-exit receiptu; supervisor nie przejmuje go na podstawie wieku.
Nadal otwarte są automatyczny wybór kolejnego attemptu, zdalny
heartbeat/`StopAck`, konfigurowalna pula oraz process E2E FDM GPU i obu lane'ów
FEM.

Ten przyrost podnosi P3 do około **69%**, P5 do około **30%**, a cały plan do
około **33%**.
