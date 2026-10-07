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

Dla pełnego stosu modalnego CPU z `CPU_MFEM_ONLY=1` recepta musi mieć sieć
na pobranie przypiętych źródeł i pakietów, np.
`just runner-build-image <zweryfikowany-lokalny-tag> <nowy-tag-workera> 1 default`.
W Docker BuildKit wartość `bridge` nie jest poprawną opcją build network.
Sprawdź immutable ID tagu bazowego przed wywołaniem; surowy image ID
`sha256:...` w `FROM` może zostać zinterpretowany jako nazwa repozytorium,
więc użyj osobnego lokalnego aliasu przypiętego do tego sprawdzonego obrazu.
Nie zastępuje to kontroli końcowego immutable ID workera.

Przy prefix-based PETSc/SLEPc usuń odziedziczone `PETSC_ARCH` przed
konfiguracją SLEPc i nie przekazuj `PETSC_ARCH=` jako argumentu poleceń
`make` SLEPc. Własny build PETSc nadal jawnie używa `PETSC_ARCH=arch-linux-cpu`.
Configure wybiera tymczasowy katalog `installed-arch-...`; command-line
pusta wartość nadpisuje ten wybór i powoduje brak `slepcrules`/`slepcconf.h`.
Procedura wynika z [instrukcji SLEPc](https://slepc.upv.es/release/documentation/manual/intro.html#prefix-based-installation).
Nie zmienia to kontraktu uruchomieniowego: po instalacji API używa jawnego
prefixu CPU, a attestacja weryfikuje rzeczywiste pliki i konfigurację bibliotek.

Zaufany executor pochodzi z obrazu koordynatora, nie z kapsuły workera.
Po zmianie środowiska runtime-v2 lub walidacji receiptów aktualizuj oba obrazy
w pustym, zapauzowanym slocie. Przed wymianą porównaj źródła wdrożonego
executora; zachowaj działającą obsługę pozostałych profili i atestowanych
ograniczonych instancji managed browser. Nie przenoś kodu nieznanego
pochodzenia ani lokalnych sekretów. Po wdrożeniu sprawdź health, profile,
źródła executora i stan kolejki, a następnie jawnie wznów FIFO.
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

### Sprzątanie prywatnych kopii wykonania

Koordynator udostępnia nieblokujące operacje: `POST /api/v1/retention/plans`
zwraca `plan_id` i `planning`; `GET /api/v1/retention/plans/<plan_id>` odczytuje
ten sam plan; `POST /api/v1/retention/plans/<plan_id>/apply` zwraca ACK
`accepted`. Po timeoutcie klient odczytuje istniejący identyfikator zamiast
ponawiać mutację. Raporty pozostają w `index/retention-plans` i
`index/retention-operations`. Restart z nieznanym wynikiem daje
`interrupted_unknown`, a błąd częściowy `partial`, bez deklaracji pełnego sukcesu.

Wykonawca obejmuje wyłącznie dokładne `runs/<worktree>/<job>/execution`.
Sprawdza ponownie queue/journal/receipt, digest źródeł, zachowane artefakty,
piny, blokady, znaczniki właścicieli, tożsamość drzewa i wszystkie bind mounty.
Wiążące blokady chronią zarządzanych użytkowników; procesy uruchamiane poza
zarządzanymi launcherami wymagają osobnej kontroli operatora przed cleanupem.
Link wewnątrz drzewa jest usuwany jako link, bez przechodzenia do celu.
Zakończony kontener własnego joba może zostać usunięty bez `force` i bez wolumenów
dopiero po zapisaniu wszystkich dostępnych logów w `worker-full.log` z hashem.
Niepoprawne UTF-8 lub przekroczenie limitu odpowiedzi Docker zatrzymuje ten krok.

Polityka `mode=automatic` włącza ten sam wykonawca pomiędzy buildami; domyślnie
pozostaje `preview`. Drain zatrzymuje przyjmowanie nowych operacji, a wymiana
koordynatora wymaga także zakończenia już przyjętej retencji. TTL źródeł,
logów i niezweryfikowanych stagingów nie jest wykonywany i jest nieaktywny w UI.
Rozmiar logiczny usuniętych drzew oraz zmiana wolnego miejsca są osobnymi polami;
zmiana miejsca może obejmować pracę innych programów i nie jest przypisywana
w całości retencji.

Stan wdrożenia i dowody:
[plan retencji](../superpowers/plans/2026-10-05-runner-storage-retention.md),
[ADR 0052](../adr/0052-runner-storage-retention.md). Obecność kodu nie dowodzi
aktualizacji uruchomionego koordynatora.

### Współdzielenie zawartości źródeł

Klient capture korzysta z `storage/cache/source-content-v1`. Klucz obiektu
obejmuje SHA-256 treści i tryb wykonywalny Git. Każda kapsuła nadal ma własny
manifest v1 i drzewo `source/tree`, lecz identyczne regularne pliki wskazują
na niezmienną zawartość przez hardlinki. Obiekt powstaje z prywatnego stagingu;
repozytorium i zapisywalne execution nigdy nie są hardlinkowane do magazynu.
Worker materializuje prywatne kopie i przywraca prawa do zapisu zgodnie z manifestem.

Publikacja i cleanup własnego stagingu używają blokady obiektu. Na Windows
atrybut readonly jest wspólny dla hardlinków; helper usuwający link stagingu
ponownie pieczętuje obiekt w `finally`. Korupcja, nieznana blokada, inny wolumen
lub niebezpieczna ścieżka kończą capture błędem. Zachowujemy dotychczasowe
manifesty i digesty; CAS nie jest objęty automatycznym prune cache. Migracja
historycznych kapsuł ma osobne zabezpieczenia i nie wynika z samego włączenia
współdzielenia nowych capture.

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

Profil `fem-cpu-slepc-runtime-v1` jest osobną trasą dla produkcyjnej biblioteki
FEM CPU z PETSc/SLEPc. Trusted entrypoint uruchamia w nim wyłącznie etap
`make install-cli-dev`; nie dodaje instalacji frontendu, `CTest` ani celów
jednostkowych/kontraktowych. Receipt musi zawierać `libfullmag_fem.so`,
`source-identity.json`, marker `fem-cpu` oraz kontrakt
`fullmag.fem.cpu.slepc_runtime_contract.v1` z `FULLMAG_FEM_WITH_SLEPC=ON`,
urządzeniem CPU i precyzją double. Ten profil dostarcza artefakt runtime do
diagnostyki lub dalszego uruchomienia; `run_comsol_dispersion_benchmark.py`
akceptuje oba profile SLEPc, a źródło `fullmag-bin` i `libfullmag_fem` w trasie
runtime-only jest powiązane hashami. Sam receipt pozostaje `NOT VERIFIED` i nie
jest dowodem CTest ani kwalifikacji fizycznej.

Profil `fem-cpu-slepc-runtime-v2` oddziela ABI trasy CPU: obraz zawiera drugi
MFEM v4.10 zbudowany bez CUDA pod `/opt/fullmag-mfem-cpu`, a natywny klient FEM
jest kompilowany z `FULLMAG_ENABLE_CUDA=OFF`. Trusted receipt wymaga zarówno
`MFEM_DIR` z tego prefiksu w cache CMake, jak i rzeczywistego `libmfem.so`
rozwiązanego przez loader z tego samego prefiksu; zapisuje ścieżkę i hash
biblioteki w `cmake-attestation.json`. Profil v1 pozostaje dostępny dla
historycznych wyników. v2 nie stanowi dowodu naprawy ABI, dopóki nowy obraz,
managed build, pomiar pamięci i pilot nie przejdą weryfikacji.


Aktywacja wyłącznie profilu runtime-v2 odbywa się przez
`container-configure --image-id <immutable-coordinator-id> --enable-slepc-runtime-v2`.
Zachowuje istniejące profile, token oraz ustawienia operatora; ponowienie nie
powiela wpisu. Późniejsza aktywacja current-contracts również zachowuje profile
wcześniej dodane przez operatora. Wymiana koordynatora wymaga pustej kolejki
aktywnego wykonania i zatrzymanego workera po graceful pause; nie anuluje się
w tym celu cudzych jobów.

Ponieważ CUDA-enabled `libfullmag_fem` może zachować transitive
`libcuda.so.1` także w CPU lane, trusted post-build probe dodaje wyłącznie
image-owned `/usr/local/cuda/compat` do `LD_LIBRARY_PATH`, gdy zawiera
loadable SONAME. Nie włącza to GPU ani nie zmienia resolved device; zapis
`cuda_driver_compatibility_paths` w `runtime-attestation.json` dokumentuje
ścieżkę loadera używaną tylko do tej attestacji. Usługa `fem-modal-cpu` ma
ten sam jawny compatibility path, lecz nie żąda urządzenia Docker GPU.

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

### Pozostałe ograniczenia

- Build/uruchomienie Fullmaga z prywatnej kopii kapsuły i jawnego execution context.
- Wspólne leases obejmujące istniejące launchery i ich kontenery po crashu procesu hosta.
- Adapter trwałego storage Desktop, dowód ext4/backing, limity i restart.
- Rozdzielenie istniejącego managed recipe na host orchestration i worker stage.
- Rzeczywista kwalifikacja FEM CPU/GPU, receipt nauki i artefakty.
- Uwierzytelniony ingress GitHub, ephemeral listener i ograniczenia zaufania PR.

Nie nadawaj temu wykonawcy etykiety `fem-managed` ani nie używaj diagnostycznego
receipt do zaliczenia CI/kwalifikacji solvera.


### Toolchain CPU dla runtime-v2

Dla kompletnego runtime-v2 recepta
`just runner-build-image <verified-local-toolchain-tag> <new-tag> 1 default`
dodaje osobny CPU stos: MFEM v4.10 z commita
`d964264cdb9a13e94a201b6c236c7721e0c8765f` i HYPRE v3.1.0
z commita 9dc9e18aed6a945a95f966e57daacfb1c269f6ec,
bez CUDA i bez testów, przykładów oraz miniapps. Zachowuje stary prefix.
Dodaje też CPU libCEED v0.12.0 (`4018a20a98d451fac24765d3ddb936861647ce8d`),
PETSc v3.24.6 (`1467453aedb62826efc970ceafc4bd6dab8229ab`) i SLEPc v3.24.3
(`4c754d7d3ae067837670828a304512798334fb3a`). Dokładne commity sprawdzane są
po shallow fetch; źródła CPU i ich wygenerowane konfiguracje są osobne.
PETSc jest real/double z MPI, bez CUDA/HIP/SYCL/OpenCL, powiązany z tym samym
CPU HYPRE co MFEM. CPU MFEM korzysta z CPU libCEED. Inherited GPU PETSC_DIR /
SLEPC_DIR są zastąpione podczas configure. Przy CPU_MFEM_ONLY=0 bootstrap
CPU jest pomijany; historyczny/GPU prefix pozostaje zachowany.
Wariant CPU potrzebuje sieci dla jawnego pobrania źródeł i pakietów
rozwojowych BLAS/LAPACK/Fortran. Domyślne network=none pozostaje bez zmiany;
nie ma automatycznego przełączenia na online ani fallbacku GPU.
To jawna budowa obrazu operatorowego, nie build ani kwalifikacja Fullmaga.
Domyślne argumenty recepty pozostają bez dostępu sieci i bez tego kroku.
Obraz wymaga kontroli CPU prefix, a następnie konfiguracji immutable ID
profilu runtime-v2 i osobnego builda Fullmaga przez kolejkę.

Historyczny bootstrap MFEM 4.9 zweryfikowano: obraz f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc; MFEM/HYPRE bez CUDA, loader HYPRE z CPU prefixu. To obraz zależności; build Fullmaga i fizyka NOT VERIFIED.

Aktualizacja do MFEM 4.10 wymaga nowego tagu, immutable ID i kontroli wersji
nagłówków oraz załadowanej biblioteki; historyczny obraz nie stanowi jej dowodu.
Przed operatorską budową obrazu należy zakończyć aktywne wykonania i potwierdzić
zwolnienie lease oraz zdrowie koordynatora. Kolejka obsługuje build źródeł,
nie budowę obrazu. Zachowaj istniejące profile i obrazy wykorzystywane przez
wcześniejsze kapsuły. Oba prefixy CPU/GPU kwalifikuj oddzielnie.


### Obsługa źródeł i paczek runtime

Plan retencji jest związany z zakresem (`execution`, `sources`, `runtime`) oraz
opcjonalnym wyborem pełnych ID jobów. Klient CLI udostępnia
`retention-preview --scope sources`, `retention-get <plan-id>` i
`retention-apply <plan-id>`; recepty `just runner-retention-preview sources`,
`runner-retention-get` i `runner-retention-apply` korzystają z tego samego API.
Nie ponawiaj POST po timeout: odczytaj trwały wynik tego samego ID.

Kompakcja historycznych źródeł zachowuje manifest, digest i ścieżkę kapsuły.
Identyczna treść jest współdzielona w CAS; execution nadal otrzymuje prywatną
zapisywalną kopię. Operacja chroni aktywne zadania, piny, obce hardlinki,
reparse points i mounty. Liczniki logicznych bajtów nie są pomiarem odzysku
fizycznego miejsca.

Retencja runtime obejmuje wyłącznie dokładny lokalny katalog paczki terminalnego
udanego buildu. Zachowuje źródła, wyniki naukowe, logi, receipty i historię
kolejki. Zostawia co najmniej `min_artifacts_to_keep` najnowszych dostępnych
pakietów dla każdej pary worktree/profil (liczba całkowita 1–20) oraz wszystkie
paczki używane przez wyniki, UI, eksporty, piny i kontenery. Brak pełnego
inwentarza lub uszkodzone metadane chronią potencjalnie używane zasoby.
Automatyczne usuwanie paczek wymaga oddzielnego `runtime_retention_enabled=true`
oraz trybu `automatic`; domyślnie jest wyłączone.

Autorytatywny rejestr metadanych w `index/runtime-reference-roots.json` ma
schema `fullmag.runtime-reference-roots.v1`, tablicę `relative_roots` i jawne
`legacy_inventory_complete`. Nie ustawiaj kompletności na true bez sprawdzenia
historycznych lokalizacji wyników i zapisania dowodów audytu. Brak pliku albo
wartości true blokuje usuwanie wszystkich paczek runtime. COMSOL/DE rejestruje
nowy output pod bramką admission przed zwolnieniem ticketu; utworzenie rejestru
nie poświadcza historii. Nieobsługiwany output w namespace kontrolnym/payload
unieważnia kompletność. Katalogi rejestru są względem kanonicznego storage,
bez ścieżek absolutnych i przejść `..`.

Przed usuwaniem paczki powstaje `artifacts/runtime-package-retention.json`.
Pełne usunięcie pozostawia tombstone `removed` związany z SHA-256 oryginalnego
build receipt. Stan `partial_error`, `deleting` albo niezgodna tożsamość blokuje
ponowną próbę i wymaga ręcznego sprawdzenia danych. Nie deklaruj udanego
sprzątania na podstawie braku katalogu bez takiego dowodu.


Przy maintenance można jawnie użyć
`just runner-container-replace <verified-image-sha256> <readonly-preview-plan-id>`.
To wyłącznie porzucenie wskazanego execution preview w statusie planning,
przy policy preview i potwierdzonym Drain bez aktywnych jobów/workerów/błędów.
Klient sprawdza uwierzytelnione API, kanoniczny rekord i brak operation/admission,
a po stop ponownie atestuje kontener i metadane. Przerwany preview otrzymuje
blocked/applied=false; trzeba wygenerować świeży plan. Nie używaj tego wariantu
do apply, automatycznej retencji lub odzyskania nieznanego wyniku mutacji.
Domyślny wariant recepty zachowuje odmowę podczas retention_busy.


## Cooperative cancel tylko dla read-only execution preview

Przygotowywany przyrost rozszerza istniejącą usługę retention o
`POST /api/v1/retention/plans/<plan_id>/cancel` z pustym body i komendę
`retention-cancel <plan_id>` zatwierdzonego klienta. Obejmuje wyłącznie aktywny
read-only preview scope execution. Cancel apply oraz preview sources/runtime
pozostaje niedostępny; nie przerywa się usuwania danych w połowie operacji.

Klient CLI zwraca kod `124` dla ACK `cancel_requested`, `0` dla terminalnego
`cancelled`, a `1` dla pozostałych odpowiedzi (np. odmowy anulowania).
Kod `124` wymaga odczytu tego samego planu, a nie ponowienia preview.

ACK `cancel_requested` nie jest wynikiem terminalnym. Thread sprawdza event
między odczytami metadanych i etapami drzewa, po czym utrwala `cancelled` z
`applied=false`. Slot builda pozostaje zajęty do faktycznego zakończenia threadu.
Nie wolno wyczyścić lease, zrestartować procesu ani ponowić skanu na podstawie
samego ACK lub wieku operacji. Przy utracie handle wynik pozostaje
`interrupted_unknown`, nie success. Canceled preview nie może być użyty do apply.

Progress przedstawia rzeczywiście zbadane entries/files/logical bytes oraz
fazę enumeracji/inspekcji. Nie ma zgadywanego procentu, całkowitej liczby entries
ani ETA; kandydat i fingerprint są dostępne dopiero po pełnej inspekcji.
Finalne publish i przejście automatic-preview→apply są chronione tą samą blokadą
co cancel, aby zaakceptowany cancel nie został nadpisany gotowym planem.

Przygotowanie źródeł i regresji CI nie włącza tej trasy we wdrożonym koordynatorze.
Przed użyciem potrzebne są sprawdzone CI, zgodna aktualizacja jednego runnera,
attestacja obrazu, pusta aktywna ścieżka builda i preserved queue/profiles/data.
Dla starego koordynatora brak obsługi oznacza unavailable; nie udajemy anulowania.
Reguły autoryzacji i ochrony kandydatów przy rzeczywistym cleanup pozostają bez zmian.


## Stabilny odczyt aktywnej kolejki

Panel kolejki pobiera `GET /api/v1/jobs?status=queue&sort=oldest&limit=200`.
Dla kolejki SQLite odpowiedź zawiera `items`, `next_cursor`, `as_of_sequence`,
`limit`, `is_truncated` i `worktrees`. Kolejną stronę pobiera się z tym samym
zestawem filtrów oraz `cursor=<next_cursor>`; odczyt kończy wyłącznie jawne
`next_cursor: null`. Kursor jest związany z operatorem, filtrami, kolejnością
i limitem; zmiana któregokolwiek z nich wymaga rozpoczęcia nowego odczytu.

Pierwszy odczyt ustala maksymalny numer `sequence` w tej samej transakcji co
strona. Wszystkie kolejne strony zachowują ten `as_of_sequence`; nowe zgłoszenia
po tej granicy pojawiają się przy następnym odświeżeniu. Stan aktywności jest
sprawdzany na każdej stronie, więc zadanie zakończone przed swoim odczytem może
zniknąć. Zakończenie wcześniejszych zadań nie przesuwa dalszych aktywnych
rekordów poza kursor. Nie jest to snapshot wszystkich statusów z jednego momentu.
Historia zachowuje dotychczasowe `page/pages` i OFFSET.

Źródła Runner Console znajdują się w `apps/runner-console/src`; koordynator
serwuje pakiet `scripts/local_runner/ui_dist`. `node apps/runner-console/build.mjs`
kopiuje kanoniczne zasoby do obu katalogów dystrybucji. Zmiana panelu wymaga
zachowania zgodności źródeł i pakietu; nie wolno nadpisywać działających funkcji
nowszą albo starszą kopią bez sprawdzenia diffu. GHA wykonuje regresję SQLite,
testy Node oraz lokalną fixture przeglądarki serwującą `ui_dist`. Fixture nie
zgłasza prawdziwych buildów ani nie usuwa danych.
