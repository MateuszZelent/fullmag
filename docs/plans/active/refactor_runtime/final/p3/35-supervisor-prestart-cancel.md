# P3-B/P5-B — anulowanie przed uruchomieniem workera

Data checkpointu: 26.09.2026. Baza źródeł:
`master@e88512e84be269761f527451e812132be4356828`; bieżący przyrost jest
przypięty hashami treści w receiptach.

## Zrealizowany kontrakt

Trwały `Stop` można teraz przyjąć zarówno dla taska `Preparing`, jak i
`Running`. Recovery koordynatora odtwarza `Stopping` także wtedy, gdy journal
zawiera `Start` i `Stop`, lecz worker nie zdążył jeszcze opublikować `Started`.
Przyjęcie anulowania w `Preparing` pozostaje fail-closed: wymaga istniejącej,
trwałej komendy `Start` dla dokładnego claimu i epochu.

Supervisor po zajęciu globalnego slotu oraz dokładnego claimu i lease odtwarza
journal przed utworzeniem procesu potomnego. Jeżeli widzi `Stopping` bez
żadnego `Started`, nie uruchamia workera. Publikuje `Stopped`, przeprowadza task
do terminalnego `Cancelled`, zwalnia dokładny lease i slot oraz zwraca status
`cancelled_before_start`. Jeśli `Started` już istnieje albo `Stop` nadejdzie po
spawnie, nadal działa zweryfikowana ścieżka zatrzymania żywego potomka.

Control Room udostępnia akcję Cancel dla `preparing` i `running`. Kontrakt
OpenAPI oraz wygenerowane typy jawnie zwracają `catalog_revision`, dzięki czemu
klient wykonuje revision-driven refetch po przyjęciu komendy.

## Weryfikacja

- `just verify-project-application`: **PASS**, receipt
  `25c663d8ae2045828dcf930e9e9d952d`;
- `just verify-runtime-control`: **PASS**, receipt
  `b55c75521148433b8ab3f335c72a621d`;
- `just verify-api-accepted-supervisor-prestart-cancel-e2e`: **1/1 PASS**,
  receipt `7523e3dbdb8342839a76ec5999407386`;
- kontrolne `just verify-api-accepted-supervisor-cancel-e2e`: **1/1 PASS**,
  receipt `cf9931eb1a7047c188cf342535bcfe93`;
- kontrolne `just verify-api-accepted-supervisor-e2e`: **1/1 PASS**,
  receipt `c219a3edf4bd482c916411f544d4c99b`;
- `just verify-api-accepted-supervisor`: **PASS**, receipt
  `f780001805b54cd9b460475affd99b87`;
- `just check-api-source`: **PASS**, receipt
  `996ef7c2e4a14795a159894b03191234`;
- `just generate-api-openapi`: **PASS**, receipt
  `176c166c7bc34bb5bd390f5aab7c7547`;
- `pnpm --dir apps/control-room typecheck` i `check:api-hygiene`: **PASS**;
- `pnpm exec react-doctor --verbose --scope changed`: **100/100**, bez
  nowych ustaleń;
- `python -m pytest -q scripts/test_verify_session_persistence.py`:
  **19/19 PASS**;
- `python scripts/check_repo_consistency.py`: **PASS**.

## Granica dowodu

Dowód obejmuje lokalny supervisor i ograniczony FDM CPU/double/strict. Nie
kwalifikuje fizyki ani wydania. Nadal otwarte są automatyczna polityka retry,
recovery osieroconego procesu po awarii supervisora, zdalny heartbeat/`StopAck`,
scheduler i konfigurowalna pula oraz process E2E FDM GPU i obu lane'ów FEM.

Ten przyrost podnosi P3 do około **67%**, P5 do około **24%**, a cały plan do
około **31%**.
