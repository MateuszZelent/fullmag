# ADR 0066 — kontynuacja generacji po buildzie przed nowym ownerem

Status: implemented; odbiór runtime **NOT VERIFIED**.

## Kontekst

Backend DEV może opublikować poprawny pakiet i przejść bramki storage/cgroup,
a następnie zakończyć się przed utworzeniem nowego native ownera. Pozostaje
historyczny owner `Failed` oraz starszy process-tree. Zwykły restart nie może
uznać tego rekordu za udany drain bieżącej inkarnacji.

Istniejąca ścieżka kontrolowanego odtworzenia już przekazuje świeży
`previous_config_sha256` do backendu. `ensure_configuration` porównuje dokładne
stare bajty i pozwala zmienić wyłącznie `runtime_generation_sha256` przy
identycznym profilu operatora. Sam zapisany w Compose stary hash nie jest
wystarczającą autoryzacją: restart po zakończeniu operacji hosta mógłby go
użyć ponownie, jeśli pierwsza próba zakończyła się jeszcze przed rotacją.

## Decyzja

Rozszerzamy hostowe ustalenie kontekstu kontrolowanego odtworzenia oraz
dodajemy minimalną kontrolę jego jednorazowego użycia w runtime.
Odrębny, zamknięty rekord metadanych wiąże niezmienny oryginalny stop/accepted
proof, nadal ten sam `Failed OWNER.json`, process/archive raw digests, aktualną
zatrzymaną inkarnację kontenera, certyfikat i held catalog/start-release.
Świeży hash natywnego `docker-all.json` jest odczytywany pod `OWNER.lock`.
Hash konfiguracji Compose pozostaje innym pinem.

Historyczny journal nie staje się journalem nowego kontenera. Bieżący
stopped-namespace proof jest oddzielny; samo istnienie starego process-tree
nie dowodzi, że nowy API nigdy nie wykonał kodu. Obcy owner, nowy ACK/claim,
zmieniony katalog lub brak wymaganych dowodów blokują tę ścieżkę. Sprawdzamy
zakres tej aplikacji/runu; obca grupa nie musi być zatrzymana i ledger całego
hosta nie musi być pusty.

Caller porównuje cały kontekst przed operacją oraz pod lease `recreate-services`
bezpośrednio przed stop/rm. Ta operacja kończy się przed przygotowaniem obrazów
i startem. Kontekst musi więc zostać sprawdzony ponownie pod nowym lease
`development`, przed zmianą certyfikatu, alokacją cache/ledgera i utworzeniem kontenera. Nie trzymamy starego lease podczas
zagnieżdżonych operacji BuildKit. Nowa operacja zapisuje zamknięte powiązanie
pending z własnym attemptem i hashem kontekstu w control volume oraz przekazuje
runtime ścieżkę i SHA tego rekordu. Nie przedstawia go jako
`native_restart_metadata` lub container recovery.
Incoming image i pakiet przechodzą dotychczasowe rzeczywiste bramki buildu;
nie wymagamy nieistniejących jeszcze przyszłych digestów w stop proofie.

Dotyczy to opublikowanego profilu `restart_verified=true`. Wyjątek
false-bootstrap pozostaje odrębny. Nie resetujemy ownera, nie zwalniamy
zasobów i nie powtarzamy Solve. Dotychczasowa kontrolowana rotacja pól obrazu
certyfikatu zachowuje jego zamkniętą tożsamość hosta; bramka storage ponownie
potwierdza gotowość przed wejściem do API. Istniejący natywny
`service-ensure` nadal odpowiada za nowy claim po stanie terminalnym.

## Zachowanie pending po błędzie odczytu źródeł

Odtworzenie bieżącego kontenera, który zakończył się podczas source capture,
może zachować już istniejącą, niezużytą kontynuację. Wymaga oddzielnego dowodu
`pre_admission_recreate` dla tej inkarnacji, przed `Make`, publikacją i API.
Kanoniczne current i terminal próby, pending binding, Compose, źródła,
konfiguracja oraz pełny producent accepted-run muszą wskazywać tę samą próbę.
Rekord consumed wyklucza tę ścieżkę.

Historyczne `post_build_generation` pozostaje niezmienione i związane ze swoim
oryginalnym `recreate_operation`. Dowody starego ownera, process-tree,
konfiguracji i nieobecności starego namespace są sprawdzane przed operacją
oraz pod lease. Dowód capture nie zastępuje brakującego natywnego receiptu
bieżącego kontenera. Nowy start tworzy własny binding przez istniejące
`prepare_start_binding`; nie powtarza Solve.

Wznowienie tak zakończonego odtworzenia wymaga obu zapisanych dowodów, pustego
native recovery contextu i nadal `restart_verified=false`. Ponawia walidację
terminalu, failure logu, bindingu oraz historycznej kontynuacji. Nie awansuje
certyfikatu do `true`. Zwykłe wznowienie natywne zachowuje dotychczasową ścieżkę.
Błąd Make, rozpoczęta publikacja lub zużyty binding pozostają poza zakresem.
Implementacja obejmuje `docker_volume_pending_continuation.py`, caller w
`docker_volume_dev.py` i odpowiadające regresje; odbiór na rzeczywistym storage
pozostaje **NOT VERIFIED** do udanego startu API/native.

## Ponowienie i późniejszy restart

Zachowujemy obecne zabezpieczenia rotatora: dokładny backup
`docker-all.previous-<sha>.json`, kontrolę starego hasha i atomową publikację.
Ponowienie przy konfiguracji już równej expected nie wykonuje drugiej rotacji.
Przed użyciem starego pinu runtime wymaga dokładnego powiązania pending,
zgodnego aktualnego attemptu `development`, utrzymywanego lease i braku
terminala tej operacji. Sam plik active nie dowodzi utrzymywania lease.
Kontrola obejmuje również niezmienione piny ownera, process-tree i accepted.
Po poprawnej rotacji albo potwierdzonym no-op powstaje niezmienny rekord
consumed. Nie tworzymy dodatkowego protokołu intent: atomowy backup i rotator
pozostają istniejącą granicą publikacji konfiguracji.

Zmienna ze starym pinem może pozostać w środowisku kontenera, ale consumed
wyłącza jej specjalne uprawnienie. Późniejszy restart korzysta ze zwykłego
uwierzytelnionego drain. Pending z zakończonej lub niepotwierdzonej operacji
nie pozwala na rotację po restarcie w Docker Desktop. Kontrolowane ponowienie
przez launcher ponownie zbiera dowody pod nowym lease; nie resetuje ownera.
Po przerwaniu między publikacją configu a zapisem consumed ta sama nadal
aktywna operacja może dokończyć zapis bez drugiej rotacji. Zakończona operacja
wymaga świeżego kontrolowanego kontekstu, z weryfikacją backupu i profilu.

Jeżeli host odrzuci nowy start jeszcze przed zmianą certyfikatu i publikacją
Compose/cache, `development/current.json` może wskazywać tę nieudaną próbę.
Wznowienie zakończonego odtworzenia zachowuje oryginalny development attempt
jako punkt odniesienia. Dopuszcza wyłącznie kanoniczny terminal
`failed-confirmed`, dokładnie powiązany z tym samym dowodem odtworzenia,
źródłami, profilem urządzeń, konfiguracją i pełnym producentem accepted-run.
Istniejąca projekcja accepted-run w continuation musi odpowiadać temu
producentowi. Wymagane są pending binding, brak aktywnego lease, consumed,
Compose oraz artefaktów cache/runtime. Kolejne takie odrzucenie może być
wznowione tylko z identycznym przypiętym dowodem; stan unknown lub rozpoczęta
publikacja wymagają osobnej właściwej procedury. Nie cofamy current ani historii.
Przed nową operacją i pod jej lease pozostają dotychczasowe rewalidacje ownera,
konfiguracji, certyfikatu, accepted-run i nieobecności starych kontenerów.

## Zakres, walidacja i wycofanie

Zmiana obejmuje hostowy helper/launcher, runtime guard i regresje. Nie zmienia solverów
FDM/FEM CPU/GPU, Python DSL, ProblemIR, OpenAPI ani natywnego protokołu claimu.
Wymagane są realistyczne testy opublikowanego profilu, driftu, braku dowodów,
rozróżnienia historycznego i bieżącego kontenera oraz rewalidacji pod lease.
Istniejące testy rotacji/replay/drain pozostają obowiązujące. Dodatkowo
wymagane są regresje zakończenia operacji przed rotacją, replay starego env,
przerwania po publikacji przed consumed i zdrowego restartu po konsumpcji.

Oddzielny dowód stanowi rzeczywisty start API/native ownera na zachowanym
storage. Build i fixture nie kwalifikują stabilności, GPU ani fizyki. Do uzyskania
dowodów status pozostaje **NOT VERIFIED**. Wycofanie launchera pozostawia rekordy
jako historię; nie usuwa konfiguracji, ownera ani lease.

## Odrębny checkpoint anulowania przed API — 21.10.2026

`stop-pre-api-start` dotyczy wyłącznie własnego startu `fullmag-master`, który
opublikował pakiet i nadal czyta historyczny rollback przed bramką cgroup/API.
Nie jest rozszerzeniem wariantu API exit101 ani drugim certyfikatem pre-ACK.
Domyślnie wykonuje odczytowy podgląd. Zastosowanie wymaga jawnego `--apply`.

Pod lease bieżącej operacji i podległym mutexem sprawdza jej uwierzytelniony
helper, dokładną inkarnację, jedyny proces `backend_dev.py start`, brak jego
dzieci i jeden deskryptor O_RDONLY historycznego artefaktu. Po wstrzymaniu
przypiętego procesu ponownie potwierdza ten stan oraz brak requestu bieżącej
bramki cgroup. Zachowuje create-only intent i wysyła raz SIGTERM/SIGCONT przez
pidfd. Nie dotyka skompilowanego pakietu, backupów ani aktywacji symulacji.

Receipt `stopped-confirmed` wymaga faktycznego exited143/non-OOM/PID0 tej samej
inkarnacji oraz niezmienionego pierwszego pre-ACK proof, Failed ownera,
process-tree, natywnej konfiguracji, held katalogu bez start_release i dowodów
zwolnionych zasobów. Pierwotny kontroler sam obserwuje wyjście, zapisuje własny
terminal i zwalnia własny lease; komenda nie robi tego za niego. Wynik nieznany
blokuje następną próbę zamiast ponowienia sygnału albo resetu ownera.
Po potwierdzonym zgonie `--finalize` pozwala ponownie dowieść tego samego
stopped namespace i domknąć przerwaną publikację receipt pod osobnym lease;
nie ponawia sygnału. Receipt wiąże raw SHA intentu i jego niezmienne pola.
Utrata hostowego polecenia po ARM może pozostawić sam start w SIGSTOP jeszcze
przed publikacją intentu. Odrębne `--resume-unissued` wymaga aktywnego oryginalnego
kontrolera, własnego mutexu, świeżego checkpointu oraz dwukrotnie potwierdzonego
braku zarówno intentu, jak i nazwanego helpera publikacji. Dopiero wtedy może
wznowić przypięty PID; obecny lub nieznany publisher/intent wyklucza SIGCONT.

Hostowy konsument ponownie sprawdza stopped incarnation i wszystkie piny.
Przenosi dokładnie istniejący kontekst pierwszego pre-ACK. Ponieważ natywna
konfiguracja nie została zmieniona, nie emituje post-build generation proof.
Wariant101 i zwykłe restarty zachowują dotychczasowe bramki. Nowy runtime nadal
waliduje aktualny pakiet, storage, istniejący accepted proof i tworzy ownera
zwykłym service-ensure. Brak testów w tej sesji wynika z jawnej decyzji użytkownika;
odbiór tego nowego checkpointu pozostaje NOT VERIFIED przed rzeczywistym apply.

### Restart zakończony błędem capture, bez API

`checkpoint-pre-api-failure` obserwuje wyłącznie już zatrzymaną inkarnację
exit2/non-OOM/PID0. Nie zatrzymuje i nie uruchamia usługi. Osobny discriminant
`observe-capture-failure` wiąże dokładne timestampowane stdout/stderr z
StartedAt/FinishedAt. Istniejący validator capture-only wyklucza ukończony
capture, build, pakowanie, handoff, gate, API i native runtime. Logi są zachowane
w control volume; konsument ponownie porównuje je z istniejącym kontenerem,
a po usunięciu kontenera korzysta z dokładnego archiwum i zamkniętego proof
recreation. Przerwana publikacja może zostać domknięta przez `--finalize`,
bez sygnału i bez ponowienia aktywacji.

Niezmienione piny pierwszego pre-ACK, ownera/process/config i held runu są
sprawdzane przed i po obserwacji pod nowym lease. Nie jest to certyfikat
nowego błędu API, successful drain ani zamiana starego journalu. Wariant
`cancel-retention` nadal wymaga exit143; capture-only wymaga odrębnie exit2
i jego własnych logów. Dopiero tak zwalidowany `PreApiContext` pozwala użyć
istniejącego pierwszego kontekstu pre-ACK przy standardowej recreation.
