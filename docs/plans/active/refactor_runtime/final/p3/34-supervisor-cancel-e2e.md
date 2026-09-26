# P3-B/P5-B — pełne process E2E anulowania

Data checkpointu: 26.09.2026. Baza źródeł:
`master@d394d503631477691805caddca6172527a97c16a`; bieżący przyrost jest
przypięty hashami treści w receiptach.

## Zrealizowany kontrakt

Dedykowana trasa buduje rzeczywiste binaria
`fullmag-api-accepted-supervisor` i `fullmag-api-accepted-worker`, uruchamia je
jako osobne procesy, czeka na trwałe `Started`, a następnie zapisuje operatorską
komendę `Stop`. Kontrolowany hook testowy tworzy okno po `Started` i przed
pierwszym efektem solvera; działa wyłącznie przy
`FULLMAG_ENABLE_TEST_HOOKS=1`, ma limit 30 sekund i pozostaje nieaktywny w
normalnym wykonaniu.

Supervisor obserwuje `Stopping`, kończy dokładny proces potomny, czeka na jego
exit, publikuje `Stopped`, przeprowadza task do `Cancelled` i zwalnia ostatnią
wersję dokładnego lease. Test potwierdza brak katalogu artefaktów sukcesu oraz
pozostawienie trwałego pending `Start` bez fałszywego oznaczenia jako applied.
Ponowny `Stop` po terminalnym anulowaniu jest odrzucany.

Naprawiono również odpowiedź pierwszego żądania `Stop`. Rewizja katalogu jest
teraz zwracana z tej samej operacji, która zapisuje journal i jego projekcję,
zamiast z dodatkowego odczytu po commicie. Chwilowa kontencja z heartbeat nie
może więc zamienić skutecznej mutacji w błąd klienta i wymusić niejednoznacznego
retry. Replay korzysta z rewizji odczytanej razem z odzyskiwanym koordynatorem.

## Weryfikacja

- `just verify-runtime-control`: **3/3 PASS**, receipt
  `b86b7e9ad9da4bbab3872db490ee9ce9`;
- `just verify-api-accepted-supervisor-cancel-e2e`: **1/1 PASS**, receipt
  `d84e4c10a9c84f6ea99a30e04ff6ddfe`;
- `just verify-api-accepted-supervisor-e2e`: **1/1 PASS**, receipt
  `13484c195ffb468faf618c7be3f5f2e6`;
- `just check-api-source`: **PASS**, receipt
  `83d7366f08b649da9f4f077b4d201719`;
- `python -m pytest -q scripts/test_verify_session_persistence.py`:
  **18/18 PASS**;
- `python -m py_compile scripts/verify_session_persistence.py
  scripts/test_verify_session_persistence.py`: **PASS**;
- scoped `git diff --check`: **PASS**.

Pierwsze próby celowo pozostały czerwonym dowodem diagnostycznym: ujawniły
niejednoznaczny odczyt rewizji po trwałym `Stop` oraz zbyt agresywny interwał
heartbeat 100 ms w teście. Końcowe E2E używa 500 ms i wykonuje kilka odnowień
lease w trzysekundowym oknie anulowania.

## Granica dowodu

Dowód obejmuje lokalny supervisor i ograniczony FDM CPU/double/strict. Nie
kwalifikuje fizyki ani wydania. Nadal otwarte są anulowanie przed `Start`,
automatyczna polityka retry, recovery osieroconego procesu po awarii
supervisora, zdalny heartbeat/`StopAck`, scheduler/pula oraz process E2E FDM GPU
i obu lane'ów FEM.

Ten przyrost podnosi P3 do około **66%**, P5 do około **21%**, a cały plan do
około **30%**.
