# P4-C/P5-D — trwały journal komend aktywnego workspace’u

Data: 28.09.2026
Status: produkcyjny target kompiluje się; recovery runtime i testy jednostkowe pozostają nieuruchomione

## Problem

Panel Operations czytał zasób `simulation/commands`, ale jego backendowym
źródłem był wyłącznie procesowy `VecDeque<TrackedCommandRecord>`. Restart API
usuwał historię komend, resetował sekwencję i nie pozwalał odróżnić operacji
terminalnej od operacji o nieznanym wyniku. Trwały `coordinator_journal.v1`
dotyczy accepted runów i nie jest właściwym miejscem dla komend lokalnego Live
workspace’u.

## Zrealizowany kontrakt

`SessionStore` ma osobny, lokalny `live_command_journals/<session_id>`:

- publikacja przechodzi przez istniejący native single-writer lock;
- journal jest kompletnym, ograniczonym do 256 wpisów snapshotem;
- zapis używa immutable generation i atomowego wskaźnika `CURRENT`;
- niepewny wynik po `rename` jest rozstrzygany przez dokładny readback bajtów i
  ponowienie bariery trwałości;
- poprzednie generacje są usuwane dopiero po trwałej publikacji nowego
  `CURRENT`; błąd kompakcji nie cofa opublikowanego stanu;
- ścieżki przechodzą przez containment oraz ochronę przed linkiem/reparse.

Dokument `fullmag.live_command_journal.v1` wiąże wpisy z dokładnym
`session_id`, `run_id` i `started_at_unix_ms`. Walidacja wymaga dodatniej,
monotonicznej rewizji, maksymalnie 256 rekordów, dodatnich ściśle rosnących
sekwencji oraz unikalnych, niepustych `command_id`.

Submit, lokalne odrzucenie, dispatch do runnera, raport failure oraz
rekoncyliacja z frame’em runtime publikują journal przed zmianą projekcji w
pamięci. Rewizja zasobu kolejki pochodzi z monotonicznej rewizji journalu, więc
zmiana statusu bez zmiany liczby wpisów invaliduje Operations.

## Recovery i brak podwójnego wykonania

Pierwszy zaakceptowany frame po restarcie odtwarza journal wyłącznie dla
dokładnej tożsamości sesji i runu. Najpierw rekoncyliuje wpisy z dowodami tego
frame’u; wpisy terminalne pozostają bez zmian. Dopiero nadal niepotwierdzone
`queued`, `accepted`, `dispatched` i `running` przechodzą do `failed` z kodem
`api_restarted_before_terminal_command_ack`.

Takie wpisy nie wracają do kolejki runnera. Po utracie procesu ich wynik jest
nieznany, więc automatyczny replay mógłby wykonać mutację drugi raz. Operations
i Problems zachowują historię oraz pokazują przerwanie; operator może podjąć
nową decyzję na podstawie stanu runtime.

## Weryfikacja

| Kontrola | Wynik |
|---|---:|
| `cargo check -p fullmag-api --bin fullmag-api` | PASS |
| Kompilacja `fullmag-session` jako zależności produkcyjnej | PASS |
| Ukierunkowane regresje source: replace/reopen oraz restart active/terminal | DODANE |
| Testy jednostkowe | NOT RUN — aktywny zakaz kompilowania i uruchamiania testów jednostkowych |
| Managed restart API/runner | NOT VERIFIED — koordynator Docker Desktop nie odpowiada |
| `git diff --check` | PASS |

Kompilacja zgłosiła wyłącznie wcześniejsze ostrzeżenia w innych modułach.
Nie jest dowodem recovery procesu ani managed runtime.

## Granica etapu

Przyrost zamyka procesową ulotność kolejki komend Live i daje panelowi
Operations trwałe źródło statusu. Preparation, mesh i accepted-run coordinator
zachowują własne typowane zasoby i journale; ich ewentualna wspólna projekcja
zdarzeń nadal wymaga osobnego kontraktu, bez przenoszenia ich do kolejki Live.

Managed restart, native FEM preparation i pełna bramka P4 pozostają otwarte.
Wskaźniki pozostają **P4 50%** i około **49%** dla całego planu.
