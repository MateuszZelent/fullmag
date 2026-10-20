# Fullmag w całości w Docker Desktop

> Aktualizacja 16.10.2026: docelowy tryb developerski określa
> [Architektura developerska Compose](docker-development-architecture.md).
> Poniższe polecenia z kolejką runnera opisują wcześniejszą ścieżkę i nie są
> instrukcją nowego bezpośredniego buildu obu usług. Nowa ścieżka jest w implementacji.

Tryb release składa jeden obraz uruchomieniowy zawierający backend API, statyczny
Control Room, publiczny Python DSL, rozszerzenie PyO3 oraz biblioteki FEM/CUDA.
Windows udostępnia przeglądarkę i Docker Desktop. UI i API używają tego samego
portu: `http://localhost:3197/workspace`. Release nie potrzebuje checkoutu,
socketu Dockera ani hostowego Pythona podczas uruchomienia. Tryb developerski
ma osobny kontrakt dwóch usług i korzysta z readonly bindów wybranego checkoutu,
opisanych niżej.

## Główna ścieżka developerska

Dla głównego checkoutu, gdy `FULLMAG_SOURCE_ROOT` jest puste lub nieustawione,
launcher wybiera zarejestrowany checkout główny. Uzupełnij wartości
receiptów przed wykonaniem zależnych poleceń; argumenty recept są pozycyjne:

```text
$jobId = '<job-id-from-submission-receipt>'
$commit = '<resolved-40-character-commit-sha>'
$sourceDigest = '<64-hex-source-digest>'
$nativeSnapshotSha256 = '<64-hex-native-snapshot-sha256>'
$assemblyReceipt = '<assembly-receipt.json>'

just runner-container-status
just docker-all-dev-backend-build
just runner-wait $jobId 30
just docker-all-dev-image $jobId $commit $sourceDigest $nativeSnapshotSha256
just docker-all-dev $assemblyReceipt 3197
```

Dla zarejestrowanego worktree użyj tej samej wartości `$sourceRoot` w trzech
krokach wyboru źródeł: zgłoszeniu snapshotu, składaniu obrazu i uruchomieniu.
Poniższy przykład nie zakłada żadnej hostowej ścieżki; `<registered-worktree>`
musi być ścieżką zarejestrowaną przez `fullmag_storage.py register`:

```text
$sourceRoot = (Resolve-Path '<registered-worktree>').Path
$jobId = '<job-id-from-submission-receipt>'
$commit = '<resolved-40-character-commit-sha>'
$sourceDigest = '<64-hex-source-digest>'
$nativeSnapshotSha256 = '<64-hex-native-snapshot-sha256>'
$assemblyReceipt = '<assembly-receipt.json>'

# 1. Capture the selected worktree as an immutable managed snapshot.
just docker-all-dev-backend-build $sourceRoot
# 2. After the receipt reports the job ID and terminal success, assemble it.
just runner-wait $jobId 30
just docker-all-dev-image $jobId $commit $sourceDigest $nativeSnapshotSha256 $sourceRoot
# 3. Start the assembled image with the same selected worktree.
just docker-all-dev $assemblyReceipt 3197 $sourceRoot
```

`jobId`, `commit` oraz oba digesty pochodzą z receiptu zgłoszenia backendu;
`assemblyReceipt` pochodzi z receiptu składania obrazu. Po kodzie 124 z
`runner-wait` obserwuj ten sam job i nie zgłaszaj kolejnego buildu. Do składania
i startu przejdź dopiero po terminalnym `succeeded`.

Zachowaj katalog `output/context` wskazany przez receipt złożonego obrazu.
Launcher może odczytać z niego zweryfikowane helpery startowe, gdy ich bajty
w wybranym checkoutcie różnią się od obrazu (np. przez CRLF). Ten katalog
pozostaje zależnością obrazu do czasu wycofania jego receiptu.

Wersjonowane pliki definiują poszczególne części:

| Plik | Odpowiedzialność |
| --- | --- |
| `compose.dev.yaml` | frontend/backend, readonly źródła, rzeczywisty storage Windows, prywatna sieć i publiczny port frontendu |
| `compose.toolchain.yaml` | budowanie zależności z kanonicznego Dockerfile, obraz CUDA z digestem |
| `docker/fem-gpu/Dockerfile` | pobieranie i budowanie bibliotek FEM/CUDA oraz deklaracje ich wersji |
| `docker/all-in-one/Dockerfile.dev` | helpery uruchomieniowe; źródła i pakiet aplikacji są bind mountami |
| `compose.static.yaml` | opcjonalny wariant ze statycznym frontendem |

Istniejący `compose.yaml` zachowuje kanoniczne profile FEM i nie jest plikiem
startowym dwóch usług developerskich. Launcher odczytuje `compose.dev.yaml`,
rozwiązuje jego parametry i wykonuje admission storage przed startem.

Jawny pozycyjny `source_root` wybiera zarejestrowany worktree i ma pierwszeństwo.
Jeżeli argumentu nie podano, launcher używa niepustego `FULLMAG_SOURCE_ROOT`; gdy
zmienna jest pusta lub nieustawiona, wybiera zarejestrowany checkout główny.
W obu przypadkach launcher zapisuje resolved Compose JSON oraz kopię źródłowego
YAML w owned run; nie generuje topologii w Pythonie.
Renderowanie Compose przeszło kontrole źródeł i rzeczywisty parser Compose;
cold-start, HMR i pełny runtime pozostają **VERIFICATION PENDING**.

## Jawny skrypt przy uruchomieniu Workspace

Opcjonalny czwarty argument `docker-all-dev` wskazuje skrypt w wybranym
checkoutcie. Podaj ten sam `$sourceRoot`, którego użyto do budowania:

```powershell
$startupScript = Join-Path $sourceRoot 'tests/vlad/4.5GHz_fem.py'
just docker-all-dev $assemblyReceipt 3197 $sourceRoot $startupScript
```

Wariant ze statycznym frontendem przyjmuje te same argumenty:
`just docker-all-start $assemblyReceipt 3197 $sourceRoot $startupScript`.
Skrypt musi być plikiem UTF-8 do 1 MiB wewnątrz wybranego checkoutu.
Launcher zapisuje jego ścieżkę względną i SHA-256 oraz montuje źródła readonly.
Helper aktywacji należy do niezmiennego obrazu; kod użytkownika jest ładowany
przez kanoniczny importer API. Nie korzystamy z `docker compose run fullmag`.

Odbiór startu wymaga potwierdzenia aktywacji tego samego skryptu w receipcie
procesu backendu. Sam HTTP healthcheck nie potwierdza przygotowania modelu.
Przygotowanie siatki przez API ma limit 1800 sekund. Aktywacja HTTP czeka do
2100 sekund, uwzględniając wcześniejsze eksporty Pythona; obserwacja gotowości
procesu ma limit 2400 sekund.
Timeout nie uruchamia drugiej próby ani drugiego solvera i pozostawia dane
uruchomienia do sprawdzenia. Docelowo authored Study uruchamia się w całości,
a interaktywne `wait_for_solve` zatrzymuje je przed Compute, po przygotowaniu
modelu i siatki.

**NOT VERIFIED:** trwa integracja admitted FEM preparation z Workspace/API.
Powyższy interfejs launchera ma regresje interpretowane; nie stanowią one
dowodu wykonania pełnego skryptu `4.5GHz_fem.py`, GPU ani gotowego modelu
w przeglądarce. Końcowa kwalifikacja wymaga zbudowania nowego pakietu API
z obsługą wewnętrznej trasy aktywacji i wykonania obu wariantów skryptu.

## Budowanie obrazu release (opcjonalne)

Pełną kompilację wykonuje istniejący `Fullmag_build_runner`. Nie uruchamiaj
równoległego ciężkiego buildu przez `docker build` ani hostowy Cargo.
Przed zgłoszeniem sprawdź zdrowie runnera i konfigurację `fem-gpu-release`.
Worktree musi być wcześniej zarejestrowany przez `fullmag_storage.py register`
w ramach cyklu zadania. Źródłem jest pełny SHA commita właściwego checkoutu:

```text
$commit = '<full-40-character-commit-sha>'
$jobId = '<job-id-from-submission-receipt>'

just runner-container-status
just docker-all-build $commit
just runner-wait $jobId 30
just docker-all-image $jobId $commit
```

Zgłoszenie używa obsługiwanej niezależnej kopii niezmiennej kapsuły źródeł,
bez hardlinków do współdzielonego source CAS. Nie modyfikuje ani nie naprawia
obiektów CAS odrzuconych przez kontrolę niezmienności. Job nadal wykonuje
jeden istniejący koordynator, z profilem `fem-gpu-release`. Receipt
`state=submitted` oznacza przyjęcie do kolejki, nie rozpoczęcie ani sukces buildu.
Pole `queue_state_at_submission` dotyczy chwili zgłoszenia; aktualny stan
sprawdzaj przez `runner-status` i `runner-wait`. `build_claimed_at_submission`
sygnalizuje przejęcie joba przez koordynatora, nie uruchomienie kompilatora.
Kod 124 z `runner-wait` oznacza
koniec czasu obserwacji, a nie anulowanie joba.
Przed POST do kolejki zapisuje `submission.json` z `capture_id`, `request_key`
i ścieżką kapsuły. Po timeoutcie stan `submission_unconfirmed` wymaga sprawdzenia
kolejki według `request_key`; nie zgłaszaj ponownie nowego capture, dopóki nie
ustalisz, czy koordynator przyjął poprzedni job.

Ostatnie polecenie nie kompiluje kodu. Sprawdza terminalny receipt, profil GPU,
hashy artefaktów, tożsamość commita i kapsułę źródeł. Następnie składa obraz
offline z przypiętego obrazu toolchaina, całego pakietu release i źródeł DSL.
Wynik zawiera `image_id` oraz ścieżkę `receipt.json` pod resolverowym
`storage/runtimes/<worktree-id>/docker-all-images/<id>`.
Kontekst składania pozostaje pod profilem `storage/builds/<worktree-id>/docker-all-gpu`.
Obraz zawiera pełny toolchain i może być duży; nie jest wersją slim.

Zależności FEM są pobierane wyłącznie z kanonicznego
`docker/fem-gpu/Dockerfile`, w tym z jego stage `fem-gpu-dev` i przypiętych
wersji. `Dockerfile.dev` integruje ten toolchain dla obrazu developerskiego;
nie utrzymujemy drugiej listy wersji bibliotek w Compose ani w tym przewodniku.
Opis pinów jest w [`docker/DEPENDENCIES.md`](../../docker/DEPENDENCIES.md).
Polecenie `python scripts/docker_dependency_report.py --check-updates` porównuje
przypięte wersje z oficjalnymi stabilnymi wydaniami bez modyfikowania obrazu lub źródeł.
Toolchain publikuje faktycznie zbudowane wersje i commity w
`/opt/fullmag-deps/share/fullmag/dependency-versions.json`; obraz developerski
odmawia składania bez tego manifestu. Stary obraz toolchaina bez
manifestu wymaga ponownego zbudowania kanonicznego toolchaina i przypisania jego
zweryfikowanego ID do profilu `fem-gpu-release` koordynatora. Na tym hoście
ciężką pracę wykonuje istniejący koordynator lub odrębna bramka managed FEM
z blokadą ciężkich prac; nie uruchamiaj równoległego ręcznego buildu Compose.
Kanoniczny profil `fem-gpu` w `compose.yaml` przekazuje opcjonalne
`FULLMAG_CUDA_BASE_IMAGE` i `FULLMAG_CUDA_BASE_IMAGE_DIGEST` do tego samego
Dockerfile. Bez tych zmiennych zachowuje jego dotychczasowe defaults. Dzięki
temu managed kwalifikacja może użyć dokładnego zestawu argumentów z
`compose.toolchain.yaml`, bez zmiany bramki CPU/GPU i bez drugiej listy wersji.

Rust `nightly` i pakiety pip nie są w pełni przypięte. Końcowe wykonanie nowego
toolchaina i obrazu aplikacji pozostaje **VERIFICATION PENDING**.

## CI: routowanie managed FEM

Workflow `.github/workflows/frontend-3d-managed-fem.yml` zachowuje ten sam
job, środowisko i rzeczywistą bramkę kwalifikacji. Dla `push` i
`pull_request` używa dokładnie czterech etykiet runnera, a czwarta jest
prywatna i unikalna dla konkretnego runu:

```text
self-hosted, linux, x64, fullmag-fem-private-${{ github.run_id }}
```

Workflow rozwija ją przez
`${{ format('fullmag-fem-private-{0}', github.run_id) }}`. Istniejący operator
akceptuje taki label przez regex `^fullmag-fem-private-[a-z0-9][a-z0-9-]{0,63}$`,
w tym jedenastocyfrowy `github.run_id`. Konfiguracja JIT musi zawierać dokładny
label bieżącego runu; nie wolno używać samego prefixu ani labela z innego runu.

Dla `pull_request` operator nadal wymaga trusted ref
`refs/pull/<nr>/(merge|head)`, pełnego `expected_head`, nazwy tego workflow i
dokładnego `run_id`. Per-run label izoluje kolejkę bez anulowania innych
queued jobs i bez zmiany required check, branch protection albo repo variables.
`FULLMAG_FEM_RUNNER_LABEL` pozostaje niezmieniona, ale nie wyznacza labela dla
`push` ani `pull_request`.
`workflow_dispatch` zachowuje wymagane wejście `inputs.runner_label`; operator
musi wtedy zweryfikować jego prywatny label przed rejestracją.

Runner z prywatnym per-run label zachowuje istniejący kontrakt `linux-ext4-loop-v1`
realizowany w Docker Desktop Linux. Etykieta tylko kieruje job do kolejki;
przed rejestracją i uruchomieniem runnera operator musi potwierdzić dokładny zestaw etykiet, profil Docker, ext4 z `findmnt` i
proweniencją loop/backing, `nsenter`, dostępność NVIDIA oraz wszystkie
prerequisites rzeczywistej bramki CPU/GPU. Sama etykieta ani sonda GPU nie
świadczą o gotowości runnera. Bramka
`run_frontend3d_required_gate.sh managed-fem-qualification` musi przejść w
całości; nie zmieniamy jej warunków, fallbacków, kodów wyjścia ani required
check. Ten routing nie kwalifikuje Windows-folder storage używanego przez
sesje FMS.

## Uruchomienie

```text
$assemblyReceipt = '<assembly-receipt.json>'
just docker-all-start $assemblyReceipt 3197
```

Port hosta jest konfigurowalny. W kontenerze zawsze używany jest port `8081`;
publikacja następuje wyłącznie na `127.0.0.1` Windows. Statyczny frontend
korzysta z tego samego originu dla API i WebSocket; nie ma osobnego serwera Node.
Docker Desktop musi używać silnika Linux i udostępniać GPU NVIDIA. Brak drivera
CUDA lub GPU kończy start przed uruchomieniem API. Dostępne urządzenie nie
nadpisuje wyboru CPU/GPU/auto w kanonicznym modelu. Jawne żądanie GPU nie ma
cichego fallbacku CPU; dostępność konkretnych zadań nadal określa capability map
bieżącego Fullmaga.

Kontener uruchamia również kanoniczny runtime service, scheduler i publikatory
puli zasobów. Health wymaga gotowego API oraz runtime service. Budżet kontenera
wynosi 4 CPU i 8 GiB RAM; konfiguracja dzieli go na compute (3 CPU, 6 GiB)
i przygotowanie (1 CPU, 1 GiB), pozostawiając 1 GiB dla API. Nie deklaruje
niezmierzonych zasobów GPU w puli. Bieżąca ścieżka accepted runs obsługuje CPU;
FEM GPU pozostaje dostępny przez istniejącą ścieżkę CLI w tym samym obrazie.
Obecność CUDA nie rozszerza capability map workspace.

Pierwszy start tworzy nowy accepted store. Kolejne starty otwierają kompletny
store; częściowy katalog, obcy owner lub niezgodna konfiguracja wymagają
kontrolowanego recovery. Nie są automatycznie zastępowane.

Start zapisuje Compose i receipt z nazwą projektu, ID kontenera, ścieżką stanu
oraz URL. Stan sesji jest osobnym montowaniem `/state`. Zatrzymanie kontenera
nie usuwa danych. Dla konkretnego projektu z receiptu:

```text
docker compose -f <compose.json> --project-name <compose-project> stop
docker compose -f <compose.json> --project-name <compose-project> start
```

Zatrzymanie najpierw zamyka admission API, następnie żąda drain od dokładnie
tego ownera runtime service i sprawdza terminalne receipty obu dzieci.
Compose daje 60 sekund na tę procedurę. Timeout lub utrata potwierdzenia
pozostawia stan nieznany i dowody do recovery. Nieudany start lub nadzór
zamyka API, zachowuje możliwie działający service i utrzymuje niezdrowy kontener
do jawnego zatrzymania przez operatora; nie wykonuje automatycznego takeover.

## Tryb deweloperski: dwa kontenery

```text
$assemblyReceipt = '<assembly-receipt.json>'
just docker-all-dev $assemblyReceipt 3197
```

Trzeci argument pozycyjny `source_root` dodaj tylko dla zarejestrowanego
worktree, tak jak w przykładzie z `$sourceRoot` powyżej.

### Wersjonowany kontrakt rootowego Compose

Źródłem topologii developerskiej jest wersjonowany rootowy `compose.dev.yaml`.
Definiuje dokładnie usługi `backend` i `frontend` oraz prywatną sieć Compose.
`backend` nie publikuje portu hosta i słucha na `8081` wyłącznie wewnątrz
tej sieci. `frontend` publikuje `127.0.0.1:3197:8080` (z konfigurowalnym
portem hosta) i używa proxy `http://backend:8081`. GPU otrzymuje tylko backend.

Wartość wybranego checkoutu jest ustalana w tej kolejności: jawny pozycyjny
`source_root`, następnie niepusty `FULLMAG_SOURCE_ROOT`, a na końcu główny
checkout Git. Każdy wybrany worktree musi być zarejestrowany. Dev image nie
kopiuje do warstwy źródeł aplikacji ani pakietu runtime. Backend dostaje
readonly bindy:

- `FULLMAG_SOURCE_ROOT` → `/opt/fullmag/source`;
- `FULLMAG_BACKEND_PACKAGE` → `/opt/fullmag/package`;
- `FULLMAG_PACKAGE_PROVENANCE` → `/opt/fullmag/provenance.json`.

Frontend dostaje readonly bindy dokładnie czterech żywych katalogów wybranego
checkoutu: `apps/control-room/app`, `src`, `public` i `scripts`. Polling/HMR
obserwuje te cztery katalogi z checkoutu; konfiguracja, manifesty i metadane
freeze są utrwalane osobno.
Frontend nie dostaje accepted store, certyfikatu writera ani GPU. Backend
pozostaje jedynym writerem sesji i właścicielem runtime service.

`compose.static.yaml` jest opcjonalną, osobną ścieżką release/legacy dla
statycznego frontendu. Nie jest używany do HMR ani do developerskiego proxy.

Rootowy Compose i argumenty launchera są zaimplementowane i przeszły kontrole
źródeł, parsera Compose oraz admission poleceń. Cold-start/HMR, przeglądarka,
zapis sesji i FEM/GPU w końcowym obrazie pozostają **VERIFICATION PENDING**;
same kontrole źródeł nie dowodzą tych zachowań.

Compose uruchamia `frontend` (Next.js dev z HMR) oraz `backend` (API, Python,
FEM/GPU i runtime service). Oba korzystają z tego samego przypiętego obrazu;
role mają osobne procesy, montowania i budżety. Frontend ma 2 CPU i 4 GiB RAM,
backend 4 CPU i 8 GiB RAM. GPU udostępniane jest wyłącznie backendowi.

Adres przeglądarki pozostaje `http://localhost:3197/workspace`. Port 8080
frontendu publikowany jest na loopback Windows. Backend słucha na 8081
wewnątrz sieci Compose; frontend przekazuje do niego API. Nie wymaga CORS
ani osobnego adresu API w przeglądarce.

Launcher wybiera checkout przez jawny pozycyjny `source_root`, niepusty
`FULLMAG_SOURCE_ROOT` albo — gdy żadnego z nich nie podano — główny checkout
Git. Katalogi Control Room `app`, `src`, `public` i `scripts` są montowane
readonly do frontendu.
pnpm 10.8.1 jest przygotowany offline w obrazie, z narzędzia już obecnego
w przypiętym builderze. Pierwszy start pobiera tylko zależności workspace.
Zapis źródeł w tych czterech żywych katalogach jest wykrywany przez polling
Watchpack (500 ms); Next aktualizuje stronę przez HMR i kompiluje ją przy
pierwszym wejściu. Zmiany poza tymi katalogami nie są obietnicą HMR.
Cold-start developerskiego frontendu ma limit 65 minut: obejmuje dwa bounded
probe narzędzi po 120 sekund, instalację zależności z limitem 60 minut oraz
60-sekundowy margines uruchomienia Next. Launcher używa 3900 sekund na
gotowość dev i 3960 sekund na klienta Docker; zwykły restart używa zachowanych
zależności. Cache, logi i `node_modules` pozostają w osobnym
podkatalogu `state/development` kanonicznego storage Windows. Nie używamy
hostowych `node_modules`, `.env` ani katalogu Git w kontenerze frontendu.
Backend montuje cały wybrany checkout readonly i pobiera publiczny Python DSL
z `/opt/fullmag/source/packages/fullmag-py/src`; skompilowane binaria pobiera
z osobnego montowania pakietu.

Pliki konfiguracji i manifesty zależności są utrwalane przy przygotowaniu
workspace. Ich zmiana wymaga przygotowania nowego workspace; HMR obejmuje
katalogi źródeł. Frontend nie ma montowania accepted store ani certyfikatu
zapisu sesji. Sesje i wyniki zapisuje backend bezpośrednio w swoim `/state`,
mapowanym do rzeczywistego storage Windows.

Zmiana kodu backendu nie wywołuje automatycznej kompilacji ani restartu
symulacji. Budowanie backendu jest wyłącznie na żądanie przez
`docker-all-dev-backend-build`; `docker-all-dev` uruchamia już złożony obraz i
nie kompiluje kodu ani nie przełącza działającej symulacji na nowy pakiet.
Zgłoszenie utrwala immutable snapshot
wybranego checkoutu (wybór: jawny pozycyjny `source_root`, potem
`FULLMAG_SOURCE_ROOT`, potem główny checkout) i zgłasza istniejącą kolejkę
managed GPU release.

`docker-all-dev-backend-build` zawsze tworzy job w trybie `snapshot`, także dla
głównego checkoutu. Dlatego oba digesty (`source_digest`,
`native_snapshot_sha256`) są wymagane przy późniejszym
`docker-all-dev-image` i muszą pochodzić z tego samego receiptu:

```text
$jobId = '<job-id-from-submission-receipt>'
$commit = '<resolved-40-character-commit-sha>'
$sourceDigest = '<64-hex-source-digest>'
$nativeSnapshotSha256 = '<64-hex-native-snapshot-sha256>'

just runner-wait $jobId 30
just docker-all-dev-image $jobId $commit $sourceDigest $nativeSnapshotSha256
```

Dla zarejestrowanego worktree dodaj `$sourceRoot` jako piąty argument obrazu,
po przekazaniu tych czterech wartości. Dwa argumenty (`job_id`, `commit`) dotyczą
wyłącznie `docker-all-image` dla joba zgłoszonego przez `docker-all-build`
w trybie `commit`; nie dotyczą receiptu z `docker-all-dev-backend-build`.
Obraz developerski nie kopiuje źródeł aplikacji ani pakietu do warstwy obrazu;
bindy
`/opt/fullmag/source` i `/opt/fullmag/package` pozostają częścią runtime.

Wartości tożsamości pochodzą z receiptu zgłoszenia. Edycja podczas capture
powoduje odmowę, późniejsze zmiany nie odrzucają przyjętego snapshotu ani nie
uruchamiają kolejnego buildu. Niezarejestrowane nowe pliki wymagane przez runtime
powodują odmowę zamiast cichego pominięcia; dodaj je do Git przed capture.
Ciężki build jest serializowany z działającymi kontenerami Fullmaga. Przy aktywnym
workspace zgłoszenie pozostaje w kolejce jako `queued`, z przyczyną
`waiting_for_existing_fullmag_container` w stanie koordynatora. Przed wykonaniem
buildu operator musi bezpiecznie zatrzymać własny workspace, gdy jego zadania się
zakończą. Launcher nie zatrzymuje ani nie restartuje runtime'u automatycznie.
Jeżeli runtime pojawi się podczas admission, job może otrzymać `blocked`;
sprawdź jego stan przed kolejną operacją. `docker-all-dev-image` wymaga
terminalnego `succeeded` oraz zweryfikowanych artefaktów.
Nowy obraz nie zastępuje działającego backendu. Zastosowanie wymaga kontrolowanego
uruchomienia. Ten tryb nie deklaruje automatycznego odtworzenia niezapisanego
workspace po zmianie obrazu backendu.

## Storage i granice weryfikacji

Launcher rozwiązuje storage przez `fullmag_storage.py`, przed pierwszym zapisem.
Kontekst składania, logi, provenance, receipty i pliki Compose pozostają w storage
projektu. Nie kopiuje hostowego `.env` ani Git do obrazu. Nie wykonuje prune ani
automatycznego kasowania kontekstu, obrazów lub sesji.

Sesje pozostają bezpośrednio w nowym folderze kanonicznego storage Windows,
montowanym do `/state`. Launcher działa natywnie w Windows i sprawdza lokalny
NTFS/ReFS, wolumen fixed oraz brak reparse points w przodkach. Nie używa wolumenu
nazwanego ani zastępczego katalogu kontenera. Utworzony namespace należy do
Dockera; bieżący natywny writer Windows odrzuca jego marker właściciela.
Do przenoszenia sesji między runtime’ami używaj eksportu `.fms`.

Dla bind mountu 9p (`0x1021997`) wymagany jest jawny `windows-folder-v1`.
Przed API launcher uruchamia i restartuje własny kontener próbny, weryfikuje
native readback oraz dziewięć kontroli: fsync pliku i katalogu, atomic replace,
publikację katalogu, blokadę między procesami, no-follow symlink/junction,
transakcje SQLite i odczyt po restarcie. Certyfikat hosta jest montowany readonly;
grant startowy wiąże go z obrazem, źródłem, binariami i bieżącym mount namespace.
Domyślna odmowa 9p pozostaje w mocy poza tym konkretnym profilem i folderem.

Te kontrole dopuszczają operacyjne użycie folderu. Nie dowodzą odporności na
utratę zasilania ani restart całej VM Docker Desktop. Power-loss pozostaje
`NOT VERIFIED`, zgodnie z istniejącym kontraktem trwałości Fullmaga.

Zielony receipt składania obrazu oznacza tylko złożenie sprawdzonych artefaktów.
Health API nie dowodzi działania canvas/WebGL, symulacji FEM GPU ani poprawności
naukowej. Te bramki wymagają osobnych dowodów. Lokalny zakaz kompilowania testów
jednostkowych pozostaje w mocy; użytkownik dopuścił wyjątek wyłącznie dla CI
tego zadania.
