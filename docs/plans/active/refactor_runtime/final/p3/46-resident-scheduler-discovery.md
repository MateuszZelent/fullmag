# P3/P5 — rezydentne wykrywanie nowych runów

Data checkpointu: 27.09.2026.

## Zakres

`fullmag-api-accepted-scheduler` otrzymał jawny tryb `--resident true`. Proces
nie kończy wtedy pracy po pustym skanie store i może wykryć run utworzony po
starcie schedulera. Tryb jest dozwolony wyłącznie razem z:

- `--discover-runs true`,
- niepustą tożsamością `--pool-id`,
- `--max-idle-polls 0`,
- dodatnim `--idle-poll-milliseconds`.

`--max-tasks` pozostaje dodatnim, obowiązkowym ograniczeniem wykonania. Ten
przyrost nie wprowadza procesu działającego bez końca ani nowego protokołu
zatrzymania. Summary procesu publikuje `resident`, liczbę pustych skanów,
wykonane taski i końcową sekwencję checkpointu puli.

Scheduler nie próbuje już kolejkować taska `Accepted`, gdy katalog runu jest
już widoczny, ale immutable preparation receipt nie został jeszcze
opublikowany. Taki stan jest chwilowo niegotowy i zostaje ponownie oceniony w
następnym skanie. Obecny, lecz błędny lub niespójny receipt nadal kończy
operację błędem; poprawka nie zamienia uszkodzenia durable state w retry.

## Dowód procesu

Managed E2E startuje scheduler po utworzeniu dwóch runów, czeka na ich sukces,
potwierdza, że proces przeżywa okres bezczynności, a następnie przez HTTP tworzy
i materializuje trzeci run. Ten sam proces wykrywa nową pracę, doprowadza ją do
`Succeeded` i kończy się po trzech taskach. Checkpoint puli osiąga sekwencję 3.

| Bramka | Wynik | Receipt | Content SHA-256 |
|---|---:|---|---|
| Resident discovery E2E | PASS | `05699005c4084b8aac9f6b57ac498dfa` | `0ea304a8d92f2b02cf5171c37f82dc106e33d174dc19c71951f808ba0b7bcf4b` |
| Statyczna pula zasobów | PASS | `7060b688339047f990acbe567846d95f` | `0ea304a8d92f2b02cf5171c37f82dc106e33d174dc19c71951f808ba0b7bcf4b` |
| Trwały kursor fairness | PASS | `fb85c57255594ee79bcb12c033586006` | `0ea304a8d92f2b02cf5171c37f82dc106e33d174dc19c71951f808ba0b7bcf4b` |
| Rejestr tras Python | 30/30 PASS | lokalna bramka kontraktu | bieżący diff |

Wszystkie trzy managed receipty mają `source_changed_during_run=false`.

Podczas walidacji wykryto dwa osobne problemy testowo-produkcyjne. Panika testu
mogła pozostawić proces potomny i blokować binarium na Windows; nowy guard
wykonuje kill oraz wait przy każdym wyjściu ze scope. Drugi problem był
rzeczywistym wyścigiem katalogu z preparation receiptem i został naprawiony na
granicy wyboru taska.

## Granica checkpointu

To jest **ograniczone rezydentne wykrywanie**, a nie ukończona produkcyjna
usługa schedulera. Nadal brakuje:

- jawnego protokołu graceful shutdown i drain,
- trybu bez dodatniego limitu tasków wraz z bezpiecznym sterowaniem lifecycle,
- priorytetów, backpressure i dynamicznego członkostwa puli zasobów,
- zdalnego heartbeat/Stop ACK i dowodu zwolnienia urządzenia,
- process E2E pozostałych lane'ów oraz pełnej kwalifikacji release.

Po tym przyroście P3 wynosi około **82%**, P5 około **56%**, a cały plan około
**40%**. Procenty opisują wykonany zakres planu, nie kwalifikację produkcyjną.
