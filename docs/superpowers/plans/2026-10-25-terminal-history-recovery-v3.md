# Recovery namespace z zachowaną historią terminalną — kontrakt v3

> Aktualny checkpoint integracji i zakres dowodów: [27.10.2026, PR #247](2026-10-27-antenna-master-pr247-checkpoint.md). Poniższe statusy opisują kolejne historyczne etapy.

## Problem

Owner `0c242b7c-66cf-4d66-b442-50555419d423` pozostaje Unknown, chociaż
odczyt procesów nie wykazuje jego ani schedulerów, a rezerwacje hosta są
zwolnione. Historia obejmuje rzeczywiście wykonane i nieudane zadania.
V1 wymaga pustego magazynu, V2 zachowuje wyłącznie cancelled-before-claim.
Nie wolno przerabiać ukończonych runów na cancelled ani usuwać ich historii.

## Zmiana kontraktu i granice

Istniejący `RuntimeServiceContainerRecoveryRequest` otrzymuje jawny
`runtime_service_container_recovery_request.v3`. Nowe pole
`retained_terminal_runs` zawiera kompletny spis runów. Każdy wpis ma:

| Pole | Typ | Obowiązek |
|---|---|---|
| run_id | istniejący stable ID | jednoznaczny i bez duplikatów |
| run_intent_sha256 | lowercase SHA256 | dokładne bajty intentu |
| run_catalog_sha256 | lowercase SHA256 | dokładne bajty katalogu |
| terminal_evidence_sha256 | lowercase SHA256 | kanoniczny digest dowodów store + host ledger |

Maksymalnie 128 runów i 4096 zadań; zachowane limity wejść/CAS walidatora.
V1/V2 nie akceptują nowego pola, V3 nie miesza go z cancelled-only.
V3 zachowuje istniejący dowód zakończenia kontenerów Docker. Nie rozszerza
wariantu authoritative-absence, który nadal należy wyłącznie do V2.

Natywny core pod istniejącymi blokadami startup/launch/owner oraz writerami
host -> SessionStore ponownie sprawdza dokładny inventory, intent/catalog,
niezmienione CAS oraz terminalne dowody każdego runu. Dotychczasowy
`terminal_run_evidence_value_locked` pozostaje właścicielem kontroli claims,
admissions, exit receipts, leases i uzasadnień no-spawn. Wspólny hostowy
walidator sprawdza prawdziwe release proofs; sama etykieta Failed/Succeeded
nie wystarcza. Stan aktywny lub zmiana dowodu ma skutkować odmową.

Nie ma usuwania wyników, rekoncyliacji lease, ponowienia Solve ani syntetycznego
drain. Wynik skutecznego recovery to istniejący kanoniczny Failed z pustą listą
dzieci, bo teardown kontenera nie dowodzi natywnych exit statusów. Nowy outcome
receiptu: `retained_terminal_runs_recovered`; schemat receiptu pozostaje v1.

## Właściciele kodu

| Odpowiedzialność | Ścieżka + symbol |
|---|---|
| V3 i blokowana operacja | `crates/fullmag-session/src/runtime_service.rs` + `RuntimeServiceContainerRecoveryRequest::validate`, `recover_container_proof_locked` |
| Jawne piny i porównanie dowodu | `crates/fullmag-session/src/runtime_service/retained_terminal_runs.rs` + `validate_retained_terminal_runs` |
| Wspólne intent/catalog/CAS i leases | `crates/fullmag-session/src/runtime_service/retained_cancelled_runs.rs` + `validate_retained_run_inputs` |
| Kanoniczny host/store evidence | `crates/fullmag-session/src/host_resource_ledger.rs` + `terminal_run_evidence_sha256_locked`, `with_terminal_run_evidence_fence` |
| Odczytowy producent pinu | `crates/fullmag-session/src/runtime_service.rs` + `RuntimeServiceConfig::inspect_terminal_run_evidence` |
| Klient z przypiętą konfiguracją | `crates/fullmag-runtime-control/src/runtime_service_client.rs` + `inspect_terminal_run_evidence` |
| Prywatna komenda CLI | `crates/fullmag-cli/src/args.rs` + `RuntimeCommand::ServiceInspectTerminalRun` |

Odczytowa komenda `runtime service-inspect-terminal-run` wymaga surowego SHA
konfiguracji i run_id. Zwraca digest; nie startuje API/runtime i nie zmienia
runu, ownera lub rezerwacji. Służy przygotowaniu pinu, który core recovery
musi później sprawdzić ponownie pod pełnymi blokadami.

## Weryfikacja i stan

Kontrola składni Rust przeszła bez kompilacji testów jednostkowych.
Dodano źródłowe regresje wersji v1/v2/v3, mieszania kontraktów, pustych i
powielonych pinów oraz złych digestów. Testów Rust nie skompilowano ani nie
wykonano. Wymagane są jeszcze build aplikacji, rzeczywisty odczyt dowodów,
negatywne przypadki wejść, integracja launchera i kontrolowane recovery.
Nie zastosowano migracji ownera. Nowe V/J/H i Universe nadal NOT VERIFIED.

## Build i pierwsza rzeczywista diagnostyka

Managed recovery-build `9d5c8a6f61164d299f621a50a9cde42e` zakończył się
succeeded/exit0. Make: 636733 ms; pakowanie: 3599 ms / 24 pliki.
Źródło: `ea1cb3ed807b37c7f21cc13149538d2100bf3317`, snapshot
`30f655a6462697e0086291f4da34b98b0d413d84abc07fd134a326b8673a6b70`.
Kandydat: `.backend-package-candidate-gvcf71no`, receipt SHA256
`be2ef899c8a62cb8594ab02aa1cf26130df21499be2350e72eaf871451366b52`.
Starszy kandydat `.backend-package-candidate-sexe5b82` jest zachowany w
quarantine; bieżącego pakietu nie promowano i nie startowano runtime.

W wolumenie kontrolnym, katalog
`verification/terminal-history-recovery-v3-20261025/`, zachowano odtwarzalny
`inspect-native-history.py`, `native-history-progress.json` i
`native-history-diagnostics.json`. Nowy CLI rzeczywiście uruchomiono, lecz
14/14 odczytów zatrzymała bramka `compiled source commit differs from runtime
provenance`. Obecny backend prawidłowo poświadcza stary pakiet c0f3dc7e;
nieopublikowany klient ea1cb3ed nie może udawać tego pakietu.
Nie uzyskano jeszcze żadnego terminal_evidence_sha256 ani gotowych pinów recovery.
Sprawdzono niezmienność 33 chronionych plików: config/owner/process/provenance,
ledger oraz intent/catalog dla każdego z 14 runów.

Negatywny raw config SHA i niebezpieczny run_id odmówiono we właściwych
bramkach. Przypadek brakującego runu nie dotarł do kontroli istnienia, ponieważ
wcześniej odmówiło provenance; nie jest zaliczonym testem tej gałęzi.
Źródłowych testów Rust nadal nie kompilowano.

Inventory obejmuje 14 terminalnych katalogów. 2027 pinów CAS odpowiada dokładnie
2027 referencjom inputów z zachowanych intentów, o łącznym rozmiarze obiektów
107196388 bajtów. To odczytowy pomiar, nie wykonanie pełnego natywnego walidatora
CAS ani dowód zakończenia procesów. Limitów walidatora nie zmieniono.

## Następna droga weryfikacji

Odrzucono zmianę globalnego provenance działającego API oraz osłabienie bramki
storage. Potrzebny jest osobny kanoniczny widok zbudowanego kandydata dla
odczytowej diagnostyki: ten sam obraz i grupa, kandydat widoczny jako
`/opt/fullmag/package`, jego zgodne provenance wyłącznie w technicznym
podkatalogu kontrolnym, bez kompilacji/API/Solve. Dane hosta pozostają te same;
natywne blokady i kontrola niezmienności są obowiązkowe. Taki helper musi zostać
zintegrowany z zarządzaną receptą i przetestowany przed użyciem; sama ta propozycja
nie jest działającą trasą ani zgodą na zmianę provenance starego API.

Docker dokumentuje `volume-subpath` dla montowania istniejącego podkatalogu
wolumenu: [Volumes](https://docs.docker.com/engine/storage/volumes/#mount-a-volume-subdirectory).
Obsługę wprowadzono w Engine 26.0; wersję rzeczywistego silnika trzeba sprawdzić
przed wdrożeniem helpera. Pakiet kandydata można odczytywać, zachowując globalny
mount i provenance dotychczasowego backendu bez zmian.

Odczyt silnika na tym hoście: Docker Engine `29.7.2`, API `1.55`.
Wersja nie jest blokadą `volume-subpath`; sama nowa recepta nadal NOT VERIFIED.

## Zarządzany widok diagnostyczny kandydata

Przygotowano `just docker-dev-candidate-history` oraz kontroler
`scripts/docker_candidate_history.py`. Recepta wymaga pełnych pinów źródła,
backendu, obrazu, zakończonego recovery-build i receiptu kandydata. Nie buduje,
nie promuje pakietu i nie uruchamia API ani Solve.

Kontroler sprawdza terminalną authority builda, marker Ready i pełny inventory
kandydata oraz diagnostyczny stan donora. BuildControl serializuje operację
`candidate-history`. Techniczny helper tej samej grupy otrzymuje:

- readonly subpath istniejącego package volume pod `/opt/fullmag/package`;
- readonly główny control volume oraz osobny zapisywalny subpath operacji jako
  `/opt/fullmag/control/backend`, aby kanoniczny producent wystawił provenance
  tego kandydata bez zmiany globalnego provenance donora;
- oryginalne dane i grant Linux, bez zmiany owner tokenów, markerów lub `.env`;
- RW SessionStore i host ledger wyłącznie dla wymaganych natywnych blokad.
  Bajty całego naukowego SessionStore (bez technicznego aliasu runtime-services)
  są porównywane przed odczytami i po nich; owner/process/config/provenance i
  ledger donora również muszą pozostać identyczne;
- brak `/build`, socketu Docker i sieci; root filesystem readonly. Sterownik
  CUDA jest dostępny do załadowania zależności CLI. W WSL dopuszczony jest
  most `/dev/dxg`; raport zapisuje faktyczną topologię, bez twierdzenia o izolacji GPU.

Package/provenance w helperze przechodzą dotychczasową bramkę storage bez
zmiany walidatora Rust. Natywna komenda pozostaje odczytowa. Wynik przechowuje
rozróżnienie sukcesu diagnostyki i dowodu każdego runu; brakujący lub niespójny
run nie tworzy częściowej listy gotowej do recovery. Trzy negatywne przypadki
muszą dotrzeć do oczekiwanych bramek, nie tylko zwrócić dowolny błąd.

Audyt writerów: host nie kopiuje źródeł/pakietów ani nie zapisuje artefaktów
buildu do storage. Scope, logi, prywatne provenance i wynik pozostają w control
volume. Pakiet jest RO. Kontroler nie ma operacji usuwania, rotacji, promocji,
admission ani zmiany stanu ownera. Helper jest efemeryczną diagnostyką, a nie
alternatywnym builderem lub runtime aplikacji. Timeout zachowuje nieznany wynik
operacji BuildControl; nie powoduje automatycznego ponowienia.

Interpretowane regresje nowej topologii i stałego argv oraz dotychczasowego
recovery: 30 PASS (`candidate-view-tests.json` w katalogu verification v3).
Nie kompilowano testów native. Rzeczywisty wynik nowej recepty wymaga jeszcze
odczytu terminalnego receiptu; nie utożsamiamy testów topologii z działającym
preflightem danych ani z recovery.

## Diagnoza środowiska sterownika WSL

Pierwsza próba ujawniła brak zachowania VolumeOptions.Subpath; poprawiono
kopiowanie aliasów i dodano regresję. Kolejna zachowała 5737 plików store,
lecz 14 komend zatrzymało ładowanie libcuda.so.1, zanim weszły do CLI.
Runtime NVIDIA z NVIDIA_VISIBLE_DEVICES=none dostarczył bibliotekę, lecz
WSL udostępnia /dev/dxg również w tej konfiguracji. To nie dowodzi braku
dostępu do GPU. Kontroler zapisuje kernel i urządzenia, dopuszcza wyłącznie
pustą listę albo dxg na kernelu Microsoft, i nadal uruchamia tylko stałą
komendę odczytową. Nie uruchamia API, workera ani Solve.

## Wynik rzeczywistej próby i checkpoint

Próba `d6be2a86e8824ed9a232d6087b36bc6d` zakończyła się
`failed-confirmed`, bez promocji, recovery, API i Solve. Sterownik załadowano;
raport potwierdza kernel Microsoft WSL2 i wyłącznie most `dxg`.
`native-observations.json`, `store-before.json` i `store-after.json` pozostają
w `candidate-history/attempts/d6be2a86e8824ed9a232d6087b36bc6d` wolumenu
kontrolnego grupy.

Porównanie wszystkich plików wykazało dokładnie jedną zmianę:
`WRITER.owner.json` w korzeniu SessionStore. To doradczy zapis blokady
technicznej, tworzony przez kanoniczny writer przy wejściu i wyjściu.
Pozostałe 5736 plików, w tym wyniki naukowe, zachowały identyczne SHA256.
Nie osłabiono kontroli inventory: helper nadal odmawia przy tej zmianie.
Dodatkowa kontrola donora potwierdziła niezmienione przypięte bajty
owner/process/config/provenance i ledgera (`donor-retention.json`).

Każdy z 14 runów odmówił w bramce `Linux native probe is not bound to this
owner/mount/namespace`. Dowód `.linux-native-probe.json` został rzeczywiście
wystawiony dla namespace backendu; nowy namespace nie może go dziedziczyć.
Nie zmieniono tego dowodu, nie sfałszowano namespace ani wyników testów probe.
Negatywne przypadki złego config SHA i niebezpiecznego run_id trafiły we
właściwe bramki; brakujący run pozostaje niezweryfikowany z powodu wcześniejszej
odmowy namespace. Nie ma gotowych pinów recovery (0/14).

Ta recepta jest narzędziem diagnostycznym z zachowaną odmową, a nie
zakwalifikowaną trasą odczytu historii. Dalsza poprawka wymaga kanonicznego,
izolowanego producenta probe dla namespace diagnostyki bez nadpisania dowodu
działającego backendu oraz rozdzielenia kontroli technicznych metadanych writera
od niezmienności naukowych plików. Nie ponawiać tej samej trasy bez takiej zmiany.

W tym checkpointcie: 5 interpretowanych regresji topologii/argv PASS, parser
Python PASS, `git diff --check` PASS. Nie kompilowano testów Rust.
Fetch `origin/master` wskazał `f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48`,
który jest już przodkiem brancha zadania: brak nowych commitów do scalenia.
Build aplikacji pozostaje wcześniejszym dowodem; nie jest dowodem recovery
ani udanego Solve Universe.

## Izolowany prawdziwy probe — wynik poprawki

Dotychczasowy producent `docker/all-in-one/linux_native_probe.py` otrzymał
opcjonalny `evidence_path`, wymagający zweryfikowanego restart readback.
Zwykłe wywołania zachowują dotychczasową atomową publikację. Diagnostyka
zapisuje dowód do jednego istniejącego pliku operacji w control volume,
bez zmiany inode. Ten sam plik jest zamontowany jako readonly file subpath
pod kanonicznym `/state/.linux-native-probe.json` wyłącznie w helperze.
Nie skopiowano starego wyniku checks ani namespace: producent ponownie
wykonał rzeczywiste fsync, atomic replace, process lock, no-follow, SQLite
i restart readback na rzeczywistym `/state`. Natywny walidator nie zmienił się.
Źródło producenta i runtime kontrolera są przypięte przez SHA256 w receipcie.

Operacja `4d63e56a4948445984f7a1150a1aa59e` zakończyła się succeeded,
wynik diagnostyki passed: 14/14 runów i 3/3 negatywne bramki.
Gotowe piny są w `candidate-history/attempts/4d63e56a4948445984f7a1150a1aa59e/result.json`
w wolumenie kontrolnym grupy. Nie są uprawnieniem do pominięcia ponownej
walidacji pod blokadami w core recovery.

5736 plików zachowało identyczne SHA256. Jedyną zmianą store jest
korzeniowy `WRITER.owner.json`, sprawdzony osobno jako `fullmag.writer.v1`
z `released=true`; zmiana dowolnej innej ścieżki, także podobnie nazwanego
pliku w runie, nadal powoduje odmowę. Runtime owner, config, process receipt,
ledger, globalne provenance i domyślny probe backendu pozostały identyczne.

19 interpretowanych regresji producenta i diagnostyki PASS. Potwierdzono
70 plików starego wyniku V/J/H, 2 archiwa i 6 chronionych plików błędnej
próby oraz niezmieniony FMS użytkownika. Dowód retencji:
`verification/terminal-history-recovery-v3-20261025/retention-after-private-probe.json`.
Nie kompilowano testów Rust, nie promowano pakietu i nie wykonano nowego Solve.
Następny krok: integracja konsumenta v3 z kontrolowanym zatrzymaniem
diagnostycznego API, świeżym dowodem teardown i ponowną natywną kontrolą
całej terminalnej historii. Backend i Universe nadal nie są przywrócone.

## Konsumenci v3 i odczytowy preview stopu Unknown

Istniejący `scripts/docker_volume_container_recovery.py` rozpoznaje jawny
request v3, waliduje pełne piny terminalne i przekazuje je do istniejącego
producenta requestu oraz odczytowego snapshotu store/ledgera. Snapshot sprawdza
dokładny inventory i bajty intent/catalog; nie zastępuje natywnej walidacji
`terminal_evidence_sha256` pod blokadami. V1/V2 nie przyjmują pinów v3,
V3 nie miesza pinów cancelled-only, a absence attestation pozostaje V2-only.

Kod image-owned `docker/all-in-one/runtime_service.py` rozpoznaje ten sam
outcome `retained_terminal_runs_recovered` i zachowuje wymaganie rzeczywistego
teardown. Jest to zmiana źródeł obrazu, jeszcze niewdrożona do obecnego
kontenera; wymaga zarządzanego buildu i weryfikacji przed użyciem recovery.

Stop-probe w `scripts/docker_volume_stop_diagnostic.py` ponownie używa
istniejącej walidacji dokładnej tożsamości Unknown vs zachowany Ready pin.
To wyłącznie kontrola tożsamości: oddzielnie nadal wymagane są zgodny fence
API i incarnation, zdegradowana odpowiedź HTTP, pełny census /proc oraz
nieobecność ownera, schedulerów i workerów. Stop nie publikuje Failed ani
Drained i nie zwalnia rezerwacji; legacy pole `failed_owner` zawiera
niezmieniony dokument z rzeczywistym `state=unknown`.

Odczytowy rzeczywisty preview PASS: API PID 3274, health degraded, owner
3282 oraz dzieci 3285/3286 nieobecne. Nie wysłano sygnału stop. Dowód:
`verification/terminal-history-recovery-v3-20261025/unknown-diagnostic-stop-preview.json`
w wolumenie kontrolnym grupy. SHA256 serializowanego probe:
`4392d452080f0613b1eebc300e94bc77ead46066d531e3dc7e05a97a388d73ce`.

104 testy interpretowane PASS: diagnostyczny stop, dotychczasowy stop failed,
recovery-build i host/runtime recovery. Wykryto i naprawiono nieaktualny
fixture starego stopu: brak inicjalizacji `_active_operation` i przypięcia
helpera, wymaganych przez bieżący BuildControl. Nie zmieniono oczekiwanej
semantyki zatrzymania ani zachowania nieznanego wyniku.

Nie skompilowano testów Rust, nie przebudowano obrazu, nie wykonano stopu,
promocji, recovery ani Solve. Pozostała integracja istniejącego operator
authorization/prior-stop journal z diagnostycznym stopem i pełnymi pinami v3,
a następnie pełny preview przed zatrzymaniem naszego backendu. Sama obsługa
wersji w klientach nie dowodzi gotowej procedury odtworzenia instancji.

## Integracja operatora z terminalną historią

Dodano jawny `fullmag.docker-container-recovery-operator-authorization.v2`
z kompletnymi pinami `retained_terminal_runs`. Stary operator v1 zachowuje
ścisły zestaw pól. V2 wiąże dokładne SHA256 diagnostycznego journalu,
konfiguracji Compose/runtime, ownera i końcowego process receipt. Wymaga
`stopped-execution-unknown`, `unknown-preserved`, nietkniętych leases i
zachowanego Ready pina; nie przyjmuje fikcyjnego Drained. Poprawiono też
etykietę receiptu stopu, aby dla Unknown nie twierdziła failed-preserved.

Główna istniejąca procedura `recover` przekazuje piny v3 do obu snapshotów
store/ledgera i do natywnego requestu. Dla nowej autoryzacji może początkowo
obejrzeć działający frontend tej samej grupy, lecz backend nadal musi być
zatrzymany. Dopiero po przygotowaniu obrazów i pełnej ponownej walidacji
pod lifecycle lease zatrzymuje dokładnie przypięty frontend. Sprawdza
fingerprint, StartedAt, image/ID i faktyczny exited/PID0/FinishedAt, zapisuje
dowód oraz ponawia pełny preflight. Nieznany wynik stopu zachowuje guard.
Stara ścieżka nadal wymaga obu kontenerów zatrzymanych przed wejściem.

108 interpretowanych testów PASS. Nowe regresje obejmują rozdzielenie
autoryzacji v1/v2, dryft pinów journalu, odrzucenie zmiany inkarnacji
frontendu oraz zachowanie lease przy nieznanym wyniku stopu.
Nie uruchomiono jeszcze stopu, odtwarzania kontenera, recovery ani Solve.
Pełny rzeczywisty preview całej procedury oraz zarządzany build obrazu
pozostają wymagane przed wykonaniem mutacji.

Stan naukowy bez zmian: pełna mapa H wokół anteny na siatce Universe
i jej wizualizacja w UI nie zostały uzyskane. Stare zaakceptowane V/J/H
na małym zbiorze punktów nie są dowodem realizacji tego wymagania.

Dodatkowo oba preflighty porównują dokładną inkarnację backendu z journalem:
ID/obraz, StartedAt, FinishedAt, exit code, exited/PID0 i brak OOM.
Zmiana tych danych blokuje przejście, nawet przy zachowanym container ID.

## Rzeczywiste przygotowanie i kontrolowany stop

`just docker-dev-images` PASS: toolchain cache hit, próba
`cc59b8d4184a4a6da7badd974d396a5d`. Nowy backend image:
`sha256:b3eb4e5bf434b46acd633e4339962bffbcb9b6ccaac59ce5ebf444c4023cc10c`,
image-backend `cec67e6f38c84a8587891636ae4a304a`. To przygotowanie obrazu,
nie build aplikacji ani start solvera.

Dodano brakującą receptę `just docker-dev-stop-diagnostic` ze ścisłym
stałym argv i domyślnym `preview=true`. Preview ma własną fazę i blokadę
BuildControl, odmawia abortowania pending activation i nie wykonuje
rekoncyliacji nieznanego stopu. 6 testów interpretowanych PASS, w tym
komendy złożone, dopisane flagi i zamiana fazy lease.

Pełny rzeczywisty preview `1cbf8ee1c3d046019c0ecd52355b28cb` PASS.
Świeży odczyt historii `9de2d65ff97240bb8cbc386c7c455d9b` PASS 14/14.
Stop `242dc6e0c13340e394a20609ff811525` succeeded: API exit -15, backend
exit 1, execution unknown i owner unknown-preserved. Wynik 1 pochodzi
z zachowanej nieudanej obserwacji runtime; nie jest udanym native drain.
Terminal process receipt SHA256:
`60dbf4b3043e8f430bd6549eef4b99de28bc99e5736aead19b42c391a22dc40c`.

Pełny post-stop preflight `1075dafa520a48a08b51244f9e2ca4df` PASS:
zgodny backend/journal/config/owner i snapshot wszystkich 14 wejść.
Autoryzacja v2 w wolumenie kontrolnym:
`runtime-services/container-recovery/06e99e63-da04-4190-897e-d30cb8404a6a/operator.json`,
SHA256 `3cf7b4c118249f4a25f1d966f61215b24c9a6e3f26ad9b4ce8e778cbae960a9a`.
Frontend pozostaje uruchomiony do ponownej walidacji pod lifecycle lease.
Recovery, uruchomienie nowego pakietu oraz Solve Universe nadal wymagają wykonania.

## Rzeczywiste recovery v3 i nowa próba naukowa

Managed recovery przez `just docker-dev-recover-container` succeeded.
Development attempt `2c5c5be072564f54a656df0073f42b25`, konfiguracja
`9c648952a1fa638b5f85a75c90c596de6206c18c8cb39d3834aaab43957666ad`.
Nowy backend `597e3116dda99f957d23bfc081c5464a111cdc17629122f98c5ad3af693bb8bf`,
obraz `sha256:b3eb4e5bf434b46acd633e4339962bffbcb9b6ccaac59ce5ebf444c4023cc10c`.
Build aplikacji i walidacja 24 plików pakietu PASS. Źródło:
`2357399e3b337e682bb96dc845202262346e7da4`, snapshot
`1c26e58627276dc9229b1838bf1c70f2bdc72f71d6351ea3a7ebc43b4b1faeb4`.
Cache zależności wykorzystano bez przebudowy CUDA/MFEM.

Natywny receipt requestu
`3ccca87d0dd46c0538b99af9202c36abf319889997104ea38bcafa9631b75a94`
potwierdza `retained_terminal_runs_recovered`. SHA256 receiptu:
`cde2a62b0a0620159a0714d719675be6018d10bfdbe1abc2ce41176e5d59aa5a`.
Owner ready (PID 3526, dzieci 3529/3530), process-tree ready, API health
200/ok. API nie miało aktywnej sesji, więc sam start nie przywrócił
sceny do UI i nie jest dowodem wizualizacji.

Retencja po recovery PASS: 70 plików starego V/J/H, dwa archiwa, sześć
chronionych plików nieudanej próby Universe i niezmieniony FMS użytkownika.
Dowód: `verification/terminal-history-recovery-v3-20261025/retention-after-native-recovery.json`.
Przejściowy błąd połączenia `Wsl/Service/WSAETIMEDOUT` nie był błędem
buildu: Docker Desktop potwierdził brak restartu i gotowość kontenera;
łączność Ubuntu później wróciła. Nie restartowano Dockera/WSL ani buildu.

Jawny publiczny POST retry poprzedniej małej próby został zaakceptowany
202 z catalog revision 347 -> 348. Retry ID:
`surface-rt0-after-recovery-20261025-01`, run
`run-live-255fa587f4084d187d7e690f4d75076a4889fcf685a044ee02e4e8486a06b2da`,
task `task-575d7ffbb1951afb4119ac548f4f51ae6f13682d01e522ccc9e4dea6abcc4e2c`.
Nowy attempt `attempt-37daccd7aa964bc88f6143ad9613ba06`, epoch 2,
worker PID 4333, start_ticks 14316498. Potwierdzono running i rosnący
czas CPU (utime 16304 -> 27426 ticków), nie tylko zapis katalogu.
Przydział: 3000 cpu_millis, 5637144576 B RAM, 7516192768 B storage.

Request/ACK zachowano jako `after-recovery-retry-request.json` oraz
`after-recovery-retry-response.json` w `verification/surface-rt0-performance-20261025`.
Retry używa dokładnie zamrożonych wejść, w tym tych samych SHA siatek:
1865 Tet4 przewodnika i 14 punktów pola, 26110 par. Nie odtwarzano siatki
Gmsh ani nie ponawiano żądania po timeout. Na checkpointcie brak accepted H
i brak artefaktów tego attemptu. Oczekiwanie dotyczy tego konkretnego
żywego procesu; nie uruchamiać kolejnego retry bez rozpoznania jego wyniku.
Pełne Universe i wizualizacja w UI pozostają niezrealizowane.


## Zaakceptowany benchmark i przygotowanie źródła — 25.10.2026

Poprzedni attempt-37daccd7aa964bc88f6143ad9613ba06 zakończył się Succeeded.
Bundle CAS 145824512f55385f015038172929619e6115f27a3ccf3db80e0ce944c810f9ee:
22 payloady sprawdzone; V/J/H skończone, niezerowe i spójne; 14 punktów H,
1865 Tet4. Osiem kontroli publicznego HTTP PASS (jednostki, SHA, ETag 304,
odmowa starego attemptu 409). Raporty w control volume:
verification/surface-rt0-performance-20261025/after-recovery-accepted-vjh-analysis.json
oraz after-recovery-accepted-http.json. Native czas 487.287556356 s.
Universe/UI i kwalifikacja LLG nadal NIEUKOŃCZONE, wynik inspection_only.

Rzeczywisty build FEM to CMake Release, CXX -O3 -DNDEBUG. Załadowana
biblioteka oraz artefakt cache FEM mają ten sam SHA256
f31e500602891ceaff5d0fad61d8aea0601de1361e0fd72e4d8d80ba900814ef.
Nieoptymalizowany cache pod FDM nie jest biblioteką używaną przez runtime.

Optymalizacja surface_rt0.cpp przygotowuje dokładne wejścia, wyznacznik,
outward winding, normalne i krawędzie raz na wywołanie. Kolejność sum,
trzy precyzje i tolerancje pozostają. Walidator noty 0950 PASS; 41 testów
interpretowanych kontraktu PASS. Managed build cf10673f01d04be788d8632db2346048
PASS, API wróciło. Snapshot:
b449e3aac9d713268355bf964d3734cd27620f609eb893912ebdc2fb0efbbe54.
Zgodność wyniku i przyspieszenie po poprawce pozostają NOT VERIFIED.

Nowe zlecenia zachowują te same definition/study/catalog CAS i 1973 assety.
Run run-surface-prepared-source-20261025-01 ma historyczną manualną bramkę
UI, nie jest zmaterializowany i nie wykonał Solve. Publiczne Submit oraz
materialization run-surface-prepared-source-20261025-02 przeszły. Attempt
attempt-56642ebad7874adfa9c9367a8945e319 zakończył się Failed PRZED solverem:
worker odrzuca jawne automatic, dopuszczone przez wspólny start gate.
Zachowano terminalny receipt i historię, nie ponowiono próby bez poprawki.

Poprawka współdzieli ścisły decoder start gate między schedulerem i workerem.
Wersja, zamknięte manual/automatic i kontrola trwałego grantu manual pozostają.
Przygotowano regresję Rust obu trybów i odmów; nie kompilowano testów.
Dalsze kroki: managed build, publiczne retry dokładnie próby 02, ścisłe
porównanie 21 payloadów oraz pełnych diagnostyk trzech precyzji i pomiar czasu.
Skrypt porównania: control volume, ten sam katalog verification,
compare-prepared-source-results.py. Bez zmiany limitów, precyzji lub jakości.

Retencja: wszystkie bieżące pakiety, cache i dowody są potrzebne do
porównania lub rollbacku; nie wykazano zbędnego zasobu do usunięcia.
Nie wykonano prune. Skill fullmag-build-stage-cleanup nie występuje w tym
worktree; zastosowano regułę zachowania danych z build-storage governance.


### Wykonanie po poprawce Start oraz porównanie — 25.10.2026

Managed restart z development attempt 2c5c5be072564f54a656df0073f42b25
zakończył iterację d3b549111d8c4fd29cb99a0f75184f72 kodem 0. Snapshot pakietu:
90ed459db0e923935db35350f334b05bb6fdf72d0775a48a1e6bfabd6f8ce052.
Błędne wcześniejsze użycie identyfikatora iteracji cf106... jako development
attempt odmówiło odczytu przed zmianą usług; właściwy development pin
zachowano. Nie ponawiano buildu po timeout obserwacji.

Publiczne retry z catalog_revision 11 przyjęto 202: run
run-surface-prepared-source-20261025-02, task
task-6376539a6a15f6adad185839fded07d6df010f9fccd615f7e691721072b2f5a8,
attempt-33df698e66944c87b9409baf0200c887, epoch 2. Potwierdzono żywy PID 3453,
start_ticks 14639461 i rosnący czas CPU; następnie Completed i Succeeded.
Nowy pakiet CAS cb8231675d3151513c17047dad6b0c6cf857e473bf1805d8c4ce0a70f7a00fc4.
Poprawkę wspólnego parsera Start zapisano osobno:
f5c9400ea1cc4a0456e4248a0cf8c04e61761f43.

Ścisłe porównanie PASS: wszystkie 21 payloadów poza raportem powierzchniowym
są identyczne bajtowo, w tym V/J/H raw i per-A; pełne dane diagnostyczne
trzech precyzji, limity i tolerancje także identyczne. Operacje wymierne
31 062 533 → 20 491 713, całkowite 585 607 487 → 395 876 894.
Czas operatora 487.287556356 → 418.612782124 s: spadek o 14.0933%, speedup
1.16405. Peak RSS 538046464 → 548306944 B. Nie obniżono precyzji ani jakości.
Jeden pomiar nie stanowi statystycznej kwalifikacji wydajności.
Raport prepared-source-result-comparison.json SHA256:
8e9bd221bf36d4c5fa083cb20e71f564b641136be654560fc1c2a706270fc6c6.
CPP w worktree jest identyczne z cieniem użytym do kompilacji; SHA256:
e548646e81c7963f9bd9cd451e9bc74ed546bc19a95735cf059e1cee69751c50.

Po potwierdzonym wyjściu workera uruchomiono niezależne całkowanie objętościowe
Biota–Savarta zachowanego cell-local J. Rzędy 4/8/12/16/24 i tolerancję
1e-9 A/m + 1e-5 normy H przypięto PRZED wykonaniem. Wynik PASS, exit 0;
wszystkie 14 targetów poza source cells. Maksymalna różnica dla rzędu 24:
5.147751632094446e-11 A/m. Czas 118.00734812399605 s. Weryfikacja nie
przeprowadza ponownie transportu i nie dowodzi inside-source, całego Universe
ani rygorystycznego certyfikatu błędu. Raport independent-volume-quadrature.json
SHA256 247f57869e37d7aae761c4dac9a5246d5024135fd54079865864944e2208a3d0.
Oba raporty i skrypty są zachowane w control volume, pod
verification/surface-rt0-performance-20261025/.

Pełne Universe, wizualizacja i kwalifikacja bazy LLG nadal nieukończone.
Przy aktualnym koszcie nie powtarzać ślepo pełnej próby 1154 targetów z limitem
1800 s. Starszy direct Universe miał odmowę regularnej kwadratury na głębokości
6; nie traktować próby tej samej metody jako nowej naprawy. Następny krok to
optymalizacja arytmetyki/operatora z zachowaniem kontroli błędu, nie zwiększanie
limitów i nie zmniejszanie domeny. Wyniki, historie i cache pozostają.


### Dokładne tożsamości liczników — wykonanie 25.10.2026

Zastąpiono ponowne dokładne iloczyny mieszane w geometry równoważnymi
h*d/S i h. Bez zmiany fizyki, trzech precyzji, formuł i tolerancji.
Regresja Fraction: 540 konfiguracji, 2160 równości, PASS. Walidacja noty
0950 i git diff --check PASS. Managed build iteracji
762850b9674b4e8cb49007b4101ad2be PASS; nie kompilowano testów native/Rust.
Publiczne submit 201 i materialization 200, run
run-surface-exact-identities-20261025-01, task
task-24e0507a41937d7288a6b1e94671da91a47eaa6deb617f0567df6b0705746785,
attempt-3263891a38d64727b56b199e121ec7a4, epoch 1: Succeeded.
Worker PID 3635, start token linux-starttime-14822938, receipt exit 0.
Nowy bundle CAS:
453bb352b0e4ed9458942bfbf13bd5b2a331ba01286c782451227b9e69300a6d.
Output manifest CAS:
271b311068ea27c8965aae5f48fed2076a0a53c77525fee943e544dcd231640d.

Ścisłe porównanie PASS: 21 payloadów identycznych bajtowo, identyczne
pełne diagnostyki precyzji, polityka i tolerancje. Czas operatora
418.612782124 -> 371.592043076 s, speedup 1.1265386057752131;
łącznie o 23.7427596% mniej niż 487.287556356 s przed obiema optymalizacjami.
Operacje wymierne 20 491 713 -> 14 851 953, całkowite
395 876 894 -> 297 494 414. Peak RSS 545902592 B.
Raport control-volume verification/surface-rt0-performance-20261025/
exact-identities-result-comparison.json, SHA256
1a54515b223fc2eb63e25a28708b4003574b5f56faef59a1ccf83c16078fdb9e.
Niezależna objętościowa referencja H pozostaje adekwatna, ponieważ H jest
identyczne bajtowo. Nie powtarzano niezmienionej referencji.
To pojedynczy pomiar 14 targetów, NIE pełne Universe ani wizualizacja UI.
Wszystkie wyniki, receipty, cache i niezacommitowany plik użytkownika
zachowano. Brak wykazanej zbędności danych: bez prune/usuwania.
Następny krok: dalsze obniżenie kosztu dokładnego operatora przed ponowną
pełną próbą; nie zwiększać limitów ani nie redukować domeny/jakości.


### Cache centrowanego prądu — próba w toku 25.10.2026

Poprzedni etap to commit 8cacaa6ad0a117dd3c0d3bbb93e08ca4e3d79c22.
Nowy WIP przygotowuje C=sum(c_i) i M=sum(c_i*(v_i-v_0)) raz na komórkę;
J(t)=[C*(t-v_0)-M]/abs(det). Zachowuje niezerowe C, znaki i wszystkie
instrumentowane operacje. Fraction: 4608 konfiguracji PASS, oba zwroty,
permutacje, skale, translacje, zera i cancellation. Skrajne konfiguracje
Fraction dowodzą tożsamości, nie reprezentowalności wejścia binary64.
Niezależny read-only review: bez błędu kodu; status istniejącego source-map
zmieniono na not_verified do potwierdzenia nowej próby native.

Managed restart tej samej grupy, iteration fa4e4651a4cf49cf84edcd78150e0681,
zakończył się succeeded/exit0. Native make 197342 ms, cache i kontener
zachowane. Nie kompilowano testów jednostkowych native/Rust. Preflight:
465477775360 B wolnych w /build, brak aktywnego workera, zdrowe puste API.
Pierwsza diagnostyka użyła nieistniejącego /health i otrzymała 404; właściwy
odczyt /v2/platform/health potwierdził status ok. Nie zmieniano routingu.

Jedna nowa publiczna próba, submit201/materialization200:
run-surface-centered-current-20261025-01,
task-2e5265a3b7dac09f2d7944374f02d873adb15f53f78f65a39d3fb0e2c3714bf3,
attempt-c2aba7f2916145578846173e3e6d9eb0, epoch1.
Potwierdzono lifecycle running i żywy PID3701, start_ticks15017135,
użytkownik2994 ticks/system334 ticks w chwili obserwacji. Request SHA256:
67ef7e07216a77cc1b3e260e0c7fb766ff1877abac6027cdcc21f00fba2b03c1.
Archiwum, study/catalog i fizyka identyczne z poprzednią próbą; zmieniono
wyłącznie run_id i idempotency_key. Comparator przygotowany PRZED wynikiem:
compare-centered-current-results.py, baseline453bb352b0e4ed9458942bfbf13bd5b2a331ba01286c782451227b9e69300a6d.
Pliki w control-volume verification/surface-rt0-performance-20261025/.
Stan wyniku/przyspieszenia do porównania pozostaje NOT VERIFIED.

Odrębny read-only przegląd kosztu HTTP wykazał minimum trzy wywołania
pełnego walidatora pakietu w jednym GET: study.rs completion,
study_inspection_integrity.rs read_saved_inspection i runner decode.
Metadata17.15s/h_raw336B17.28s/30417.33s vs katalog1.10s i stale4091.34s
pochodzą z zachowanego raportu, nie nowego profilu. Udział funkcji w czasie
jest hipotezą, redundancja jest potwierdzona źródłami. Pierwsza poprawka
powinna współdzielić zweryfikowany wynik w JEDNYM żądaniu, bez publicznego
skip_validation, bez osłabienia completion, CAS hashing i pre/post fence.
Nie zmieniano loaderów, polityki, cache/admission ani API w tym etapie.

Retencja: bieżące/porównawcze pakiety, cache, receipty i historie są potrzebne;
nie wykazano zasobów zbędnych. Bez prune/usuwania. Skill cleanup nadal brak.
Pełne Universe i widok UI pozostają nieukończone.


### Rozstrzygnięcie cache prądu — brak mierzalnego przyspieszenia

Ta sama próba zakończyła się Succeeded; exit workera0, wszystkie21
payloady i pełne diagnostyki numeryczne identyczne. Nowy bundle:
e8e735f33a7a283e05453a29c8fa7477221fa5fbb113ae49d4c52c4b5dde8d0a.
Czas operatora 373.749115756 s wobec 371.592043076 s baseline,
speedup0.9942285544257763. Różnica około0.58% nie dowodzi trwałej regresji,
ale NIE spełnia przypiętej bramki przyspieszenia. Comparator zakończył exit1
na assert no measured acceleration; pozostałe bramki były spełnione.
Nie poluzowano testu ani tolerancji. Zapisano oddzielny raport odrzucenia:
centered-current-result-comparison.json, SHA256
15aac0aebe8e50411289f7fc975d228c1baaaa5338ca934586e3f5063492b79a.
Operacje wymierne14 851 953 ->14 221 583, całkowite297 494 414 ->285 327 154;
redukcja liczby operacji nie przełożyła się na potwierdzony czas.

Zachowano patch tej próby w control volume jako
verification/surface-rt0-performance-20261025/centered-current-rejected-candidate.patch.
Wycofano wyłącznie cztery własne zmiany CPP/noty/source-map/regresji
z bieżącego worktree do HEAD8cacaa6ad0a117dd3c0d3bbb93e08ca4e3d79c22.
Użytkownikowy FMS, wszystkie wyniki i cache pozostają. Pakiet uruchomiony
po próbie nadal zawiera równoważny numerycznie wariant testowy; kolejnym
krokiem jest managed restart przy idle do przywróconego źródła, bez Solve.
Nie traktować tej próby jako kolejnego przyspieszenia lub pełnego Universe.
Potwierdzono rzeczywiste Release/-O3, zgodność CPP ze zbudowanym cieniem
SHA256 b04fddd522b93fd445ec05c332cb959e5efc2e6053bf1b232e8c41e5e3c31046
i mapowanie workera na /opt/fullmag/package/lib/libfullmag_fem.so.0.
MemAvailable około13GB i load2.41 podczas końcowej kontroli nie wskazywały
na brak RAM jako wyjaśnienie kosztu operatora. Nie zmieniano limitów hosta.
Następny istotny kierunek to dokładna arytmetyka/GMP i funkcje wysokiej
precyzji/MPFR, osobno mierzone i jawnie opisane; nie domniemany zysk z
liczników i nie ponawianie pełnego Universe bez rozwiązania kosztu.

Patch eksperymentu SHA256: d7cb7032954f315a45c1efeea83930347fbae450efd47f1a4530d29aa0d88ce7.


### Przywrócenie runtime oraz kierunek GMP — 25.10.2026

Managed restart iteration716ac13fa9cd40849b2c05a16590add9 zakończył się
succeeded/exit0. Native make155061 ms, package5800 ms. Build commit:
1b7cb42e49233befc3033cd272141e8ac7fb72e1, snapshot:
e6556d55ca845c2cd22d49065adbcf2e8128bfb02b9c870e3978f0bb9dd92c0c.
Kontener i obraz pozostają bez zmian. Odrzucony cache NIE jest już w
aktywnym źródle/pakiecie. Zbudowany CPP zgodny z worktree, SHA256:
fa4a4c074f99ee3632da14a2ba6ba7c06bbad211a127ce32647ed8a3d8b77568.
API health statusok, active_sessionfalse. Odczyt starego zaakceptowanego
Hraw po restarcie:200,336B,SHA256
45313db6f67ce8b0a13d10127fe61412b3ffbdee3d41c3eb319467d2cf4f44d4,
17.389496162 s. Stary attempt:409,1.102933194 s. Bez ponownego Solve.
Raport centered-current-restored-http.json SHA256:
e5c2e409527c048e46397c91243ba624939e1eb32cba97af54b236352fd5eb68.
W /build wolne459756929024 B. Dane eksperymentu i poprzednie wyniki
pozostają zachowane; brak wykazanej zbędności pakietów dla porównań/rollbacku.
Nie wykonywano prune, usuwania, kompilacji testów jednostkowych ani browsera.

Read-only inspekcja LOKALNYCH nagłówków Boost rozstrzyga wcześniejszą
wątpliwość konwersji GMP: gmp.hpp eval_convert_to(double)2199-2211 oraz
rational_adaptor.hpp eval_convert_to239-244 używają tego samego
multiprecision/detail/generic_interconvert.hpp generic_convert_rational_to_float,
z dokładnym divide_qr i nearest-even. Wrapper NIE używa mpq_get_d dla double.
Zachować publiczne value.convert_to<double>(); bez własnego konwertera lub
roundtripu tekstowego. Dla integer->cpp_dec_float obie ścieżki korzystają
z generic_interconvert: limb,ldexp,add. Na tym Linux/amd64 oczekiwane fragmenty
są64bit, ale wymaga to static_assert i rzeczywistego pomiaru nowego builda.
To dowód źródłowy, NIE wykonany parytet GMP.

Najmniejszy kolejny fragment: mpz_int/mpq_rational przy NIEZMIENIONYCH
cpp_dec_float80/120, Arithmetic::number, jawnych exact multiply/sum,
raw_preflight/watch/bitguards i rzeczywistych licznikach. Dodać libgmp-dev
późnym osobnym RUN obrazu DEV (po ciężkich deps/Python), deklarować wersję
w provenance i jawne linkowanie. Obecny obraz nie ma gmp.h/mpfr.h; niczego
nie doinstalowywano w żywym kontenerze. MPFR to osobna kolejna realizacja,
nie cicha zamiana arytmetyki pod starym kontraktem. BuildKit CACHED,
konwersje tie/subnormal i pełne21payloads/diagnostyki wymagają wykonania.
Pełny zakres E0-E12 nadal aktywny; Universe1154 i UI NIEUKOŃCZONE.


### GMP-only — przygotowanie i żywy build obrazu 25.10.2026

Baza92aa30f2bccab3b1e350732dcbee8ff57c106203. WIP obejmuje pięć plików:
CPP surface_rt0, CMakeLists FEM, Dockerfile fem-gpu, notę0950 i source-map.
ExactArithmetic i Arithmetic::number pozostały bez zmian; zmieniono tylko
aliasty na mpz_int/mpq_rational, dodano gmp.hpp i static_assert zgodnej
szerokości limb. Decimal80/120, wszystkie limity i publiczna fizyka pozostają.
CMake wymaga pkgconfiggmp pod MFEM. Dockerfile dodaje późny libgmp-dev oraz
inline actual.system_packages dla GMP/Boost, zgodnie z istniejącym wzorcem
inline augmentacji. NIE zmieniono write_dependency_versions.py: jego
COPY przed heavydeps unieważniłby ich cache. Konsumenci manifestu dopuszczają
addytywne pole; pełny hash manifestu zmienia tożsamość toolchaina.

Niezależny read-only review nie znalazł blokera kodu/quotingu. Faktyczny
validator wykrył, że DOC-ANCHOR komentowany w CMake/Dockerfile nie jest
obsługiwanym symbolem. Poprawiono mapę na pkg_check_modules i prawdziwą
kotwicę Markdown planned_contract. Focused validator następnie PASS;
git diff --check PASS. Native kompilacja GMP i benchmark nadal NOT VERIFIED.
Nie kompilowano testów jednostkowych.

Uruchomiono RAZ przez just docker-dev-toolchain w WSL, grupa:
fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
Żywa sesja unified exec63195, attempt89af5ad8e20747b69d6af243d1d00772,
image tagfullmag/fem-gpu-toolchain:inputs-9a33cf8b9e3fb5070384604c.
Pliki receiptu/logu/configu w control volume:
toolchain/attempts/89af5ad8e20747b69d6af243d1d00772/.
BuildKit wykazał CACHED dla CUDA normalization, hypre, PETSc i innych kroków,
lecz MFEM GPU oraz finalne apt/Python muszą być przebudowane. Postęp62/269
MFEM przy około491s; proces jest żywy, bez terminalu. Nie ponawiać buildu po
samym timeout obserwacji; polling TEJ SAMEJ sesji lub receiptu/logu.

Porównano faktyczne args nowego compose.json i poprzedniego receiptu:
CUDA86-real;86-virtual, hypre86, PETSc86, MFEM_BUILD_JOBS2, fast_compile0;
identyczne. Baza Dockerfile HEAD SHA256
df16f69a94f503c0fd17c2314badf9f527f562577b4ee2ef5d5fd4c8bd3391e3
jest identyczna z wejściem poprzedniego udanego toolchaina. Aktualny plik:
1eee591bce4c63012c85e58b8e367fba131843e8298cdee1274023055acec88a.
Cały prefiks instrukcji do późnego GMP jest identyczny bajtowo. Brak cache
MFEM nie wynika z naszej zmiany wcześniejszych instrukcji/args; przyczyny
niedostępności rekordu cache nie ustalono. NIE deklarować pełnego cachehit.
Nie zmieniać wejść Dockerfile/compose/writera w czasie tego buildu.

Stary backend597e3116dda99f957d23bfc081c5464a111cdc17629122f98c5ad3af693bb8bf
pozostaje uruchomiony z poprzednim zweryfikowanym obrazem/pakietem. Nie
odtwarzano usług ani nie uruchamiano nowego Solve. Nowy toolchain_image_id
zmienia cache_key w docker_backend_volume_cache.py197-227: nowy izolowany
cache aplikacji, poprzedni zachowany. Nie obchodzić tej granicy zgodności.
Pomiar obecnego /build:11536240KiB; D wolne38.4GiB (bez zmiany podczas
pierwszych etapów obrazu); E nie jest obecnie widoczne w tej sesji hosta.
Nie tworzono nowych plików ext4 ani katalogów danych na C/E.

Prerejestracja kolejnej próby jest zachowana, ALE NIE WYSŁANA do API:
run-surface-gmp-20261025-01; requestgmp-submit-request.json SHA256
68b59c064523746a31c64605ffc7e6e7c398ff666e2dae3177e76a85962da3d8.
Archiwum/study/catalog/assetty i fizyka identyczne z baseline453bb352... .
compare-gmp-results.py wymaga wszystkich21payloads, pełnych diagnostyk,
niezmienionych total/by_precision/maxraw/maxreducedbits i czasu<371.592043076s.
Pliki w verification/surface-rt0-performance-20261025/ control volume.

Następnie: zakończyć i sprawdzić TEN build obrazu, odczytać actual.system_packages
oraz faktyczne wersje narzędzi; przygotować wrappery tej samej grupy; sprawdzić
miejsce i brak aktywnych zadań przed managed stop-idle/odtworzeniem do nowego
obrazu. Nie używać fresh_state, nie zmieniać storage i nie powtarzać Solve.
Dopiero po nowym buildzie aplikacji zweryfikować ldd/NEEDED i wysłać
przypięty request GMP. Nie deklarować Universe na podstawie małego benchmarku.
Wyniki, snapshoty, cache, stare obrazy i userFMS zachowane; bez prune.
Skill cleanup nadal brak. WIP nie został zacommitowany jako gotowy etap.
Pełny zakres E0-E12 pozostaje aktywny; Universe/UI nadal nieukończone.


### Odczyt zaakceptowanego wyniku — przygotowanie regresji 25.10.2026

WIP runtime-control obejmuje study_inspection_integrity.rs i wyłącznie komentarz
helpera w study.rs. Cold-read używa istniejącego
validate_study_task_completion_for_snapshot z już zweryfikowanym accepted,
wewnątrz tej samej read_transaction. Pozostają świeży immutable intent fence,
kontrole lifecycle/attempt/epoch, manifestu, jedynego typed outputu i ProblemIR.
CAS wskazany pinem nadal jest odczytywany z limitem i rehashowany; decode nadal
sprawdza neutralną domkniętą paczkę i thin-view bounds. Usunięto jedynie drugi
identyczny validate_accepted_inspection_bytes. Oczekiwana redukcja pełnych
walidacji przy GET: trzy do dwóch; nie deklarujemy jednej ani cache globalnego.
Niezależny przegląd faktycznego diffu: bez blokujących uwag źródłowych.
Kompilacja aplikacji i rzeczywisty pomiar poprawki nadal NOT VERIFIED.

Zachowano odpowiedź 200 starego API dla run-surface-exact-identities-20261025-01,
bez Solve: exact-identities-accepted-metadata-before-reader-change.json,
SHA256 d2fa79b335570213b12b6218f7f073f32d8e7c05f1308f9ddbe3036fffd0ebf6.
ETag jest tym samym hashem w cudzysłowie. Odczyt21.473009362s podczas budowy
MFEM ma rolę diagnostyczną, nie stanowi nowej bazy wydajności.

W verification/surface-rt0-performance-20261025/ control volume przygotowano
accepted-reader-regression.py, SHA256
bb90fb4cd1c56daf2224c482f5f79eebf161f3478535a4f1e87dda39a34d7c8e,
oraz accepted-reader-regression-preregistration.json. Składnia Python PASS;
regresja NIE URUCHOMIONA na nowym runtime. Wymaga identycznych metadanych/ETag,
SHA i długości Hraw/Vraw/Jlocalraw, jednostek A/m, V, A/m^2, 304 bez body,
409 dla nieaktualnego attempt/epoch/package. Prerejestrowany próg Hraw:
15.650546545808902s (90% wcześniejszych17.38949616200989s). Pomiar dopiero po
nowym buildzie aplikacji i zakończeniu workerów kompilacji/symulacji.
Nie zmieniać zachowanego CAS w celu testowania korupcji.

Ta sama sesja63195 nadal żywa: ostatnia obserwacja MFEM122/269 przy1432.7s.
Nie uruchomiono drugiej budowy, nowej symulacji ani browsera. Źródła Dockerfile
pozostają zamrożone na czas operacji. Wyniki, cache i userFMS zachowane.
Pełny Universe i wizualizacja UI nadal nieukończone; E0-E12 pozostaje aktywne.


Przegląd źródłowy zmiany obrazu: po terminalu toolchaina właściwa sekwencja to
just docker-dev-images, przypięty docker-dev-stop-idle, następnie
przypięty docker-dev-recreate-volume z fresh_state=false. W
scripts/docker_volume_dev.py _retained_operation sprawdza stare usługi i drain,
a start ponownie rozwiązuje aktualny toolchain/runtime images. Nie używać
image override ani nowego state root. Zachować w środowisku
FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples: nowy Compose renderuje mount od nowa.
Requested GPU policy i resolved access są odczytywane ze starej konfiguracji
i ponownie sprawdzane; brak dowodu GPU nie upoważnia do fallbacku CPU.
Przed wykonaniem ponownie sprawdzić aktualne piny development/config, aktywne
zadania, storage i miejsce. W razie przerwanej obserwacji nowego startu użyć
przypiętego resume-recreation, nie ponawiać usuwania usług. To przegląd źródeł,
nie wykonana migracja. Sprawdzono również target CMake fullmag_fem: SHARED;
prywatne linkowanie GMP należy do tej biblioteki, Rust linkuje ją jako dylib.
Rzeczywiste NEEDED/ldd nadal wymagają nowego builda.


Doprecyzowano regresję przed jej pierwszym wykonaniem: odpowiedź304 musi
zachować ten sam ETag. Przygotowany comparator GMP parsuje rzeczywisty
baseline453bb352... (22payloads, formatFMACLB01/FM-RT0-SURF-V1), lecz nie
wykonano porównania nowej realizacji. Kontrola wymaga teraz także identycznego
work każdego z14targetów, current_target i current_target_index, zamiast
porównywać tylko sumy i by_precision. Wymaganie zaostrzono przed wysłaniem
Solve; request SHA pozostaje68b59c064523746a31c64605ffc7e6e7c398ff666e2dae3177e76a85962da3d8.
Comparator SHA2562eabfc162fe1a476dd0627786436f63736c6cf7f561c21f6a8a76381b04f38fe.
Hashy sześciu wejść pilnuje gmp-pending-regression-inputs.json w control volume.
GMP preregistration nadal submitted=false. Żywa sesja63195: MFEM133/269
przy1718.0s; bez terminalu, bez ponownej budowy. Nie zmieniano Dockerfile
ani źródeł aplikacji podczas tej obserwacji. Pozostaje build aplikacji,
rzeczywisty parytet/czas GMP, odczyt API, pełny Universe oraz UI.


### Diagnostyka obciążenia bez aktywnej sesji — 25.10.2026

Podczas tej samej budowy MFEM (sesja63195, ostatnio154/269) API health pozostaje
ok/active_session=false. Lista procesów backendu nie zawiera naukowego workera;
są API, runtime-service oraz schedulery compute/preparation. Trzy pomiary po2s
z /proc/stat dla tych samych inkarnacji wykazały okresowe koszty CPU:
compute7.99/88.84/16.47%, preparation26.45/24.96/9.98%,
runtime8.49/13.48/12.98% pojedynczego rdzenia. Raport
verification/scheduler-idle-cpu-20261025/observed-idle.json w control volume,
SHA25698f2093cdae8f701fbd3bcf67c7b0ab8d6690f0c8a583599962c542e12c42050.
To diagnostyka przy równoległym BuildKit, nie izolowany benchmark ani dowód
przyczyny procentów. /proc/<pid>/io nie występuje w tym kernelu; brak metryki
szybkości odczytu, nie przypisywać jej wartości. WSL MemAvailable11777588kB,
memory.events OOM0/OOMkill0; memory/io pressure avg10=0; D wolne41189953536B.
Nie zwiększano limitów i nie zatrzymywano procesów.

Przegląd źródeł i uruchomionego commita1b7cb42... potwierdza prefiltry terminal
przed pełnym accepted snapshotem w scheduler.rs. Nie ma podstaw twierdzić,
że każdy terminalrun ponownie hashuje1973 pliki CAS w każdym pollu.
Potwierdzono jednak wielokrotne list_run_intents/read_run_intent w discovery,
queue/readiness/resume oraz host.reconcile_task_cancellations. Każdy
FmsRunIntent::validate kanonizuje i hashuje pełny RunSpec oraz sprawdza mapy
assetów. W store18intentów, razem12871825B, największe około717kB każdy.
Są to koszty metadanych, a nie naukowe obliczenie pola.

Najwęższy kandydat dalszej optymalizacji to ponowne użycie zweryfikowanej
obserwacji intentu TYLKO w jednym pollu discovery; rzeczywiste admission/resume
musi zachować świeży odczyt, katalogi, host/store fence i launch permit. Bez
cache między pollami, pomijania błędów terminalnej historii ani zmiany
interwałów. Nie wdrożono tej zmiany. Najpierw kończymy istniejący build GMP
i jego pomiar, aby nie mieszać efektu arytmetyki z inną zmianą obciążenia CPU.
Przyczyna kosztu runtime-service nie została w tym przeglądzie ustalona.


### Pełny Universe a limit materializacji widoków — 25.10.2026

Przegląd źródeł i prawdziwego baseline453bb352... wykazał bramkę przed UI:
inspection_field_provider::from_closed naliczał16*sumę22payloadów+2MiB,
choć tylko9payloadów tworzy geometrię/wartości V/J/H. LoadedInspection jest
konsumowany, jego evidence/certificate/preimages/per-A arrays po utworzeniu
widoków są zwalniane; VerifiedInspectionFields przechowuje4owned field views.
insert osobno liczy rzeczywiste retained capacities, a caller/cache zachowują
limit128MiB. Thin metadata64KiB nie obejmuje tablic per-target; prawdziwy
mały widok ma13326B. Native evidence128MiB, manifest16MiB i bundle512MiB
mają osobne limity; mniejszy budget konkretnego full-Universe claim nadal
wymaga sprawdzenia. 22payloady nie mnożą się przez liczbętargetów.

Rzeczywisty mały bundle6873467B, suma payloadów6859687B; direct_evidence55324B
na14targetów, pojedyncze rows3761-3777B. Ekstrapolacja do1154 wskazuje kilka
MiB nowych diagnostyk. W starym oszacowaniu payloadsum>8257536B przekraczał
limit128MiB; to prawdopodobny kolejny blocker pełnego Universe po Solve,
nie zmierzony wynik pełnego Universe.

Zastosowano WIP WYŁĄCZNIE naliczania w kanonicznym providerze, dla ścieżek
live i accepted: suma Vec::capacity wszystkich wejściowych payloadów raz
+16*suma długości9projektowanych payloadów+2MiB. Dziewięć kluczy:
vertex_xyz, stable_vertex_ids, cells, v_raw, j_local_raw, j_center_raw,
sample_xyz, sample_cells, h_raw. Wszystkie checked arithmetic, limit128MiB,
pełna walidacja closure/diagnostyk i końcowe retained/cache gates pozostają.
Nie zmieniono danych ani jakości siatki. Jest to oszacowanie admission dla
materializacji, nie allocator hard cap ani pomiar RSS całego loadera.

Raport field-view-admission-baseline-analysis.json w control volume,
SHA2561abe0fe456daa9c36867a4894bf2156c469c477f455d3fdef56313c5f6889d5e:
projektowane długości774176B, stary length-based bound111852144B,
nowy length-based bound21343655B. Analiza Python mierzy długości serializacji,
nie rzeczywiste capacities Rust. Nie konstruowano fikcyjnych scientific payloads.
Diff check PASS; kompilacja, canonical field API i pełny Universe nadal
NOT VERIFIED. WIP nie jest ukończonym etapem. Nie kompilowano unit tests.
Ta sama budowa63195 nadal żywa: MFEM216/269 przy3155.3s; bez nowegoSolve.

Porównanie wszystkich16wejść toolchaina zapisane jako
toolchain-cache-input-comparison.json SHA256
e9f3eb9074920507f57787084bb6d91236d2adc7a4079a15223e008f33b6e4f0.
Różni się tylkoDockerfile; args/targetpozostałepliki identyczne. Poprzedni
obraz faktycznie zbudował attempt ec4ba463986742e883c748b0e9c762e2;
88f1f92115b24651a160f7e7e2baa85d był cachehit obrazu (log0B), nie osobnym
buildemMFEM. Przyczyna braku cache warstwy nadal nieustalona. Odczyt builderów
pokazuje WSLdefault/docker i Windowsdesktop-linux/docker; dodatkowy
fullmag-windows/docker-container nie jest obecnie wybrany. Nie ma dowodu,
że zmiana buildera była przyczyną. Nie zmieniano konfiguracji ani nieprunowano.


### Odtworzenie accepted wyniku z ekranu startowego — RED i WIP 25.10.2026

Audyt istniejącej drogi wskazał eksport historyczny profile=solved z accepted_run,
następnie import restore_mode=visualization_only. projects/open sam nie
aktywuje historycznej obserwacji. Istniejący smoke_antenna_artifact_fields.py
zaczyna od legacy stage artifact_refs i może odmówić przed dotarciem do
accepted CAS provider; właściwa regresja ma zaczynać od canonical
/data/fields?stage_id=<immutable Study step> i locator pins.

Zidentyfikowano i rzeczywiście odtworzono brak cold-open: historyczny eksport
wymagał current workspace w routerze oraz core, ZANIM wybierał accepted source.
Publiczny GET run-surface-exact-identities-20261025-01: catalog_revision310,
jeden task Succeeded, task24e0507.../attempt326389.../epoch1. Katalog artefaktów
z właściwego store ma revision1. POST exports z dokładnymi pinami zwrócił404
w0.013740742s: no active local live workspace. Report
accepted-export-idle-before-report.json, body
accepted-export-idle-before-error.json (172B, SHA256
3b7f4025392bbcadf8f87ac4d7e97bf2a07d6f75d7651e4ba54a812cb1d52340),
request accepted-export-idle-request.json i obydwa katalogi zachowane w
verification/surface-rt0-performance-20261025/. Nie wysłano importu ani Solve.
Sam healthactive_sessionfalse nie dowodził tego błędu; dowodem jest odpowiedź404.

WIP naprawia tylko dwa miejsca: router_v2/handlers/persistence/session.rs
wybiera capture_optional_current_live_request_context wyłącznie dla
accepted_run, zwykły eksport nadal wymaga bieżącego kontekstu. Core
session_persistence.rs::export_session_with_context najpierw wybiera
historyczny snapshot/epoch/skrypt albo bieżący snapshot; session_id i domyślna
nazwa pochodzą z wybranego snapshotu, nie z obcego current. Zachowano transition
lock, ograniczenie solved-download-only, wszystkie exact catalog pins,
all-tasks-Succeeded, walidację closure/źródeł i rewalidację current scope,
gdy workspace istnieje. Nie zmieniano middleware, formatu, endpointów ani
mechanizmu importu. Niezależny source-review faktycznego diffu: bez blockerów;
typ tuple i partial move req.name zgodne. Kompilacja/runtime NOT VERIFIED.

Uwaga o skutkach: historyczny eksport nie uruchamia workera i nie publikuje
current_live_state, lecz istniejący pack zapisuje manifesty w skonfigurowanym
współdzielonym command-journal store; commit_session aktualizuje tam CURRENT
przez nową immutable generation. Nie jest to prywatny scratch ani całkowicie
bezstanowy odczyt. To wcześniejsze zachowanie exportu, nie nowość patcha.
W odczytanych ścieżkach nie znaleziono API-startowego odtwarzania current
workspace z tego wskaźnika; imported evidence czyta swój prywatny root.

Po normalnym app buildzie i pomiarze GMP: ordinary export z current=None ma
nadal404; historyczny dokładnie przypięty export ma200 bez Solve/aktywacji;
błędne rewizje mają409. Dopiero potem importvisualization_only i sprawdzenie
catalogfields/quantities oraz meta/vector/topology dla V_electric/J_charge/H_ant,
z nowym x-fullmag-session-scope i exact stage/carrier/revision/generation.
Dla H użyć locatorowego scope full, nie umownego airbox. Import ma stan
completed/is_busyfalse/can_accept_commandsfalse i resetuje queue/replay;
nie uruchamia main.py. Weryfikacja stale scope i niezmienionego current podczas
historycznego eksportu nadal obowiązuje. Oryginalny userFMS pozostaje nietknięty.

Osobny source-review naliczania from_closed potwierdził wszystkie9kluczy,
przeniesienie wartości/carrier Arc bez sidecars i brak ukrytej alokacji zależnej
od direct_evidence. 16x ma margines dla 400B wejścia/cell i48B/Htarget plus
osobnej topologii. Nie jest to formalny peak całego loadera; pełny API test
pozostaje wymagany. Wszystkie trzy WIP fragmenty wymagają normalnego appbuilda;
nie kompilowano unit tests. Ta sama budowa toolchain63195: ostatnio MFEM228/269.


Doprecyzowanie źródła regresji eksportu: ręcznie zamrożony run-surface-exact-
identities-20261025-01 ma parameters wyłącznie fullmag.accepted_run_start,
bez live_workspace. Jego404 wykazało precondition routera, ale NIE uprawnia
do oczekiwania poprawnego eksportuFMS z wymyśloną historią sesji. Nie dopisano
metadanych i nie zmieniono żadnego accepted intentu.

Pozytywnym źródłem jest oryginalny run-live-255fa587f4084d187d7e690f4d75076a4889fcf685a044ee02e4e8486a06b2da,
project-live-6fa2f6a713ca29e1da4078b34e27fa5d8c2c6109f69e788afd7cfe188ca92a95.
Rzeczywisty publiczny katalog579, artifactcatalog1, task575d7ffb... Succeeded,
attempt37daccd7aa964bc88f6143ad9613ba06/epoch2. Parametry zawierają source_session
docker-startup-6cc6f209f94f3d014a3aedfc806b0670a206725a395b62bd953c394bca22094b,
session_epoch1, scene_revision1; definition.scene.scene.name to
fem_antenna_closed_loop_surface_benchmark. Ten poprawnie zakotwiczony export
RÓWNIEŻ zwrócił404/noactiveworkspace (0.004361414s, ten sam172Bbodyhash).
Report/request/catalogs mają prefix accepted-export-live-* w controlvolume.
To właściwy RED dla naprawy cold-open. Wcześniejszy ręczny benchmark pozostaje
przypadkiem arytmetyki/raw accepted reads, nie źródłem sfabrykowanego liveFMS.

Przygotowano, lecz NIE uruchomiono accepted-export-idle-regression.py,
SHA25616b310b27531c6616d656ee6071b0f68f974752728539305d5725c5320af2aab,
i jego preregistration. Po nowym appbuildzie i końcu GMPworker kontroluje
ordinary404 przed/po, fresh public task/attempt/epoch,409stale obu rewizji,
200historycznego exportu/zgodny session_id/profile/rozmiarbase64 oraz health
bez aktywacji. Zapisze archiveaccepted-export-idle-after.fms w controlvolume.
Import i Solve nie są częścią tego skryptu. Nazwa przy unrelatedcurrent,
stale scope i pełne import/data-plane nadal osobno wymagane. SkładniaPython
PASS; runtimeNOTVERIFIED. Ta sama budowa63195 doszła doMFEM255/269.


Stan dalszej obserwacji tej samej sesji63195: MFEM CUDA ukończył269/269,
linkowanie i instalację Release około4317s etapu24. Następnie hypreCPU
ukończył631/631 (DONE201.0s, etap31). Obraz nadal nie ma terminalu: trwa
PETScCPU w etapie33, konfiguracja complete, jawne --with-cuda=0 i
--with-precision=double; kompilacja kolejnych modułów postępuje. Nie
przerwano ani nie ponowiono buildu. Pomiar D free41187766272B.

Skrypt accepted-export-idle-regression.py (SHA256
16b310b27531c6616d656ee6071b0f68f974752728539305d5725c5320af2aab)
i preregistration są przygotowane w control volume; NIE wykonane na nowym
runtime. Służą oryginalnemu run-live255fa... z realną historią live,
nie zamrożonemu benchmarkowi bez live_workspace. Usunięto też wyłącznie
helper current_session_id osierocony przez poprawkę eksportu; globalny
word-search potwierdził brak jego konsumentów (pozostałe dwa wystąpienia
w main.rs są lokalną zmienną). Diffcheck PASS. Nadal11trackedWIPpliki,
userFMSnietknięty, bez commita niezweryfikowanego etapu i bez unitcompile.


### Zakończenie toolchaina i kontrolowane przełączenie — 25.10.2026

Ta sama obserwowana operacja63195 zakończyła się kodem0. Toolchain attempt
89af5ad8e20747b69d6af243d1d00772 ma terminal succeeded, immutable image
sha256:5bf6b247a3e479bc212a28076e7416988884ee67395d927d3615af19cc920cc7.
GMP libgmp-dev2:6.2.1+dfsg-3ubuntu1 zainstalowano po istniejących ciężkich
warstwach. Rzeczywista wersja z manifestu nowego runtime nadal do odczytu.
Zarządzane docker-dev-images zakończyło się kodem0: image-dev attempt
a1db071269184affbdbc4234c34b5b88 -> sha256:d7af9b25c9dad7fc6d08c0d4e97befe43489fc49eab94bbf94835f7f9f998901;
image-backend attempt00028906ebbd45b4bbf589ecdb72d29c ->
sha256:04d4e77d469461c3a4f7f25b677bb03a8ade7b30b364883dd6aec66e295a891e.

Przed stopem rzeczywisty healthok/active_sessionfalse; Compose/config9c648952...
i development2c5c5be0... nadal zgodne, Dfree>32GiB. Przypięte
just docker-dev-stop-idle zakończyło się kodem0, iteration
18c8f3259677433e8f26967b3976028e succeeded. Zachowany native drain i oba
zatrzymane kontenery. Następny krok: recreate-volume z fresh_state=false,
bez skryptu, z grantem procesu FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples.
Nie usuwamy wolumenów, wyników, logów ani obrazów. Stary cache/ostatni pakiet
są potrzebne do rollbacku; nowy cache wynika z rzeczywistej zmiany toolchaina.
Brak ogólnego GC/quota nie został rozwiązany przez tę operację.

Przegląd skryptu canonical field check wykrył brak przypięcia pliku FMS
przed jedynym importem. Technical script w control volume poprawiono tak,
aby przed markerem/POST wymagał passed export receipt, exact SHA/bytes/nazwy
oraz bounded odczytu manifest/session.json i project/current_live_snapshot.json
ze zgodnym accepted run/source session. Nowy SHA256
658e4eedf93ee78eda0138de70e39f33152e9f65e4bf253c18d7294042ca738f,
16017B; in-memory compile PASS, bez wykonania API/import/Solve. Źródła
potwierdzają, że immutable Study step jest właściwym canonical stage_id.
GMP parytet, API cold-open, full Universe i browser/WebGL nadal NOT VERIFIED.


### Potwierdzone wykonanie GMP, odczytu i eksportu — 25.10.2026

Poniższy checkpoint aktualizuje wcześniejsze statusy oczekujące; nie zmienia
historii wykonania ani kwalifikacji całego E0–E12.

Zarządzany build aplikacji `d30549fadeb14aadb517a0a491ca50b0` zakończył się
kodem 0, podobnie jak zachowujące dane odtworzenie usług
`bc95c3b4f6e240bb88379224f634bec7`. Backend
`5ec8eb6671b2a51040521d7cc4f2c5f6c923af79ddc9f5efc35ccb9eb6fa6bb2`
używa obrazu `04d4e77d469461c3a4f7f25b677bb03a8ade7b30b364883dd6aec66e295a891e`,
konfiguracji `832e7f23ef586f21fbb8bd704f19e5e2c2c0aae93ba3e46f5aa57980d2e42c72`
i snapshotu `d9e981ec02ce2b2480662d0a3b0918a52688c378271080e55a068d4887181c72`.
Skompilowany HEAD to `92aa30f2bccab3b1e350732dcbee8ff57c106203` z przypiętymi
zmianami roboczymi. Biblioteka FEM ma SHA256
`a9aa45cdc5fc2a7391542184756637b2e1eebee1f155b42b217f1625d1218ceb`,
NEEDED `libgmp.so.10`, bez brakujących zależności. GMP wynosi
`2:6.2.1+dfsg-3ubuntu1`, Boost `1.74.0.3ubuntu7`, rustc
`1.101.0-nightly (12433c307 2026-10-24)`. Nie kompilowano testów jednostkowych.
Zachowano poprzednie wolumeny cache/package i wszystkie wyniki. Ciężkie
warstwy zostały przebudowane, więc nie deklarujemy sukcesu bramki CACHED.

Zaakceptowany `run-surface-gmp-20261025-01`, task
`task-1a6ac9108ca7bb1f7fc280f4ea96cde7575d56c07b362b704f7dd8dee319f54c`,
attempt `attempt-20472c191c6642cbb4c54e19b7701357`, epoch 1 ma lifecycle
Succeeded, katalog 298; proces workera 21393 zakończył się. Bundle
`fa991bac1f48f2abd08ef5b35af381f43558b112141d58d1e27cd8848fcb26f5`
przeszedł prerejestrowane porównanie wszystkich 21 payloadów, diagnostyk
trzech precyzji, liczników, maksymalnych długości liczb, tolerancji i limitów.
Czas operatora: 346.505338649 s wobec 371.592043076 s. To pojedynczy pomiar
14 punktów zewnętrznych, bez dowodu pełnego Universe lub UI.

W tej samej grupie `accepted-reader-regression-result.json` ma PASS:
metadane/ETag, V, J i H zachowane bajtowo; 304 zachowuje ETag i pustą treść;
obcy attempt/epoch/package dają 409. Odczyt H trwał 10.622386762 s wobec
17.389496162 s wcześniejszego pomiaru i przeszedł uprzednio zadany próg
15.6505465458 s. To uzasadnia współdzielenie zweryfikowanego snapshotu w jednej
transakcji odczytu, nie globalny cache ani pominięcie kontroli zakończenia.

`accepted-export-idle-regression-result.json` również ma PASS. Bez bieżącego
workspace zwykły eksport zwraca 404; historyczny eksport dokładnie przypiętego
run-live-255fa… zwraca 200, z poprawną tożsamością źródła. Obie nieaktualne
rewizje zwracają 409. Przed i po eksporcie health.active_session=false;
nie wykonano importu ani Solve. Archiwum ma 102748559 B, SHA256
`abe752d4ba223ec78724ad3c6de5238a8e2ae055f3e3c15cf707f56fc4157c3a`.
Raporty i FMS znajdują się wyłącznie w wolumenie kontrolnym grupy pod
`verification/surface-rt0-performance-20261025/`. Nie nadpisano FMS użytkownika.
Kontrola po przerwaniu rozmowy potwierdziła terminalny PASS i brak procesu;
nie ponawiano eksportu. Canonical import/data-plane po cold-load nadal wymaga
osobnego wykonania przygotowanego harnessu.

### Ponowne przygotowanie Universe i dalszy WIP — 25.10.2026

Recepta `just docker-dev-script` dla
`examples/antenna_universe/fem_antenna_closed_loop_universe_surface.py`,
source-root bieżącego worktree, port 3203 i request
`antenna-universe-gmp-20261025-prepare-01` zakończyła się kodem 0. Activation
`0afeefc95f6c45cf89a0a815a163c193` zachowała ten sam backend i konfigurację.
Sesja `docker-startup-3eceb8a77de5caf27abe222f3d58f4193350fc74c4c92e4f44a9a29308200f46`,
run `run-live-1f51b0f075ff44ae6e640d0c043c840f825d8a7c6714e5c758c0ba365e933bc2`
ma preparation=ready i solver=awaiting_command. Compute nie został uruchomiony.
Rzeczywisty publikowany mesh shared-domain pokazuje przewodnik 677 węzłów /
1861 Tet4; nie jest dowodem liczności osobnej siatki próbkowania Global.
Nie przepisujemy do nowej próby historycznej liczby 1154 bez sprawdzenia jej
własnego immutable input. Receipty mają prefiks universe-gmp-prepare-*.

Po terminalu aktywacji zastosowano dwa przejrzane patche źródeł:
- zero-copy bits/watch/sign: SHA256
  `55b62ced7532f3140c29c1bcfa5edaf8d6684a26d60fc3cbf9f68461042e55e1`;
- opcjonalny sample_carrier w kanonicznym locatorze: SHA256
  `6bf5ca44a14e3a360d6b5d2ce58263ce5bd548dc125187748b6f605654974fd3`.
Drugi uzupełniono o checked naliczanie rzeczywistej pojemności nowych stringów.
Nie zmieniono polityki numerycznej, limitów czasu, precyzji ani tolerancji.
Kod, OpenAPI/frontend i nowa kompilacja nie są jeszcze zweryfikowane.
Walidator noty 0950 wykonał się w istniejącym backendzie, exit 0.

Pełne Universe i jego widok browser/WebGL pozostają nieukończone. Właściwy
model prezentacji to własna niezmienna siatka zaakceptowanego H z odrębną
anteną jako źródłem. Sampling topology_digest (MeshIR) i bieżący
mesh topology_fingerprint mają różne kontrakty; nie wolno porównać ich jak
tożsamych hashy ani uznać scope=full za dowód Universe.

D: ma 27164454912 B wolnego (~25.3 GiB), poniżej 32 GiB wymaganych do kolejnego
buildu. Poproszono o zwolnienie 10–15 GiB albo wybór przeglądu konkretnych
nieużywanych zasobów. Nie wykonano usuwania i nie obchodzono preflightu.


### Odblokowanie miejsca i prerejestracja kolejnego pomiaru — 25.10.2026

Po odpowiedzi użytkownika o zwolnieniu miejsca pomiar D: wykazał
196017139712 B wolnego (około 182.6 GiB). Wcześniejsza blokada 32 GiB
nie jest już aktualna; agent nie usuwał danych ani cache.

Commit `7ee53cd83de5ab9c382a3f757852a61b288cdd7f` zachowuje zweryfikowany
odczyt/eksport historycznej inspekcji. Nie obejmuje jeszcze roboczego
kontraktu Universe, frontendu ani optymalizacji zero-copy.

Własny immutable input przygotowanego Universe potwierdza 1149 węzłów
próbkowania i 6472 Tet4, odrębnie od źródła 677 węzłów / 1861 Tet4.
Dowód: `universe-gmp-prepared-mesh-counts.json` w katalogu kontrolnym
`verification/surface-rt0-performance-20261025`. To 2138289 par
źródło–target; nie wykonano jeszcze Solve tej siatki.

Przed wykonaniem następnego pomiaru zapisano request
`gmp-zero-copy-submit-request.json`, SHA256
`d325ecaa1574a192ef31ba9b4f2234d28d5738d9d33617d385688bb65fe09a0e`.
Jedynymi zmianami względem poprzedniego wejścia są run_id oraz klucz
idempotencji. Przyszły run: `run-surface-gmp-zero-copy-20261025-01`.
Comparator `compare-gmp-zero-copy-results.py`, SHA256
`e3144b6d733ca5272d3b9c4957b1cd98e4be7271ac784d1300fb84784281718c`,
wymaga identycznych 21 payloadów, pełnych diagnostyk trzech precyzji,
liczników, ograniczeń i tolerancji oraz czasu krótszego niż 346.505338649 s.
Bazą jest zaakceptowany bundle GMP
`fa991bac1f48f2abd08ef5b35af381f43558b112141d58d1e27cd8848fcb26f5`.
Skrypt przeszedł kontrolę składni bez wykonania. Request nie został wysłany;
piny nowego zbudowanego runtime pozostają warunkiem uruchomienia.

Przed następnym zarządzanym buildem trwa zachowanie własnej przygotowanej
sceny i przejście przez istniejący kontrakt saved-authoring. Samo zapisanie
FMS lub odpowiedź 202 na cancellation nie dowodzi terminalnego stanu.
Wyniki, historia i FMS użytkownika pozostają zachowane. Pełne Universe,
nowy kontrakt API po cold-load oraz browser/WebGL nadal NOT VERIFIED.


### Zapis sceny i rzeczywisty preflight restartu — 25.10.2026

Publiczny eksport zachował pełną przygotowaną scenę w compact FMS
31040064 B, SHA256
`5086f095ed5d9e89540916cf95c98457c49a0eed007ed23bd7d8ff8b8d7d0703`.
Porównanie project/scene_document.json z bieżącym zasobem sceny wykazało
ścisłą zgodność. Parametryczna geometria nie wymaga zewnętrznych assetów.

Wykryto rzeczywisty błąd zgodności: publiczne authoring_update_blocking
zapisuje manifest.source=project/source.py, a restart akceptował wyłącznie
project/source/script.py. Commit
`d3daa9c62611b623fd80146936020c19b722cc3d` dopuszcza oba kanoniczne formaty,
zachowując osobny pin oryginalnego skryptu i wszystkie kontrole archiwum.
Commit `b15ea875191a5a1abf74b36da2b1234ab1350c38` zachowuje kontrolowaną
odmowę także dla niepoprawnych typów JSON source (lista/obiekt). Finalny
SHA256 scripts/docker_volume_dev.py:
`69ce6eb33bc312b36e8455352528a9e7e9b2e98b01a6de200a32224543fed75a`.
W istniejącym backendzie wykonano 13/13 interpretowanych regresji klasy
SavedAuthoringRestartTests, exit 0; bez kompilacji testów natywnych.

Własny przygotowany run-live-1f51b0… zakończono przez publiczne cancellation
z aktualnym CAS: katalog rev4, Cancelled, brak attempt/resource, Released.
Kontrola restartu ujawniła wcześniejszy własny manual run
run-surface-prepared-source-20261025-01, z zachowaną intencją, lecz bez
materializacji. Istniejąca publiczna materializacja i cancellation dały
rev3/Cancelled bez wykonania Solve i bez dodania grantu Start. Oryginalna
intencja pozostała identyczna; nie usunięto ani nie przeniesiono katalogu.

Publiczna nowa sesja i ReplaceScene odtworzyły dokładną scenę:
`session-18e1ddb52aba9abc000050d5`, epoch
`session-18e1ddb52aba9abc000050d5@1792957896847`, revision1, run=null,
commands=0. Archiwum autorskie 11841 B ma SHA256
`92bc31e45bf1ada09305cf5dc752fea7c4c6d710d9f9bfc8f84461f1da303527`;
pin oryginalnego skryptu zachowuje fcfba6ee… z przygotowanego Universe.

Rzeczywisty _saved_authoring_probe PASS: wszystkie 20 katalogów wykonania
są terminalne, wszystkie 36 rezerwacji Released. Checkpoint:
`verification/universe-volume-policy-20261023/gmp-rebuild-authoring-20261025/checkpoint.json`,
SHA256 `385248a64ff28d7da1f5b8d9710cf2a0e9ce031a1cd4707685bfad02490ae64a`.
Obok zachowano preflight-summary.json, źródła/publiczne odpowiedzi i logi
regresji. Nie uruchomiono dotąd restartu ani nowego Solve. Pełne pole Universe
pozostaje nieobliczone; powyższe dowody kwalifikują zachowanie sceny i stan
przed zarządzanym restartem, nie wynik naukowy ani widok WebGL.


### Zamrożenie źródeł widoku Universe przed buildem — 25.10.2026

Frontend rozdziela presentation target Airbox i immutable source owner
anteny. Wspólny source picker, Inspector oraz renderer wymagają H_ant,
zaakceptowanego wykonania i zweryfikowanego Global FEM sampling descriptor;
V/J pozostają na przewodniku. Wykorzystywana jest własna siatka wyniku,
nie bieżąca edytowalna domena magnetyczna. Przegląd wykrył i usunął regresję,
która mogła rezerwować historyczną ścieżkę dla zwykłego H_demag albo jawnego
live H_ant. Ich pozytywny kontrakt live pozostaje nadrzędny.

Zamrożono 16 plików. Nowy ArtifactInspectionSource.tsx dodano do indeksu
wyłącznie na potrzeby włączenia do managed snapshot. Pozostałe zmiany
frontendu nie są jeszcze zacommitowane. Kontrole interpretowane:
powierzchnia 36/36, selekcja 54/54, własny Universe carrier 25/25; łącznie115.
Pełna kontrola TypeScript6.0.3/noEmit na3430plikach: 0diagnostyk,94.465s.
Nie są to dowody działania przeglądarki ani rzeczywistego pola Universe.

Dowody w verification/surface-rt0-performance-20261025/universe-carrier-proposal:
frontend-source-freeze-proof.json oraz frontend-complete.patch, SHA256
`ace96cba0bba254e4ed677093722d4c7e0d60e8a66fd2df2b4201b1333fa35f7`.
Następne bramki: managed build/restart, kanoniczny OpenAPI codegen,
rzeczywisty cold-load/API oraz nowy benchmark zero-copy. Browser/WebGL
pozostaje niewykonany z powodu wcześniejszej blokady dostępu narzędzia.


### Wynik iteracji, pomiar zero-copy i rzeczywista domena cold-load — 25.10.2026

Zarządzany restart/build `39541a1e34754eddb244958a48a84897` zakończył się
succeeded, bez zmiany stałego backendu i frontendowej grupy 3203. HEAD:
`b15ea875191a5a1abf74b36da2b1234ab1350c38`; snapshot:
`5a4cca50492b62c5a979568b9700d619e1d0e64904819a515932d12f8c669212`.
Nowy libfullmag_fem.so ma SHA256
`d1fcfc75a56c3c06ffd5e83339dc07c579ebce692e35a4c1f017bbb3be1f0f9f`.
Health potwierdził pustą aktywną sesję przed jawnym odtworzeniem. Checkpoint
sceny i wszystkie wcześniejsze wyniki pozostały zachowane.

`just docker-dev-codegen` zakończył się succeeded. Wygenerowany OpenAPI ma
SHA256 `09bf003ca683953ee963b4ec237b6f9d73599837678c943b16ffb15f7ebc957d`;
locator ma opcjonalny sample_carrier. Cztery kontrole wygenerowanego klienta
Python przeszły. TypeScript 6.0.3/noEmit po codegen: 0 diagnostyk, 72.393 s.
Raport TypeScript zapisano w wolumenie frontendu jako
`/state/development/frontend-typescript-after-codegen.json`. Pierwsza próba
nie zapisała raportu, ponieważ frontend udostępnia tylko podkatalog wejść
wolumenu kontrolnego; jej wyniku nie uznano za dowód. Nie kompilowano testów
natywnych i nie przeprowadzono browser/WebGL smoke.

Jedna prerejestrowana próba `run-surface-gmp-zero-copy-20261025-01` zakończyła
się Succeeded, revision 298, task
`task-03cda8cf4c19f60c29f27b17ab066c973d7f9e948ebf9b6648487471f87ab980`,
attempt `attempt-8ebcc931ef944b509e4fb6d959158fcc`, epoch 1. Pakiet wyniku:
`7cc8c59317e189347381a61525a0bb2da816383262bbf6e0d3799e751ea4a9a9`.
Zgodność numeryczna PASS: 21 payloadów identycznych bajtowo, pełne diagnostyki
trzech precyzji, nagłówek źródła/targetów, tolerancje i prerejestrowane
liczniki pozostają identyczne. Bramka wydajności FAIL: 354.299891255 s wobec
346.505338649 s, czyli +2.2495%. Nie deklarujemy przyspieszenia zero-copy.
Peak RSS zmienił się z 545017856 na 546476032 B. Flagi obu buildów to
-O3 -DNDEBUG, konfiguracja DEV identyczna; nie ma porównywalnych delt
throttlingu rodzica z obu okien. Przyczyna różnicy czasu pozostaje nieustalona.
Dowody: gmp-zero-copy-result-comparison-failed.json i
 gmp-zero-copy-parity-and-timing.json w katalogu kontrolnym
`verification/surface-rt0-performance-20261025`.

Przed cold-load wykryto, że eksport speed (ZIP Stored), 102748559 B,
przekracza po base64 limit żądania 128 MiB. Nie zwiększano limitu.
Istniejący natywny eksport balanced zakończył się PASS: 31902967 B,
SHA256 `4aa0d0e08463a6c2f84b6e25d5c681a4f8110770725e37ed71a6e0d21a3faf45`.
Oba pliki zachowano. Z 1983 wpisów 1980 jest identycznych bajtowo; pozostałe
trzy dokumenty różnią się wyłącznie sześcioma znacznikami czasu eksportu/
projekcji. Wszystkie dane naukowe i accepted closure są niezmienione.

Jednorazowy publiczny import visualization_only zwrócił 200 i utworzył
obserwację completed, commandability=forbidden. Początkowy test błędnie
oczekiwał publicznego runtime_status_code=imported_read_only; kod
session::effective_runtime_status_code publikuje completed, podczas gdy
importer zachowuje wewnętrzny znacznik imported_read_only. Importu nie
ponowiono; kolejne kontrole są wyłącznie odczytowe.

**Korekta zakresu dowodu:** rzeczywisty zaakceptowany wynik 14-punktowy
run-live-255fa… ma sample_carrier.domain={kind:object, object_id:sampling},
carrier_kind=fem_mesh_asset:sampling, scope object/sampling. To osobny obiekt
próbkowania; nie Global Universe. Kontrola żądająca Global słusznie nie
zaliczyła tej kwalifikacji. Kod API zachował prawidłową domenę historycznego
wyniku. Nie przepisano metadanych na Global ani nie zmieniono siatki.
Przygotowano osobną odczytową kontrolę owned-object (SHA256
`0c1eac5c6a10b4edce158d15b50ec32c40270b5e8d8d25634e57c926ee94019c`).
Jej wynik należy odczytać po zakończeniu; nie jest jeszcze dowodem PASS.

Pełne Global Universe 1149 węzłów / 6472 Tet4 pozostaje nieobliczone.
Nie uruchomiono kolejnego pełnego Solve bez podstaw do zmieszczenia się
w jego istniejącym budżecie czasu. Widok browser/WebGL nadal NOT VERIFIED.


### Plan sekwencyjny i aktualizacja kontroli — 25.10.2026

Na żądanie użytkownika obowiązuje kolejność z dokumentu
[raport i plan naprawczy](2026-10-25-antenna-universe-repair-plan.md):
siatka → transport → pole → API/cold-load → UI. Komunikaty: Etap k/5.
Kontrola owned-object zakończyła się błędem HTTP, ale zdążyła potwierdzić
H_ant: 14 próbek, A/m, własną topologię i 5 negative pin checks. Pełny
V/J/H cold-load nadal niezaliczony; nie ponawiano importu ani Solve.
Poprawka dostępności drzewa Airbox: 6 scenariuszy PASS, focused ESLint PASS,
TypeScript 6.0.3/noEmit: 0 diagnostyk, 215.509 s. Browser NOT VERIFIED.
Pełne Global Universe nadal nieobliczone.
