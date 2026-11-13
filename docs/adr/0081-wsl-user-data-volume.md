# ADR 0081: Osobny ext4 dla danych jednej grupy DEV w WSL

Status: decyzja przyjęta 12.11.2026 dla autoryzowanej migracji SP4. Wdrożenie
etapowe; provisioning, przełączenie grupy i kwalifikacja runtime pozostają
**NOT VERIFIED** do czasu wykonania i zachowania odpowiednich dowodów.

## Kontekst

Pełne Zarr oraz ślady profilera SP4 zapełniają główny filesystem WSL. Sam nowy
obraz lub pozostawienie drugiej kopii na tym samym filesystemie nie zwolnią
miejsca. Jednocześnie zastąpienie ścieżki katalogu nie dowodzi zastąpienia
bindu widzianego przez Docker Desktop. Istniejący readmit po restarcie celowo
wymaga zachowania inode i nie kwalifikuje skopiowanego StateRoot.

## Decyzja

1. Dane użytkownika jednej grupy mogą otrzymać osobny, jawnie zarejestrowany
   ext4 w nowym dynamicznym VHDX. Lokalizację pliku obrazu wybiera operator
   według obowiązującej decyzji hostowej. Nie przejmujemy markera projektu
   katalogu nadrzędnego obrazu. Utworzenie używa wyłącznie create-new, bez
   usuwania, nadpisywania, compact lub resize istniejących obrazów.
2. Dwa datasety to dokładny katalog `user-data/<compose-project>` oraz dokładny
   StateRoot danej instancji, obejmujący sesje i dowody admission. Kanoniczne
   ścieżki i `FULLMAG_PROJECT_STORAGE_ROOT` pozostają zachowane przez bindy.
   Inne grupy, źródła, prywatne volume control/ledger, shared cache i BuildKit
   zachowują swoje dotychczasowe granice z ADR 0067 i 0076.
3. Rejestracja `fullmag.user-data-volume.v1` jest lokalna dla worktree:
   `storage/index/data-volumes/<worktree_id>.json`. Zamknięty model wiąże
   projekt, grupę, volume ID, obie postacie ścieżki backing file, FSUUID,
   mount root, oba datasety i SHA receiptu zakończonej migracji. Istniejący
   indeks worktree otrzymuje referencję `data_volume_registration` z dokładną
   ścieżką, SHA pliku i volume ID. Brak obu oznacza zwykłą grupę; obecność
   tylko jednej strony, drift albo brak mountu oznaczają odmowę.
4. Rejestracja ma stan `committed` dopiero po kwalifikacji danych, nowej
   admisji, rzeczywistych bindów i zapisu. Przed rejestracją nie wolno używać
   zaproponowanej konfiguracji jako dowodu zakończonej migracji. Po rejestracji
   launcher odmawia przed pierwszym zapisem, jeśli UUID, urządzenie lub inode
   bindów nie odpowiadają wolumenowi. Nie tworzy cichego zastępczego storage.
5. Przeniesienie wymaga zarządzanego drainu jednej dokładnej grupy, blokad
   lifecycle/writer, kontroli konsumentów i niezależnego porównania obu drzew.
   Manifest obejmuje zawartość, ścieżki, UID/GID, tryb, nanosekundowe mtime,
   xattrs/ACL i topologię twardych linków. Odrzuca symlinki, pliki specjalne,
   obce urządzenia oraz drift. Ctime i inode służą kontroli wyścigów; nie są
   przenośnymi metadanymi porównywanymi pomiędzy filesystemami.
6. Oryginalne bajty i metadane zachowujemy także w pełnym archiwum PAX na
   nowym ext4. Chroni to historię, gdy nowy runtime legalnie zmieni katalogi
   sesji, SQLite lub evidence admission. Archiwum oraz kopia robocza znajdują
   się na nowym filesystemie, poza przepełnionym WSL root. Budżet uwzględnia
   dwukrotność rozmiaru logicznego danych oraz co najmniej 25 GiB zapasu na
   następne Zarr. Brak tego miejsca blokuje kopiowanie przed utworzeniem archiwum.
7. Zmiana inode StateRoot otrzymuje osobny, przypięty successor admission.
   Zachowuje owner token, obrazy, źródła oraz oryginalne pięć plików evidence
   w archiwum. Samo przygotowanie następcy nie przyznaje namespace ani nie
   uruchamia runtime; wymagany jest nowy probe z SHA aktualnego certyfikatu
   i inode nowego rootu. Rebootowy readmit nie zostaje poszerzony.
8. Usunięcie starych duplikatów WSL wymaga autoryzacji operatora, pełnego
   porównania/archiwum, dowodu nowego runtime i Zarr oraz świeżej kontroli
   procesów, mountów, kontenerów, lease i referencji. Receipt nie uchyla tych
   bramek. Bez kwalifikacji zachowujemy obie kopie. Nigdy nie kasujemy nowego
   obrazu automatycznie w rollback ani nie dotykamy istniejących danych dysku
   docelowego.
9. Przebudowa grupy przed migracją nie zmienia zatwierdzonego planu ani
   receiptów Create/Attach. Jawny, niezmienny rekord następcy runtime może
   wskazać nową parę kontenerów na tych samych fizycznych datasetach i przy
   tych samych budżetach. Nie przyznaje prawa do drainu, kopii, admission ani
   cutover; każdy z tych etapów nadal wymaga własnych aktualnych dowodów.

## Zobowiązania implementacji

Modele i porównania należą do `fullmag_data_volume.py`,
`fullmag_data_volume_manifest.py` i `fullmag_data_volume_fs.py`. Osobny
`linux_native_data_volume_migration.py` przygotowuje następstwo admission.
Guard hosta, sterownik migracji, helper Windows i recepty launchera mają
odrębne testy. Resolver pozostaje odczytowy: nie tworzy ani nie montuje dysku.
Etapy Linux rozdzielają odczytowy `probe` i `preflight` od jednorazowego
`format-mount`. `docker_data_volume_linux.py` wiąże wybrany checkout, grupę,
dystrybucję WSL oraz SHA requestu i źródeł, utrzymując blokadę grupy podczas
formatowania. Recepty `just` przekazują wyłącznie zamknięte argv; nie uruchamiają
ogólnego `prepare-links` z innym profilem storage. Wywołanie WSL korzysta
z chronionej ścieżki System32, bez wyszukiwania programu przez PATH.

`fullmag_data_volume_runtime_binding` definiuje zamknięty rekord
`fullmag.data-volume-runtime-binding.v1` w
`migrations/data-volumes/<volume_id>/runtime-bindings/<sha256>.json`.
Producent kwalifikuje dokładne receipty stopu, odtworzenia usług i nowego
udanego startu oraz bieżące kontenery, obraz, konfigurację, źródła, admission
i niezmienione device/inode obu rootów. Wspólny uwierzytelniony stop wiąże
odtworzenie i start jako `diamond-by-common-stop`; sam ten związek nie dowodzi
bezpośredniej przyczynowości ani wyłączności pomiędzy tymi operacjami.
Rekord zachowuje SHA obecnego certyfikatu, owner markera i probe oraz wyłącznie
hash obecnego owner tokenu. Nie dowodzi jego historycznej ciągłości:
`historical_owner_continuity=not-proven`. Tę granicę zachowują także dwa
obowiązkowe pola `namespace_admitted=false` i `data_migrated=false`.

Request `fullmag.data-volume-linux-provision.v2` wybiera wyłącznie jawny,
niepusty SHA takiego rekordu. Przypina on także bajty modułu odczytującego
binding. Request v1 zachowuje dotychczasowe zachowanie i nigdy sam nie wybiera
ostatniego znalezionego rekordu. Konsumenci otrzymują oddzielnie oryginalne
bajty planu oraz pochodny widok z nowymi `runtime_pins` i obserwacjami usług;
oryginalny plan i jego SHA w journalu pozostają niezmienione. Pozostałe
historyczne obserwacje nie stają się przez to świeżymi dowodami. Etap kopii
przypina SHA requestu Linux, zachowując powiązanie z tym samym bindingiem,
i ponawia pełną obserwację zatrzymanej grupy pod żywymi guardami.

`linux_data_volume_provision.py` wymaga zgodnych receiptów Create/Attach,
inwentaryzacji sprzed Attach, tego samego bootu i trwałej przestrzeni mountów
PID 1. Wybiera dokładnie jedno nowe, puste urządzenie o zadanej pojemności;
odrzuca partycje, sygnatury, UUID istniejących filesystemów i urządzenie
oryginałów. `linux_data_volume_format.py` utrzymuje przypięty FD urządzenia,
sprawdza chronionego rodzica mountu przed `mkfs` i nie używa wymuszenia formatu.
Nie przyjmuje ścieżki `/dev` od operatora.

Terminalnie nieudana próba pozostaje zachowana. Jawne recovery wskazuje SHA
poprzedniego, nieudanego dziennika oraz nowy dziennik tej samej operacji;
przy ponowieniu Attach wykorzystuje zweryfikowany receipt Create. Stan
`started`, błąd lub nieznany wynik formatowania blokują jego powtórzenie.
Zielone testy tych etapów nie zastępują rzeczywistego Attach, formatu i mountu.
Migrator musi utrzymywać przypięte FD katalogów docelowych i wyłączną kontrolę
ich namespace; nie zakładamy ochrony przed wrogim rootem tego samego hosta.
Kontekst `docker_dev_data_volume_copy.copied_group` zachowuje hostlock również
przez kontynuację po zweryfikowanej kopii. Kończy operację Docker kopii przed
oddaniem sterowania, aby następna faza mogła uzyskać własny lease bez
zagnieżdżania operacji. Samodzielne `copy_data_volume` pozostaje etapem kopii;
nie zastępuje pełnego migratora i nie uprawnia do wznowienia grupy.

Prymityw `fullmag_data_volume_bind.switch_roots` nie ma samodzielnego CLI.
Po świeżym porównaniu obu drzew zachowuje oryginały przez atomowe
`renameat2(RENAME_NOREPLACE)`, tworzy root-owned underlay `000` i przypina
bindy do FD zweryfikowanych kopii. Przed zmianą propagacji nowego bindu musi
potwierdzić dokładny nowy device/inode; błąd pozostawia wszystkie zasoby.
Mount zawierający każdy oryginalny parent musi być `private` przed pierwszym
rename i przy ponownej kontroli przed mutacją. Prywatność źródła nie izoluje
operacji pod `shared` parentem
([semantyka bind kernela](https://docs.kernel.org/filesystems/sharedsubtree.html)).
Prymityw nie wykonuje admission, startu ani usuwania. Przed jego podłączeniem
do rzeczywistego migratora wymagany jest trwały interlock blokujący zwykły
startup w częściowo przełączonym stanie; sam hostlock nie przetrwa zabicia
całego supervisora. To zobowiązanie integracji, nie dowód jej wykonania.

Odczytowy interlock `fullmag_data_volume_pending` rozpoznaje niezmienny marker
`index/data-volumes/<worktree_id>.pending.json`. Migrator ma go opublikować
po potwierdzonej kopii i przed pierwszym rename, poza oboma datasetami, pod
ciągłymi guardami. Marker wiąże dokładny projekt, checkout, grupę, wolumen,
oba kanoniczne rooty oraz SHA planu, requestu Linux i kopii. Domyślny launcher
odmawia przed pierwszym zapisem, także gdy brak zwykłej rejestracji. Uszkodzony,
obcy lub niepełny marker oznacza odmowę; nie uruchamia recovery automatycznie.
Końcowa pasująca rejestracja nadal musi przejść pełne guardy UUID/inode.
Marker pozostaje historycznie zachowany. Grupy bez markerów nie zmieniają
zachowania. Sam interlock pozostaje odczytowy i nie udziela wyjątku
migracyjnemu recreate. Publikację markera realizuje oddzielny etap root
opisany poniżej; jego nadrzędny sterownik nadal wymaga integracji.

Decyzja nie zmienia Python DSL, ProblemIR, fizyki, backendu realizującego krok,
OpenAPI ani zachowania UI. Migracja nie powtarza Solve. Dane wymagane do
interpretacji i wznowienia pozostają na hostowym ext4 lub w pełnym Zarr.

## Awaria i rollback

Przed cutover źródła WSL pozostają aktywne. Po częściowej zmianie bindów grupa
pozostaje zatrzymana, a journal określa dokładny osiągnięty etap. Recovery
uzgadnia istniejący własny obraz; nie formatuje go ponownie. Po nowych zapisach
na ext4 nie wracamy do starszej kopii bez zachowania i uzgodnienia tych zapisów.
Zerwanie mountu po restarcie powoduje odmowę, nigdy zapis do pustego underlay.

Inwentaryzacja migracji może osobno kwalifikować referencję zatrzymanego
kontenera do nieistniejącej już ścieżki Windows. Wymaga dokładnego stanu
`exited`, PID 0 oraz odczytowego dowodu stałego NTFS/ReFS bez reparse points
we wszystkich istniejących przodkach. Nie zmienia to ścisłego probe aktywnych
bindów ani readmission runtime. Stan kontenera i proof trzeba odświeżyć przed
przełączeniem; cache dotyczy tylko jednego snapshotu i uwzględnia stan kontenera.

Kopiowanie wymaga nowego, uwierzytelnionego stop-only receiptu. Historyczny
witness udanego startu nie dowodzi późniejszego drainu. Oprócz blokady hosta
i lease kontrolera trzeba utrzymać pięć istniejących blokad: `STARTUP-GATE`,
`LAUNCH`, `OWNER`, writer ledgera, następnie writer accepted-store. Odczytowy
snapshot zwalniający FD przed kopiowaniem nie spełnia tego warunku.

Moduły `data_volume_copy_fences.py` i `data_volume_copy_fence_service.py`
utrzymują te FD przez całą chronioną operację. Native Ready→Drained jest
uwierzytelniany kodem z przypiętego obrazu backendu. Wspólny walidator
`data_volume_released_state.py` sprawdza release proofs i obie rodziny lease;
dotychczasowy krótki snapshot i nowy dłuższy guard używają tej samej walidacji.

`docker_data_volume_copy_guard.py` wymaga zatrzymanego backendu i aktywnego
lease tej migracji. Helper techniczny ma readonly mounty i oddzielną sesję
procesu; Docker nie przekazuje do niego sygnałów klienta. Zerwanie IPC,
nieprawidłowa wiadomość albo wyjście sterownika bez potwierdzonego wyniku
kopii zachowują guardy i stan nieznanego wyniku. Dopiero jawny terminalny SHA
kopii pozwala na release. [Opcja Docker](https://docs.docker.com/reference/cli/docker/container/run/).
Te moduły nie wykonują samego transferu, drainu ani admission; ich integracja
z pełnym sterownikiem i rzeczywiste wykonanie pozostają **NOT VERIFIED**.

Etap `linux_data_volume_copy.py` wykonuje zachowującą metadane kopię dopiero po
uwierzytelnieniu pierwotnych inode, bootu WSL, receiptu formattera, UUID/dev/inode
nowego mountu i markera jego własności. Zamknięty request przypina źródła etapu,
terminalny drain grupy i obserwację pięciu guardów. Zapisana obserwacja nie
zastępuje ich żywej blokady: nadrzędny sterownik musi utrzymywać helper i lease
do potwierdzonego zakończenia procesu kopii, także po przerwaniu kanału IPC.

Etap tworzy nowe archiwum PAX oraz payload, porównuje pełny manifest i zapisuje
osobny terminalny receipt `copied-and-verified-not-switched`. Nie zmienia bindów,
admission, rejestracji ani oryginałów. Częściowe pliki zachowuje; istniejący cel,
rozpoczęta faza i błąd blokują automatyczne ponowienie. Błąd publikacji journalu
po zapisaniu wyniku jest stanem nieznanym, nie potwierdzeniem sukcesu.
Archiwizacja używa wyłącznie `/usr/bin/tar` z minimalnym środowiskiem;
odziedziczone `PATH` i `TAR_OPTIONS` nie mogą zmienić uprzywilejowanej operacji.
`docker_dev_data_volume_copy.py` wiąże etap z istniejącym stopem grupy,
blokadą hosta, lease kontrolera i żywym helperem pięciu guardów. Przed kopią
ponawia pełną obserwację zatrzymanych kontenerów i konsumentów pod guardami.
Zmiana ID, StartedAt, konfiguracji lub native stop proof powoduje odmowę.
Recepta `docker-dev-data-volume-copy` przyjmuje zamknięte argv i nie wykonuje
drainu, uruchomienia ani ponowienia Solve.

`docker_data_volume_copy_job.py` obserwuje ten sam proces WSL aż do jego
zakończenia oraz zgodnego terminalnego receiptu i journalu. Kontrolowany błąd
obserwacji, brak receiptu lub przerwanie nie wypuszczają supervisora poza
zakres hostowego flock. Pierwszy błąd jest zachowany i zgłaszany po bezpiecznym
potwierdzeniu terminalu; nie uruchamia się nowego procesu i nie zabija starego.
Jeśli potwierdzenie nie jest możliwe, supervisor i guardy pozostają zachowane
do recovery. Twarda śmierć całego supervisora wymaga osobnego uzgodnienia
zachowanych lease i native guardów; nie deklarujemy przeżycia hostowego flock
po `SIGKILL` jego właściciela.

Etap `linux_data_volume_bind` udostępnia API bez samodzielnego CLI. Przyjmuje
zamknięty request z SHA istniejącego requestu kopii, jej terminalnego wyniku,
nowej obserwacji guardów i źródeł etapu. Odczytowy widok zakończonej kopii
w `linux_data_volume_copy.load_context` wymaga dokładnego receiptu i journalu
oczekującego na `binds-switched`; zwykłe wejście kopii nadal odmawia jego
ponowienia. Wspólny walidator wyniku kopii służy także supervisorowi WSL.

Przed cutover etap sprawdza źródłowy manifest i strumieniowo SHA zachowanego
PAX oraz zajmuje istniejący writer lock skopiowanego accepted-store. Nie
tworzy zastępczego pliku blokady. Pod mutexem migracji i wymaganymi żywymi
guardami nadrzędnego sterownika publikuje niezmienny marker pending przez
create-new i fsync, przed pierwszym rename. Każdy callback prymitywu zapisuje
oddzielny trwały intent lub obserwację poza oboma datasetami. Błąd po
publikacji markera zachowuje stan wymagający jawnego recovery, w tym
wszystkie drzewa i blokadę zwykłego startupu. Etap nie wykonuje admission,
startu, rejestracji, rollback ani usuwania.

Zarządzana recepta obejmuje obecnie kopię; root bind API musi zostać podłączone
do supervisora utrzymującego rzeczywiste guardy aż do zgodnego terminalu.
Same zapisane acknowledgements nie dowodzą ich utrzymania. Rzeczywista kopia,
przełączenie bindów, admission, odtworzenie grupy, kwalifikacja Zarr,
rejestracja i usunięcie starych duplikatów pozostają **NOT VERIFIED**.

## Weryfikacja

Lekkie testy obejmują zamknięte rejestracje, UUID/inode, aliasowanie datasetów,
zachowanie ACL/mtime/hardlinków, podmiany namespace, ctime oraz skopiowane
admission. Nie dowodzą rzeczywistego formatu urządzenia ani działania Dockera.
Odbiór hostowy wymaga osobno create/attach receipts, identyfikacji nowego
urządzenia, rzeczywistych mountów hosta i kontenera, kompletności danych,
świeżego probe oraz kwalifikacji pierwszego pełnego Zarr po migracji.
