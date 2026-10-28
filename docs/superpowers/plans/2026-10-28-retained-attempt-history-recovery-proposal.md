# Propozycja recovery z zachowaną historią ponowień

Status: **zakres zatwierdzony przez użytkownika 28.10.2026; implementacja i weryfikacja w toku, jeszcze niewdrożone**.
Baza audytu: `34e974a4ad7c09295abe5a6bd0f7cde805daf1e7`.
Cel: przywrócić naszą grupę 3203 bez usuwania historii i bez ponownego Solve.

## Potwierdzona przyczyna

Python `scripts/docker_volume_container_recovery.py::_ledger_and_store_snapshot`
i native `crates/fullmag-session/src/runtime_service/retained_terminal_runs.rs`
akceptują tylko claim bieżącej próby z końcowego katalogu. Native sprawdza to
w `read_solver_leases`, `validate_task_admissions`, `read_coordinator_journals`,
`read_worker_inboxes` i `validate_terminal_streams`. Odmowę utrwala test
`historical_compute_attempt_leases_and_admissions_are_outside_v3_scope`.
`crates/fullmag-session/src/runtime_service.rs::validate_manual_held_union`
używa tego samego walidatora także dla v4. Usunięcie porównania attempt/epoch
w Pythonie nie naprawi kontraktu i nie jest proponowane.

Rzeczywisty odczyt obejmował 38 rezerwacji w przypiętych runach terminalnych.
Dwie zwolnione rezerwacje odnoszą się do wcześniejszej próby tego samego tasku:

| Run | Historia | Aktualny katalog |
|---|---|---|
| `run-live-255fa587f4084d187d7e690f4d75076a4889fcf685a044ee02e4e8486a06b2da` | `attempt-35f480a608e6427ebebf02d127657ab8`, epoch 1, released | `attempt-37daccd7aa964bc88f6143ad9613ba06`, epoch 2, succeeded |
| `run-surface-prepared-source-20261025-02` | `attempt-56642ebad7874adfa9c9367a8945e319`, epoch 1, released | `attempt-33df698e66944c87b9409baf0200c887`, epoch 2, succeeded |

W obu historiach znajdują się typed admissions obu prób, inbox starego
claimu, retry decision `explicit_operator_request/retry` oraz worker exit
receipt z `exit_code=1`, `status_success=false`, `timed_out=false`.
Pierwszy exit dotyczy błędu zgodności flux/J; drugi unsupported run-start
policy. Jest to wykazana obecność dowodów, **nie ich pełna kwalifikacja**.
Pełne metadane i treści pozostają w wolumenie kontrolnym grupy pod
`verification/v4-store-inventory-proposal-20261028/historical-attempt-records-readonly.json`.
Nie publikujemy tokenów lease w raporcie.

## Warianty i rekomendacja

1. Rozszerzyć istniejący v4. Mniej nowego kodu dyspozytora, lecz zmiana
   znaczenia dotychczasowej wersji; starszy runtime nie rozumie tej historii.
2. **Dodać jawne v5 (rekomendowane).** Zachować odmowy i zachowanie v1–v4,
   wymagać capability v5, przypiętego pakietu i jawnego żądania. Więcej
   walidacji kompatybilności, ale brak cichej zmiany istniejących żądań.

Nie proponujemy kasowania starych leases/admissions, podmiany attempt IDs,
zmian katalogów ani przeniesienia wyników do nowej sesji w celu ominięcia
recovery.

## Konkretny zakres proponowanego v5

Pierwszy obsługiwany zakres: przypięte runy terminalne z bieżącą próbą i
zamkniętymi wcześniejszymi próbami zakończonymi błędem, bez opublikowanych
artefaktów historycznych. Dwie istniejące held-manual próby nadal są
walidowane obecnym kontraktem; nie wolno ich uruchomić automatycznie.
Inne rodzaje historii nadal wymagają odmowy.

Walidacja musi:

1. Zbudować pełny, ograniczony inventory po tożsamości
   `(run_id, task_id, attempt_id, ownership_epoch, resource_id)` i tokenie lease.
   Przypiąć digesty historycznych admission, lease, inbox, journal, retry
   decision i exit receipt. Dodatkowe lub zmienione dowody powodują odmowę.
2. Sprawdzić każdy claim oddzielnie istniejącymi typowanymi walidatorami.
   Nie porównywać starych wpisów z bieżącym attempt, lecz nie pomijać żadnego
   z nich. Wspólne walidatory pozostają właścicielem semantyki.
3. Powiązać typed admission z released lease przez istniejące
   `same_lease_identity`; sama flaga released nie wystarcza.
4. Zweryfikować sekwencje journal, payload digests, identities, applied
   commands oraz brak pending. Odtworzyć rzeczywisty terminalny checkpoint
   każdej starej próby; nie wytwarzać go z obecnego katalogu.
5. Powiązać zamknięcie z jednoznacznym worker exit receipt oraz właściwą
   tożsamością procesu i heartbeat. Brak dowodu wyjścia albo niejednoznaczność
   oznacza odmowę, nie domniemanie zakończenia.
6. Sprawdzić jawną decyzję retry oraz uporządkowany łańcuch admission/epoch
   do bieżącej przypiętej próby, bez luk, duplikatów i obcych claimów.
7. Zachować obecną kontrolę bieżących artefaktów/CAS. W pierwszym zakresie
   historyczne opublikowane artefakty są odrzucane; częściowe dane są
   zachowywane, nie usuwane ani promowane do wyników.
8. Ponowić wszystkie obserwacje pod właściwą blokadą przed mutacją. Dopiero
   kompletny native preview może dopuścić istniejącą procedurę recovery.

Dla zamknięcia po awarii należy ponownie wykorzystać istniejące
`retained_terminal_runs.rs::validate_unapplied_heartbeat_suffix` oraz
`validate_final_heartbeat_reconciliation`. Nie wymagać arbitralnie wszystkich
commands w applied ani równości heartbeat we wszystkich rekordach. Istniejący
wyjątek obejmuje dokładnie jeden końcowy unapplied Heartbeat, pending=null,
terminalny Failed i potwierdzone wyjście procesu z niezerowym kodem. Receipt
musi odpowiadać released lease; suffix oraz terminal checkpoint zachowują
heartbeat lease+1, a wcześniejsze heartbeat wymagają ACK. Pozostałe suffixy
nadal powodują odmowę. Reguły te stosuje się do właściwego claimu historycznego,
bez zmiany końcowego katalogu bieżącej próby.

W odczytanych historiach: applied/commands 170/171 i 2/3; heartbeat receipt
168 i 0, a terminal checkpoint odpowiednio 169 i 1; pending=null oraz
terminalny Failed. Są to wejścia obowiązkowych regresji, nie deklaracja,
że wszystkie warunki powiązania, ACK, CAS i procesu zostały już zaliczone.

Budżet v5: do 128 runów, 32768 plików store, 4096 odwiedzonych katalogów,
30 s współpracującej kontroli przejścia; zewnętrzne timeouty pozostają.
Maksymalnie 128 historycznych claimów łącznie. CAS: istniejące 128 MiB na
obiekt i 1 GiB łącznie. Limit 8192 wpisów pojedynczego artifact catalog
pozostaje. Przekroczenie limitów odrzuca całość, nie obcina danych.
Wcześniejszy patch inventory v4 pozostaje niezastosowany; jego 157 testów
nie dowodzi poprawności nowego v5. Przy wyborze v5 nie należy równocześnie
zmieniać limitów starszego v4.

## Weryfikacja wymagana przed rzeczywistym recovery

- Wykonywalne regresje dwóch failed→retry→succeeded historii.
- Odmowy: brak/aktywny lease, obcy token/resource, brak lub niezgodny exit,
  uszkodzony digest, pending, luka sekwencji/epoch, duplikat claimu, brak
  retry decision, historyczny published artifact, dodatkowy plik, przekroczony
  budżet, zmiana danych pomiędzy preview i użyciem.
- Wszystkie dotychczasowe odmowy historycznych prób w v1–v4 pozostają.
- Zgodność Python/native request/capabilities i odrzucenie starego binarium.
- Managed build w stałym backendzie naszej grupy; lokalne kompilowanie
  unit tests pozostaje zabronione, wymagane testy Rust przez zatwierdzone CI.
- Rzeczywisty odczyt/preview całych 43 runów i kontrola niezmienności wyników.
  Dopiero po wszystkich pozostałych bramkach: zarządzany restart bez Solve.

Pozostałe dowody izolacji Windows/WSL (Desktop aliases i topologia LX)
pozostają osobnymi, obowiązującymi kontrolami. Propozycja nie autoryzuje ich
pomijania, zwiększenia limitów, zatrzymywania obcych usług ani usuwania danych.
Nie zmienia także kwalifikacji naukowej pola anteny.

## Wymagana decyzja

Proponowane zatwierdzenie obejmuje implementację i weryfikację powyższego
v5 oraz późniejsze użycie wyłącznie w naszej grupie 3203 po przejściu pełnego
preview. Jest to nowy zakres wersjonowanej bramki, nie wykonanie wcześniej
zatwierdzonego patcha LX. Zgodnie z przekazanym przez użytkownika AGENTS.md
§8 zmiana takiego kontraktu wymaga decyzji. Do tego czasu pozostają tylko
odczyty, przygotowanie i niezależne prace nad anteną.

Przegląd niezależny wykazał konieczność jawnego zachowania istniejącego
wyjątku końcowego heartbeat; doprecyzowano go powyżej na podstawie odczytu
obu funkcji produkcyjnych. Pozostały zakres i status propozycji potwierdzono.

Decyzja użytkownika po przeglądzie: „Tak, wdroż i zweryfikuj recovery v5”.
Nie jest wymagana ponowna zgoda na opisany zakres; pozostają wszystkie
wskazane bramki wykonania i ograniczenia pozostałych operacji.


## Weryfikacja implementacji — 28.10.2026

- Launcher rozróżnia `fullmag.retained-recovery-build.v1` (wymagane native v4)
  i `fullmag.retained-recovery-build.v2` (jawne historie i wymagane native v5).
  Starszy pakiet v4 nie wystarcza do buildu dla żądania v5.
- W helperze własnej grupy Docker przeszły 164 testy Python: zero błędów,
  niepowodzeń i pominięć. Dowody: `verification/recovery-v5-20261028/tests.json`
  oraz `tests.log` w wolumenie kontrolnym. Komunikaty atrap o publikacji nie
  oznaczają zmiany rzeczywistego runtime.
- Rzeczywisty odczyt `_ledger_and_store_snapshot` z przypiętymi historiami
  obu runów zakończył się poprawnie w 28,794 s. Dowód:
  `verification/recovery-v5-20261028/actual-store-readonly.json`.
  Pełne skróty plików historycznych runów i poprzednie piny są zapisane w
  `inputs-v5-draft.json` w tym samym katalogu. Jest to kontrola tylko do odczytu,
  nie natywna kwalifikacja ani wykonane recovery.
- Parser Rust w istniejącym kontenerze przyjął pięć zmienianych plików
  (`rustfmt --emit stdout`, bez zapisu). Nie kompilowano lokalnych testów Rust;
  kontrola składni nie stanowi weryfikacji typów ani wykonania walidatora.
- Do zakończenia pozostają przegląd całości natywnej implementacji, kompilacja
  zarządzanym buildem oraz natywny preview rzeczywistych dowodów. Nadal obowiązują
  osobne bramki izolacji ścieżek Windows i ich limity. Backend nie został
  uruchomiony, nie wykonano Solve, zachowane wyniki nie zostały zmienione.


Pełny preflight `prepare_abrupt_stop_proof` po wdrożeniu źródeł odmówił po
6,650 s: `foreign Windows Docker Desktop bind has unresolved storage identity`.
Dowód: `verification/recovery-v5-20261028/full-preflight-readonly.json`.
Jest to niezależna bramka identyfikacji współdzielonego storage; pozytywny
snapshot historii nie upoważnia do jej pominięcia. Nie wykonano buildu,
restartu ani recovery. Zmiany v5 pozostają niezakwalifikowane natywnie.


## Dalsza diagnostyka aliasów i uruchomione CI

Dla commita `311c597505fc648265414aa7061fc7937aa7ea71` uruchomiono
[bootstrap / rust](https://github.com/MateuszZelent/fullmag/actions/runs/40653088821).
Kontrola przeglądarkowa zakończyła się sukcesem; stan Rust należy sprawdzić
w tym konkretnym runie przed uznaniem kompilacji lub testów za zaliczone.

Diagnostyka tylko do odczytu dwóch mountów wykazała, że
`/run/desktop/mnt/host/d/git/storage` w obecnym daemonie ma typ `tmpfs`,
device 111 i inode 861. Niezależny widok `/mnt/d/git/storage` ma typ `9p`,
device 118 i inode 20547673300136202. Metadane przed i po były zgodne.
Dowód: `verification/recovery-v5-20261028/desktop-alias-pair-diagnostic-v2.json`.
Nie jest to dowód tożsamości aliasów ani izolacji i nie wolno na tej podstawie
przepisać prefiksu i dopuścić restartu.

Rozważone drogi: (1) samo przepisanie prefiksu — odrzucone przez powyższą
obserwację; (2) dowód tożsamości fizycznej — obecna para go nie spełnia;
(3) odtworzenie mountów cudzych kontenerów — zmienia cudze środowisko;
(4) usunięcie dokładnie wskazanych zakończonych kontenerów — wymaga osobnego
przeglądu warstw i zgody, bez usuwania mountowanych danych ani wolumenów.
Nie zmieniono żadnej bramki ani kontenera.

Metadane sześciu zakończonych kontenerów zapisano jako
`stopped-legacy-containers-inspect.json` i `stopped-legacy-containers-review.json`
w tym samym katalogu kontrolnym. Próba odczytu zmian pierwszej warstwy przez
`docker diff` przekroczyła limit obserwacji 30 s; nie dowodzi to braku danych.
Przegląd usunięcia nie jest kompletny i żadnego kontenera nie usunięto.

Źródło kontraktu mountów:
https://docs.docker.com/engine/storage/bind-mounts/ — źródło jest rozwiązywane
na hoście demona; Docker Desktop pośredniczy w dostępie do plików Windows.


CI 40653088821 skompilowało testy sesji, lecz etap recovery zakończył się
wynikiem 17 zaliczonych / 2 niezaliczonych. Pełny log zachowano w kontrolnym
`ci-rust-40653088821.log`. Porównanie snapshotów wykazało zmianę wyłącznie
`WRITER.owner.json` wskutek nabycia/zwolnienia blokady przez wrapper testu.
Druga awaria wystąpiła podczas tworzenia fixture: brak schematu protokołu
komendy, przed wywołaniem walidatora.

Poprawka przenosi porównanie wszystkich bajtów pod jedną utrzymywaną blokadę
(nie pomija żadnych plików) i używa poprawnej koperty oczekującej komendy
z fixture dziennika. Kod produkcyjny pozostaje bez zmian. Parser przeszedł;
wynik ponownego wykonania tych regresji musi pochodzić z kolejnego CI.
