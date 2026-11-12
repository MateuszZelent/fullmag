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

Integracja źródłowa obejmuje wyłącznie kopię. Rzeczywista kopia, przełączenie
bindów, admission, odtworzenie grupy, kwalifikacja Zarr, rejestracja i usunięcie
starych duplikatów pozostają **NOT VERIFIED**.

## Weryfikacja

Lekkie testy obejmują zamknięte rejestracje, UUID/inode, aliasowanie datasetów,
zachowanie ACL/mtime/hardlinków, podmiany namespace, ctime oraz skopiowane
admission. Nie dowodzą rzeczywistego formatu urządzenia ani działania Dockera.
Odbiór hostowy wymaga osobno create/attach receipts, identyfikacji nowego
urządzenia, rzeczywistych mountów hosta i kontenera, kompletności danych,
świeżego probe oraz kwalifikacji pierwszego pełnego Zarr po migracji.
