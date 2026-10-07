# Lokalny runner kontenerowy

## Obecna architektura i ograniczenia

Jeden stały `Fullmag_build_runner` posiada kolejkę SQLite, API i dostęp do Docker
Engine. Windows jest klientem: rozwiązuje worktree/storage, przygotowuje niezmienną
kapsułę kodu i zgłasza job. Koordynator uruchamia osobny kontener builda z katalogu
profili. Tylko jeden ciężki job może zajmować slot; praca edytorów na innych
worktree nie wymaga zatrzymywania bieżącej kompilacji.

Socket Docker jest szerokim uprawnieniem zaufanego operatora. API wymaga bearer
tokena i jest publikowane tylko na `127.0.0.1:48765` (domyślnie, konfigurowane przez `FULLMAG_RUNNER_PORT`); nie wystawiaj go do LAN.
Token pozostaje w lokalnym storage, nigdy w repozytorium ani w payloadzie joba.
Worker nie otrzymuje socketu/tokena, `.env` ani checkoutu hosta. Ma UID 65532,
rootfs readonly, ograniczenia CPU/RAM/PID oraz prywatne katalogi wykonania.
Sieć workera służy pobieraniu zależności. To nie jest izolacja niezaufanych PR.

Stan wdrożenia: koordynator uruchomiony i API sprawdzone; testy modułów przechodzą.
Pełny build FEM CPU release potwierdzono terminalnym sukcesem kolejki, receipt
i hashami 109 artefaktów; źródła i obrazy są zapisane w
[checkpointcie](../superpowers/plans/2026-09-11-local-runner-implementation-status.md).
Crash/restart aktywnego workera, FEM GPU, uruchomienie aplikacji, kwalifikacja
naukowa i wydania pozostają **NOT VERIFIED**.
Nie nadawaj etykiety `fem-managed` na podstawie samego startu kontenera.

## Konfiguracja i obsługa

Hostowe `FULLMAG_PROJECT_STORAGE_ROOT` pozostaje w `.env` głównego checkoutu.
Nowy worktree korzysta z resolvera i rejestru, nie potrzebuje kolejnego runnera
ani własnego `.env`. Konfiguracja kontenera i profili jest współdzielona.

```text
just runner-coordinator-image
just runner-container-configure sha256:<image-id-koordynatora>
just runner-container-start
just runner-container-status
```

Obraz workera powstaje z istniejącego, świadomie wybranego obrazu toolchaina:
`just runner-build-image <lokalny-tag-toolchaina>`; sprawdź jego immutable ID,
a następnie `just runner-configure-build fem-cpu-release sha256:<image-id-workera>`.
Sama obecność profilu w katalogu nie oznacza konfiguracji obrazu ani walidacji.
Aktualnie konfigurowana trasa to FEM CPU; FEM GPU/FDM CPU wymagają osobnych dowodów.

Z wybranego, zarejestrowanego worktree:

```text
just runner-build snapshot fem-cpu-release
just runner-build commit fem-cpu-release <pelny-commit-sha>
just runner-status <job-id>
just runner-logs <job-id>
just runner-wait <job-id> 30
just runner-cancel <job-id>
```

Snapshot obejmuje pliki śledzone i usunięcia. Nowe wejścia trzeba jawnie wskazać:

```text
python scripts/local_runner_cli.py --worktree <absolutny-worktree> submit --operation build --profile fem-cpu-release --source snapshot --include-untracked <plik-wzgledny>
```

Wstrzymaj edycje wszystkich agentów na czas capture. Zmiana podczas kopiowania
odrzuca zgłoszenie. Po utworzeniu kapsuły można dalej edytować branch; build
otrzymuje kopię, a nie późniejszy stan ścieżki. SHA kapsuły i natywna tożsamość
`fullmag.source-snapshot.v2` są różnymi, powiązanymi dowodami.

Kopia wykonania musi otrzymać świeże mtime plików, a nie czasy z chwili capture.
`materialize_capsule` kopiuje bajty przez `copyfile`, odtwarza tryby z manifestu
i sprawdza size/SHA. Dzięki temu starsza oczekująca kapsuła nie dziedziczy
pozornej aktualności zależności z później zapisanej wspólnej pamięci Cargo/Make
przy stałej ścieżce `/workspace`. Kapsuła i cache pozostają niezmienione.
Regresja tej poprawki przeszła lokalnie; produkcyjne wdrożenie pozostaje
**NOT VERIFIED**, dopóki nowy obraz koordynatora nie dostarczy poprawionego
`/runner/build_entrypoint.py` i pełny build nie przejdzie. Zmiana skryptu
wyłącznie w kapsule nie aktualizuje trusted entrypoint. Nie kasować targetu
ani nie przerywać aktywnego joba jako obejścia tej usterki.

Nieśledzone wymagane wejście pominięte w kapsule jest błędem, nie cichym buildem
starszej wersji. Nie kopiuj całego `.env`. Jawne gitlinki zewnętrznych solverów są
odnotowane, ale niematerializowane; operacja potrzebująca tych źródeł wymaga
odrębnej obsługi. Po niejednoznacznym timeout API sprawdź listę jobów i request key
przed ponowieniem. Timeout `wait` nie anuluje builda.

`runner-container-stop` oznacza pauzę przyjmowania zadań i dokończenie aktywnego
builda, nie zabicie kontenera. `runner-container-resume` wznawia kolejkę.
Jeśli trwa jeszcze drain po `stop`, odpowiedź ma `resumed=false`: poczekaj na
zakończenie workera i ponów `resume`. Marker pauzy pozostaje wtedy aktywny;
nie uruchamiaj dodatkowego koordynatora.
`runner-container-replace sha256:<nowy-image-id>` wymaga potwierdzonej pauzy i braku
aktywnego joba; wymienia wyłącznie własny, dokładnie sprawdzony kontener, bez
usuwania storage. Samo `configure` nie podmienia istniejącej instalacji.
Zdrowie API i stan wykonawcy są oddzielne: sprawdzaj `accepting_jobs`,
`worker_alive`, błąd oraz stan kolejki, nie tylko Docker `running`.

## Dane, zakończenie i retencja

- `storage/runs/<worktree-id>/<capture-id>/source`: kapsuła readonly.
- `storage/runs/<worktree-id>/<job-id>/execution`: prywatna kopia robocza.
- `storage/runs/<worktree-id>/<job-id>/artifacts`: logi, receipt i wybrane wyniki.
- `storage/builds/<worktree-id>/runner-<profile>-<image-id>`: trwały target buildu.
- `storage/cache`: jawnie współdzielone zależności, chronione przed cleanupem.

Zapisywalne cache Cargo i pnpm runnera używają podkatalogu
`cache/windows/<backend>-<device>/runner-uid-65532/`, wspólnego dla jego worktree.
Nie przejmują starszych drzew tworzonych przez launchery jako root; ich danych
i uprawnień nie zmieniamy. Zainstalowany toolchain rustup pozostaje pod dotychczasową
ścieżką danego backendu; runner nie instaluje automatycznie toolchainów.

Build wykonuje natywny `make install-cli-dev`, instalację zależności frontendu
z lockfile i `make web-build-static`. Success wymaga exit 0, etapów zakończonych
poprawnie i hashy wymaganych binariów/core/web/markera. Nie publikuje automatycznie
nowego `current` ani nie zalicza testów fizyki.

Przy mniej niż 8 GiB wolnego miejsca job pozostaje w kolejce. Nie jest to twarda
kwota dyskowa: pojedynczy etap może zużyć więcej miejsca. `runner-retention-plan`
jest **tylko podglądem**. Rozważa własne terminalne execution po 24 h dla sukcesu
i 7 dniach dla failure/cancel; pin, niespójna tożsamość i niebezpieczne ścieżki
chronią dane. Nie usuwa źródeł, cache, logów ani artefaktów.
Destrukcyjne apply zostało zatrzymane przez kontrolę uprawnień i nie jest wdrożone.
Nie stosuj globalnego prune jako obejścia.

Po konfiguracji kontenera stare `run-once/reconcile`, hostowe sondy zapisujące
SQLite i bezpośrednie ciężkie buildy tej wersji launchera są odrzucane. Starsze
worktree mogą mieć stare launchery: sprawdź procesy/kontenery przed ich użyciem.
Recovery zachowuje niejednoznaczny lease; nie przejmuje go na podstawie wieku.

## Historyczny etap diagnostyczny — nie używać do nowej konfiguracji

Status: **zaimplementowany wykonawca diagnostyczny `verify-source`**.
Nie jest to jeszcze wykonawca buildu Fullmaga ani kwalifikowany runner FEM.
Pełny zakres pozostaje w [zatwierdzonym projekcie](../superpowers/plans/2026-09-11-local-container-runner-design.md).

## Obecny kontrakt

Host Windows wybiera zarejestrowany worktree i storage przez istniejący resolver.
Klient tworzy kapsułę `tree/` + `manifest.json`; kolejka przechowuje jej digest,
nie obietnicę uruchomienia późniejszego stanu katalogu. Jeden aktywny job zajmuje
slot także po awarii obserwatora. Nie odbieramy lease na podstawie wieku.

Wykonawca korzysta wyłącznie z lokalnego endpointu Docker Desktop `desktop-linux`.
Operator osobno rejestruje niezmienny image ID; job nie wybiera obrazu, mountów,
polecenia powłoki ani endpointu. Kontener działa jako użytkownik nieuprzywilejowany,
bez sieci, socketu Dockera, dodatkowych capabilities i zapisu do źródeł/builda.
Zapisywalne są wyłącznie artefakty konkretnego joba i ograniczony `/tmp`.

To interfejs **zaufanego lokalnego użytkownika**, nie uwierzytelniony serwer dla
niezaufanych agentów/GitHuba. Osoba mogąca modyfikować pliki koordynatora, konfigurację
lub bazę jako ten sam użytkownik OS pozostaje wewnątrz granicy zaufania. Pole `owner`
nie zastępuje ACL, osobnego konta usługi ani uwierzytelnienia zewnętrznych żądań.

## Użycie diagnostyczne

Z wybranego worktree:

```sh
just runner-image
# Odczytaj pełne Id z docker image inspect fullmag/local-runner-source:development.
just runner-configure sha256:<pelny-image-id>
just runner-doctor
just runner-submit commit <pelny-commit-sha>
just runner-once
just runner-status <job-id>
just runner-logs <job-id>
just runner-wait <job-id> 30
```

`runner-submit snapshot` uwzględnia bieżące pliki śledzone i usunięcia. Nowe pliki
wymagają jawnego `--include-untracked` w kliencie Python. Przykładowy układ argumentów:
`python scripts/local_runner_cli.py --worktree <absolutny-worktree> submit --source snapshot --include-untracked <sciezka-wzgledna>`.
Na czas capture trzeba wstrzymać edycję źródeł; kontrola przed/po wykrywa wiele wyścigów,
ale nie ustanawia atomowej migawki dowolnego aktywnego edytora.

Polityka kapsuły wyklucza administracyjne metadane narzędzi, `.env` i rozpoznane pliki
poświadczeń; nie jest skanerem gwarantującym wykrycie sekretów wpisanych w zwykły kod.
Sześć jawnie wymienionych gitlinków `external_solvers` jest odnotowanych wraz z pinem,
bez materializacji zewnętrznych solverów. Taka kapsuła nie może kwalifikować operacji,
która potrzebuje tych źródeł. Pozostałe submoduły, LFS i nieobsługiwane dowiązania
muszą zostać odrzucone, nie pominięte bez informacji.

Powtórzenie `--request-key` z tym samym digestem zwraca ten sam job. Nowa kapsuła
kontrolna utworzona podczas retry pozostaje w storage; brak automatycznego prune.
Zmiana źródeł przy tym samym kluczu jest konfliktem, a nie cichą podmianą zadania.

## Anulowanie i awarie

`runner-cancel` anuluje oczekujący job albo zapisuje żądanie dla działającego.
Koordynator sprawdza pełny ID i etykiety przed zatrzymaniem własnego kontenera.
Timeout `runner-wait` nie anuluje joba. Oczekiwanie nie trzyma blokady worktree.

Po utracie obserwatora użyj `runner-reconcile <job-id>`. Reconciliacja potwierdza
persisted container ID, obraz i stan terminalny; może zrealizować już zapisane
anulowanie właściciela. Nie restartuje kontenera, nie usuwa go i nie przejmuje
lease wyłącznie na podstawie czasu. Brak zapisanego ID po niejednoznacznym create
wymaga osobnego ręcznego rozstrzygnięcia — nie wolno globalnie czyścić kolejki.

Dla udokumentowanego odrzucenia komendy **przed kontaktem z daemonem**, po
potwierdzeniu zakończenia procesu wysyłającego, operator może użyć klienta
`acknowledge-uncreated <job-id> --confirm-no-create-request-in-flight --reason <dowod>`.
Wymagane są brak persisted container ID oraz brak kontenera o dokładnej nazwie;
powód pozostaje w journalu. To jawne potwierdzenie operatora, nie automatyczny
mechanizm recovery dla niejednoznacznego timeoutu.

Kontenery zakończone, logi i kapsuły pozostają do audytowalnego cleanup. Nie używamy
`docker system prune` ani usuwania współdzielonych cache. Brak poprawnego receipt
oznacza failure nawet wtedy, gdy Docker zwrócił exit code 0.

## Jeszcze niekwalifikowane elementy

### Przeglądarka z gotowego pakietu CPU

`just run-managed-browser <pełny-job-id> <pełny-commit> 3104` uruchamia
backend API i statyczny Control Room z terminalnego, udanego pakietu
`fem-cpu-release`. Nie kompiluje, nie instaluje zależności i nie uruchamia
solvera. Wymaga zachowanej kapsuły źródeł, kompletnych artefaktów i lokalnego
obrazu o digestcie zgodnym z receiptem buildu.

Tryb `run-managed-browser` nadal wymaga clean commita i kapsuły `commit`.
Dla dokładnego WIP użyj osobnej recepty:
`just run-managed-browser-snapshot <pełny-job-id> <pełny-commit> <source-digest> <native-snapshot-sha256> 3104`.
Digest kapsuły oraz snapshotu natywnego są dwoma różnymi hashami SHA-256
(64 małe znaki hex, bez prefiksu); oba muszą zgadzać się z terminalnym
receiptem. Commit jest pełnym bazowym SHA-1 (40 znaków), nie tożsamością WIP.
Brak jednej z tożsamości, niezgodność, zły tryb kapsuły lub niezgodny
clean/dirty startup stamp powoduje odmowę. Artefakty i trusted documents
weryfikuje ten sam pełny validator, bez pomijania kontroli dla snapshotu.
Ta dodatkowa trasa nie kwalifikuje storage 9p i nie uruchamia solvera.

Launcher ponownie sprawdza kapsułę, trusted documents, wymagane artefakty,
startup stamp i rzeczywiste mounty/port kontenera. Źródła oraz pakiet pozostają
read-only. Świeży katalog stanu w storage zawiera również prywatny widok repo
z linkami do źródeł oraz zwykłym katalogiem `.fullmag`, który jest również
`FULLMAG_STATE_ROOT`. Sam katalog repozytorium sesji nie może być symlinkiem.
Launcher odrzuca typ filesystemu nieobsługiwany przez writer sesji. Bind
Windows widziany jako 9p nie kwalifikuje checkpointów; wymaga osobno
zatwierdzonego adaptera trwałego storage. Samo zdrowe API nie wystarcza.
Kontener korzysta z UID/GID 65532, limitów 4 CPU,
2 GiB RAM i 128 procesów, bez podwyższonych uprawnień.

UI i API są dostępne wyłącznie przez loopback, domyślnie
`http://localhost:3104/workspace`. Receipt wskazuje dokładny container ID,
katalog danych i plik Compose. Pozostają zachowane także po błędzie obserwacji;
nie uruchamiaj ponownie bez sprawdzenia poprzedniego kontenera. Zatrzymanie
właściwego kontenera nie wymaga usuwania danych. Osobny browser smoke musi
potwierdzić działanie UI; zdrowe `/healthz` nie jest kwalifikacją solvera,
fizyki ani wydania.

### Eksport OpenAPI z dokładnego snapshotu

`just export-runner-openapi <job-id> <pełny-commit>` pozostaje trasą dla
czystej kapsuły `commit`. Nie dopuszcza dirty state ani kapsuły `snapshot`.
Dla jawnego WIP służy osobna recepta
`just export-runner-openapi-snapshot <job-id> <pełny-commit> <source-digest> <native-snapshot-sha256>`.
Oba digests są wymaganymi SHA-256 (64 małe znaki hex); commit bazowy nie
identyfikuje zawartości WIP. Niepełna para, niezgodność z queue/trusted
context/build receipt/kapsułą lub zły source mode powodują odmowę przed
alokacją dowodu i przed dostępem do Dockera. Pełne walidatory artefaktów,
trusted inputs, membership i hashy kapsuły pozostają obowiązkowe.

To diagnostyczny odczyt z terminalnego pakietu, bez buildu, solvera i sesji.
Kontener wypisuje `--print-openapi-v2`, ma readonly root/package, brak sieci
i portów. Eksport sprawdza dokładny clean/dirty stamp rzeczywistej natywnej
tożsamości przed normalizacją. Zachowuje `stdout.raw.json`, log, receipt
i proof w nowym `storage/runs/<worktree-id>/openapi-export/<id>`; proof nie
promuje WIP do clean ani nie kwalifikuje fizyki. Zabezpieczenia writer sesji
nie ulegają zmianie.

Dowód z 2026-10-06: 32 interpretowane regresje, 31 PASS / 1 Windows symlink
SKIP. Rzeczywisty eksport snapshotu producenta R1 seq 33 zakończył się
exit 0, input hashes PASS i cleanup confirmed. Zachował dirty provenance.
Ten pakiet nie zawiera nowego DTO R3. Odbiór eksportu nie zastępuje
regeneracji aktualnego OpenAPI/TS.

Generator `apps/control-room/scripts/generate-openapi-v2.mjs` ma osobną
trasę `--input <absolutny-stdout.raw.json> --expected-commit <40-hex>
--expected-snapshot <64-hex> --expected-source-digest <64-hex>
--managed-snapshot-receipt <absolutny-receipt.json>`. Wymaga inputu dokładnie
`receipt-parent/stdout.raw.json` i sąsiedniego `proof.json`; oba dowody muszą
być ograniczonymi regularnymi plikami. Sprawdza SHA surowych bajtów, ich
rozmiar, SHA receiptu w proof, komplet pinów source/native, rzeczywisty
clean/dirty stamp, succeeded/0, pełne input-hash evidence i cleanup.
Dopiero potem normalizuje zmienne dane buildu i atomowo publikuje JSON.
Odmowa zachowuje poprzedni kontrakt; brak inputu nie uruchamia Cargo.
Snapshot receipt i native receipt są wzajemnie wykluczające. Domyślna
trasa nadal wymaga clean identity; dotychczasowa native receipt zachowuje
swój odrębny kontrakt. Hashy i wzajemnej zgodności plików nie należy
przedstawiać jako uwierzytelnienia przeciw aktorowi mogącemu nadpisać
raw/receipt/proof jednocześnie. Trusted package/capsule gates pozostają
odpowiedzialnością managed eksportera.

Dowód importu: `just verify-control-room-openapi-import`, 22/22 PASS,
bez kompilacji native/unit-test bundles; `just check-control-room-api-hygiene`
PASS. Walidator odczytał również rzeczywisty seq 33 raw/receipt/proof:
PASS, raw niezmieniony, generated JSON/TS nie nadpisane. Pełna regeneracja
R3 nadal wymaga terminalnego odpowiedniego buildu i jego własnego eksportu.

### Niezależny czytnik artefaktów anteny — testy bez solvera

`just verify-antenna-field-reader` uruchamia wyłącznie interpretowane regresje
`tests.antenna.test_verify_field_convergence` oraz
`tests.antenna.test_matched_libm`. Przed i po wykonaniu fingerprint
obejmuje także importowane `tests/antenna/direct_quadrature_evidence.py`,
`tests/antenna/matched_libm.py` i jego regresje;
zmiana któregokolwiek przypiętego źródła powoduje odmowę receiptu.
Log i terminalny receipt trafiają przez resolver do profilu
`antenna-field-reader` w kanonicznym storage, nie do checkoutu.

Testy sprawdzają syntetyczne pliki readera, nie wykonują native, LLG ani Relax.
Receipt zachowuje `artifact_reader_only_not_native_or_physics`; nie zastępuje
trzech publikacji native ani producer/input provenance. Rzeczywisty verifier
wymaga direct-v3 evidence domyślnie; historyczne v1/v2 wolno wczytać wyłącznie
przez jawne `--allow-legacy-local-estimator`, bez globalnego certyfikatu.
Parametry analizy `--libm-path` i `--libm-sha256` występują razem:
absolute library path i jawny expected SHA-256 z przypiętego GNU/Linux
x86-64 runtime. Adapter wiąże `hypot@GLIBC_2.35`, sprawdza canonical
resolved path, hash przed/po i nearest-even; nie zmienia fenv ani nie
wraca do Python hypot po odmowie. Bez pary parametrów raport pozostaje
`python_hypot_diagnostic_only`, a jawny legacy ma
`not_applied_legacy_local_estimator`. Żaden profil nie nadaje sam z siebie
producer/input qualification. Hash i `dladdr` nie chronią mapped ELF przed
równoległą podmianą; wymagany jest przypięty runtime tylko do odczytu.
Regresja samego fingerprintu jest w
`scripts/test_verify_antenna_field_reader.py::test_imported_direct_decoder_changes_reader_fingerprint`.

### Mały test naukowy anteny z sesją w RAM

Po jawnej zgodzie użytkownika można użyć
`just run-managed-antenna-ram <job-id> <commit> <source-digest> <native-snapshot-sha256>`.
To osobna, ograniczona trasa FEM CPU/double dla przypiętego przykładu
`examples/fem_antenna_current_source_inspection.py`, nie alternatywny trwały
SessionStore i nie uruchomienie LLG. Wymaga terminalnego, udanego buildu
`fem-cpu-release` i pełnego validatora trusted documents, pakietu oraz kapsuły.
Nowy przykład jest osobnym, dokładnie zahashowanym wejściem naukowym;
nie wolno przypisywać go wcześniejszej kapsule buildu.

Launcher przyjmuje kapsułę `snapshot` albo czystą kapsułę `commit`; obie wymagają
pełnego SHA commita oraz obu jawnych digestów. `commit` wymaga dodatkowo
`source_snapshot_dirty=false`. Tryb źródeł nie pomija kontroli trusted documents,
hashy pakietu ani pełnego `verify_source`. Obserwator ponawia te same kontrole.
Regresja interpretowana: `scripts/test_antenna_ram_source_modes.py::AntennaRamSourceModesTests`;
nie jest wykonaniem solvera ani kwalifikacją naukową.

Sesja, cache siatki i oryginalny wynik znajdują się wyłącznie na ograniczonym
tmpfs `/ram` (768 MiB). Kontener ma 2 CPU, 2 GiB RAM, 128 procesów, UID/GID
65532, read-only rootfs, brak capabilities, podwyższonych uprawnień, sieci,
portów i named volumes. Kapsuła, pakiet i trzy pliki wejściowe są read-only;
jedyny zapis na bind hosta to eksport logu, exit marker i kopia wyniku pod
nowym katalogiem `storage/builds/<worktree-id>/managed-antenna-ram-cpu/runs/<id>`.
Nie zmienia to allowlisty filesystemów ani kwalifikacji checkpointów na 9p.

Tryb naukowy ustawia `FULLMAG_API_PORT=0`: headless nie wymaga serwera API,
a kontener nadal nie publikuje portów. `FULLMAG_STATE_DIR=/ram/user-state`
kieruje osobną historię workspace do RAM; nie należy utożsamiać tej zmiennej
z `FULLMAG_STATE_ROOT`, który określa root sesji. Oba zapisy są tymczasowe.

`just observe-managed-antenna-ram <absolutny-run-root>` ponawia kontrolę
pakietu, kapsuły i wejść oraz sprawdza rzeczywisty image, mounty, limity,
tmpfs, komendę, środowisko i właściciela Compose. Stan inny niż `exited`
pozostaje oczekujący. Exit 0, właściwy startup stamp i obecność eksportu
oznaczają wyłącznie `solver_succeeded_comparison_pending`. Oddzielna bramka
musi odczytać konkretny inspection stage record, zweryfikować jego canonical
bundle i porównać V/H z niezależnym wzorcem. Receipt zachowuje
`physics_qualified=false` i `durable_session_storage_qualified=false`.
Kontener i eksport są zachowane także po błędzie; observer nie startuje
nowego solve ani nie usuwa zasobów. Utrata RAM po zakończeniu kontenera jest
zamierzona; eksport nie dowodzi odporności sesji na utratę zasilania.

### Pozostałe ograniczenia

- Build/uruchomienie Fullmaga z prywatnej kopii kapsuły i jawnego execution context.
- Wspólne leases obejmujące istniejące launchery i ich kontenery po crashu procesu hosta.
- Adapter trwałego storage Desktop, dowód ext4/backing, limity i restart.
- Rozdzielenie istniejącego managed recipe na host orchestration i worker stage.
- Rzeczywista kwalifikacja FEM CPU/GPU, receipt nauki i artefakty.
- Uwierzytelniony ingress GitHub, ephemeral listener i ograniczenia zaufania PR.

Nie nadawaj temu wykonawcy etykiety `fem-managed` ani nie używaj diagnostycznego
receipt do zaliczenia CI/kwalifikacji solvera.
