# Lokalny runner Fullmag dla równoległych agentów i worktree

Status: PROPOZYCJA DO IMPLEMENTACJI, nie wdrożenie ani potwierdzenie kwalifikacji.
Zakres: jeden komputer Windows, Docker Desktop Linux engine, lokalne zadania
agentów i GitHub Actions. Nie zmieniamy fizyki, publicznego DSL/IR ani backendów.

## 1. Stan sprawdzony i problem

- Aktywny Docker context: desktop-linux; engine Linux/Docker Desktop.
- GPU hosta: NVIDIA GeForce RTX 4080 SUPER, 16376 MiB VRAM.
- Engine zgłasza 40 CPU i 211062964224 bajtów pamięci; to nie jest przydział
  dla pojedynczego joba. Limity należy ustalić zachowawczo po pomiarze.
- Istnieje resolver scripts/fullmag_storage.py, rejestry, profile i blokada
  jednego piszącego procesu na worktree, również między profilami.
- .github/workflows/frontend-3d-managed-fem.yml wymaga runnera fem-managed.
  scripts/ci/run_frontend3d_required_gate.sh wyklucza zastąpienie go trasą
  Windows Docker Desktop bez zweryfikowanego adaptera storage/receipt.
- Główny checkout jest dirty. Dokument nie zmienia tych plików ani PR #84.

Nie potrzebujemy runnera na każdy branch. Potrzebujemy jednego arbitra zasobów
i wielu niezależnych, jednoznacznie identyfikowanych zadań.

## 2. Architektura

Agent w worktree -> klient submit -> hostowy koordynator/kolejka
GitHub Actions -> jednorazowy kontener runnera -> ten sam koordynator
Koordynator -> snapshot źródeł -> lease zasobów -> worker -> receipt/artefakty

### Koordynator hostowy

Mały proces/usługa Python na Windows, z instalacją wersjonowaną i przypiętą
poza aktywnymi checkoutami agentów. Używa Docker API/CLI oraz obecnego resolvera.
To jedyny właściciel kolejki, planu mountów, uruchamiania kontenerów, anulowania
i przydziału GPU. Nie jest nowym solverem ani drugim launcherem fizyki.

Lokalny dostęp przez ACL użytkownika/named pipe; adapter kontenerowy przez
uwierzytelnione, ograniczone API, bez publicznego nasłuchu. Brak arbitralnych
poleceń shell, host paths, mountów i privileged flags w żądaniu zadania.
Przyjmowane są wyłącznie profile i operacje z wersjonowanego katalogu.

### Worker kontenerowy

Jeden kontener na job, a nie na branch. Obraz zawiera przypięty toolchain
i wykorzystuje obecne obrazy/zależności managed FEM; nie zawiera konkretnego
checkoutu aplikacji. Kod jest wejściem joba, image digest jest częścią profilu.
Bez docker.sock, tokena GitHub, .env hosta, katalogu domowego i innych worktree.
Brak --privileged; ograniczenia CPU/RAM/PID, tylko przyznane GPU i katalogi.

### Adapter GitHub Actions

Osobny, ephemeral kontener runnera, jeden job na rejestrację. Rejestracja JIT
lub krótkotrwały token dostarczany przez zaufany koordynator, nie zapisany
w obrazie ani repo. Początkowo jedna instancja, współdzieląca lokalną kolejkę.
Checkout konkretnego SHA pobierany niezależnie od dirty worktree użytkownika.
Oczekiwanie, anulowanie i artefakty GitHub są mapowane na job koordynatora.

## 3. Wybór wersji kodu

Ścieżka do worktree jest selektorem wejścia, NIE identyfikatorem wersji.
Branch jest metadanymi; może się przesunąć lub zmienić nazwę.

Obsługiwane jawne tryby:

1. commit: repo + pełny SHA, odtwarzalny checkout z właściwymi submodułami/LFS.
   Domyślny tryb CI; zapisujemy żądany ref oraz faktycznie rozwiązany SHA.
2. worktree snapshot: pełna bieżąca treść tracked files, dodania/usunięcia,
   jawnie uwzględnione untracked sources oraz submodule contents. Do iteracji
   agenta bez wymuszonego commita. Zapisujemy HEAD, dirty=true i hash snapshotu.

Domyślny submit lokalny wymaga wyboru trybu; nie pomija po cichu dirty changes.
Tryb commit na dirty worktree pokazuje, że niezacommitowane pliki są pominięte.
Tryb snapshot nie modyfikuje indexu, nie wykonuje stash/reset/checkout/commit.

Snapshot zawiera manifest ścieżek, typów plików, trybów i hashy treści, SHA
submodułów i ich dirty state, stan LFS oraz identyfikację repo przez Git common
directory. Symlinki/junctiony poza dozwolonym źródłem są odrzucane, nie śledzone.
.env, klucze, tokeny, .git credentials, node_modules, target i wyniki nie trafiają
do kapsuły. Jeśli wykluczony plik jest potrzebnym wejściem, job kończy się
czytelnym błędem; dane wejściowe podaje się osobno przez jawny manifest/hash.

Spójność snapshotu: krótki lease capture-source uzgodniony z agentem, manifest
przed i po kopiowaniu oraz weryfikacja skopiowanych bajtów. Rozbieżność oznacza
SOURCE_CHANGED, bez uruchomienia mieszanego drzewa. Sam podwójny hash nie daje
atomowości przy dowolnych edycjach z zewnętrznego IDE; dla ścisłej gwarancji
wymagany jest nieruchomy commit albo rzeczywista pauza zapisów podczas capture.
Po zatwierdzeniu kapsuły agent może kontynuować edycję worktree.

Kapsuła jest niezmienna. Worker dostaje prywatne wykonawcze drzewo źródeł,
ponieważ generatory mogą wymagać zapisu. Zmiany generatorów są rejestrowane,
nigdy automatycznie kopiowane do oryginalnego worktree. Kapsuła pozostaje
źródłem prawdy o wejściu; manifest wykonania rozróżnia wejście i generowane pliki.

## 4. Tożsamość i receipt

job_id jest unikalny dla uruchomienia; source_digest identyfikuje bajty kodu;
worktree_id identyfikuje właściciela cache; profile_id opisuje zgodność ABI.
Oddzielne attempt_id dla jawnego retry. Nie utożsamiamy tych identyfikatorów.

Manifest żądania: schema_version, job_id, owner/task_id, repo_id, worktree_id,
source_mode, requested_ref/resolved_commit, source_digest, dirty, profile_id,
operation, inputs_digest, requested_backend/device/precision, limity i timeout.

Receipt: powyższe plus runtime image digest, toolchain/dependency fingerprints,
host adapter version, resolved_backend/device/precision, GPU identity i driver,
storage/fs attestation, command/recipe, etapy/czasy, exit code, artifact hashes,
test results oraz jawna ocena qualification. Udany build != kwalifikacja nauki.
Wynik dirty snapshotu nie może zaliczać CI dla samego HEAD; dopasowanie wymaga
identycznego źródła, profilu, wejść i wymaganej bramki, nie samej nazwy brancha.

## 5. Storage i cache

Nie tworzymy nowego rootu. Hostowe wartości pozostają w .env głównego checkoutu;
runner otrzymuje tylko zwalidowaną projekcję ustawień, nie kopię .env.

Proponowane podkatalogi istniejącego storage:

- runs/<worktree-id>/<job-id>/request.json, receipt.json, logs/, artifacts/;
- runs/<worktree-id>/<job-id>/source/ lub indeksowana kapsuła z deduplikacją;
- builds/<worktree-id>/<profile-id>/ — istniejący przyrostowy build pod lease;
- index/runner-jobs.sqlite — kolejka na lokalnym filesystemie Windows;
- locks/ — istniejące blokady worktree rozszerzone o właściciela joba;
- build-volumes/ — kontrolowane backing storage Linux, po walidacji adaptera.

Frontend i compatibility roots zachowują obecną własność per-worktree.
Nie dopisujemy source SHA do profile-id przy każdej edycji: stracilibyśmy
przyrostowe buildy. Profile różnią image digest, toolchain, ABI, flags i lane.
Nie współdzielimy mutowalnych target/CMake/node_modules między worktree.
Wspólny wyłącznie cache obsługujący bezpieczną współbieżność; cache niezaufanego
CI nie może zatruwać zaufanej ścieżki release. Artefakty joba są niezmienne.

Snapshot nie jest worktree Git. Resolver trzeba rozszerzyć o walidowany
execution context pochodzący od hostowego koordynatora: origin repo/worktree,
przydzielone storage i profile. Nie fałszujemy .git ani nie ustalamy rootu
przez rodzica katalogu /workspace. Kontekst nie jest dowolnym plikiem JSON
akceptowanym jako autoryzacja zapisu; host wymusza scope przed mountami.

Docker Desktop/Linux storage wymaga osobnego adaptera. Nie zakładamy, że bind
NTFS, named volume lub sama obecność ext4 automatycznie spełnia obecny kontrakt
loop-backed ext4. Najpierw test mount/fs, pochodzenia backing storage, restartu,
limitów i receipt. Ewentualne rozszerzenie dopuszczalnego backendu storage wymaga
jawnej zmiany ADR 0030/governance; do tego czasu fem-managed NOT VERIFIED.
Nie przenosimy automatycznie dysku Docker Desktop ani istniejących danych.

## 6. Współbieżność i praca agentowa

MVP: jedno ciężkie zadanie build/runtime naraz; GPU max 1. Kolejka przyjmuje
wiele zadań, edycja różnych worktree pozostaje równoległa. Lekkie lint/unit
mogą uzyskać oddzielny, ograniczony slot po pomiarze RAM/CPU; nie reklamujemy
40 CPU jako bezpiecznego limitu każdego kompilatora.

Jedna globalna kolejka FIFO z klasą interaktywne/CI i aging przeciw zagłodzeniu.
Domyślnie bez wywłaszczania działającego joba. Snapshot następuje przy submit,
nie dopiero po godzinie w kolejce. Powtórny submit nie kasuje starszego joba;
opcjonalne replace-pending działa tylko w obrębie tego samego task/owner.

- Dwa worktree: odrębne source digests i build roots; współdzielony tylko lease GPU.
- Dwa zadania tego samego worktree: kolejka zgodna z obecną blokadą jednego pisarza,
  także gdy profile różne. Nie obchodzimy jej nowym katalogiem joba.
- Agent zmienia kod po submit: stary job buduje wcześniejszą kapsułę; nowy submit
  tworzy nową. Status pokazuje source_digest, a nie mylące „aktualny build”.
- Build i runtime potrzebny do testów tworzą jedno zadanie lub zależność przez
  artifact_id; nie uruchamiamy przypadkowego „ostatniego” binarium z cache.
- Sesja interaktywna rezerwuje artefakt aż do zamknięcia; późniejszy build nie
  nadpisuje używanego executable. Porty przydziela koordynator, brak stałego 3100.
- Zwykłe launchery muszą korzystać z tych samych leases. Przed ich migracją
  nieznany aktywny workload GPU wymaga odroczenia/zgody, nigdy zabijania procesu.

## 7. Proponowany interfejs — jeszcze nie istnieje

Przykładowe recepty just delegujące do jednego klienta:

    just runner-submit --worktree . --source snapshot --profile fem-gpu-release --operation build
    just runner-submit --worktree . --source commit --ref <FULL_SHA> --profile fem-gpu-release --operation qualify
    just runner-status <JOB_ID>
    just runner-logs <JOB_ID>
    just runner-wait <JOB_ID>
    just runner-cancel <JOB_ID>
    just runner-run --artifact <ARTIFACT_ID> --input <INPUT_MANIFEST>

To szkic interfejsu, nie instrukcje gotowe do wykonania. Żądanie zwraca job_id,
source_digest, queue position i przyczynę oczekiwania. Agent raportuje te ID.
GitHub zleca ten sam katalog operacji dla konkretnego event SHA: rozróżniamy
PR head SHA oraz merge-test SHA. Merge-test nie może być raportowany jako head.

## 8. Wykonawcy i bezpieczeństwo

Linux Docker: FEM CPU/GPU i jawne Linux test/build. Windows native executor:
MSVC/Windows FDM i Windows aplikacja. Obie trasy współdzielą kolejkę i receipt,
ale artefakty Linux nie udają DLL/EXE Windows. Pierwszy etap obejmuje tylko
kontenerowy FEM; adapter natywny integrujemy bez zastępowania istniejącej trasy.

Nie stosujemy Docker-in-Docker jako domyślnej ścieżki. Zaufane hostowe recipe
orchestruje worker; wewnątrz wykonywany jest wydzielony etap istniejącego managed
recipe bez ponownego tworzenia kontenerów. Podział musi zachować te same polecenia
i bramki — nie stworzyć skróconej kwalifikacji. PR nie może zmieniać zaufanego
supervisora/entrypointu i dzięki temu uzyskać socketu lub nowych mountów.

Na jedynym komputerze nie uruchamiamy automatycznie niezaufanych fork PR-ów.
Zewnętrzny kod wymaga jawnego zatwierdzenia; kontener z GPU nie jest granicą
równoważną osobnej VM. Token runnera pozostaje poza workerem, minimalne GITHUB_TOKEN
permissions, brak tokenów w logach/artifacts; kontrolowany network egress.
Zadanie CI nie wybiera dowolnej ścieżki hosta ani istniejącego dirty worktree.

## 9. Awarie i utrzymanie

Stany: submitted -> snapshotting -> queued -> preparing -> running ->
succeeded/failed/cancelled/interrupted. blocked oznacza brak prerekwizytu,
a queued zwykłe czekanie na znany zasób. Heartbeat nie jest samodzielnym dowodem
życia; po restarcie sprawdzamy container ID, labels job/owner i stan procesu.
Nie uruchamiamy duplikatu po samym timeoutcie obserwacji. Retry jawny, nowe attempt_id.
Cancel zatrzymuje wyłącznie procesy/kontenery danego joba, zapisuje receipt.
Limity dysku sprawdzane przed przyjęciem/przygotowaniem; brak miejsca nie wyzwala
automatycznego prune. GC domyślnie dry-run, usuwa tylko zatwierdzone, niepinowane
zasoby bez aktywnych leases. Brak globalnego docker system prune.

## 10. Plan wdrożenia i bramki

1. Kontrakt/ADR: rozszerzyć ADR 0030 i storage governance o source capsules,
   execution context, leases i adapter Docker Desktop. Nie zmieniać kryteriów
   fizycznych FEM. Test: przegląd mapowania starych i nowych tras.
2. Capture/manifest: nowy scripts/runner/ + testy; integracja fullmag_storage.py.
   Testy commit/dirty/untracked/submodule/LFS, symlink escape, sekrety, edycja
   podczas capture, Windows paths i identyczność content hash.
3. Kolejka/leases: trwały host coordinator, idempotent submit i reclaim.
   Testy równoległych agentów, tego samego worktree, crash/restart/cancel,
   FIFO/aging, konflikt interaktywnego GPU i limit dysku.
4. Obrazy i Compose: wersjonowane docker/runner/ oraz compose.runner.yaml,
   osobno listener/worker, przypięte digests i konfiguracja hostowa .env.example.
   Testy braku host secrets/socketu w workerze i odrzucenia nielegalnych mountów.
5. Adapter Windows Docker Desktop: zarządzane Linux storage oraz wywołanie
   istniejącej bramki just verify-fem-mixed-prism-airbox-runtime bez słabszej trasy.
   Sprawdzić wymaganą kolejność snapshot/build/run, CUDA, requested/resolved,
   artefakty i receipt. Bez tego nie nadawać statusu qualified fem-managed.
6. Agent CLI/launchery: justfile, scripts/windows/run_fullmag_fem.ps1 i wspólne
   helpery storage; przeniesienie kontroli lifecycle do jednego właściciela.
   Test A/B: różne worktree, zmiany podczas kolejki, brak krzyżowych artefaktów;
   A/A: drugi job czeka; uruchomienie wskazuje dokładny artifact_id.
7. GitHub: ephemeral listener na tym komputerze, zaufana polityka PR,
   minimalne permissions, mapowanie job/cancel/logs/artifacts. Workflow FEM
   przełączać dopiero po kwalifikacji adaptera, nie samą etykietą.
8. End-to-end: lokalny dirty snapshot i CI commit przechodzą tę samą operację,
   ale zachowują osobną tożsamość. Test restartu Docker i kontynuacji kolejki.
   Dopiero zielone wymagane kontrole pozwalają wrócić do merge PR #84.

Kryterium sukcesu: dwóch agentów może niezależnie zgłosić różne worktree,
dalej je edytować i odebrać wyniki dokładnie wskazanych wersji bez konfliktu
GPU/build/cache, a CI nie korzysta z lokalnego dirty kodu ani nie ukrywa fallbacku.

## 11. Źródła zewnętrzne

- https://docs.docker.com/desktop/features/gpu/ — GPU na Windows wymaga backendu WSL2.
- https://docs.docker.com/engine/storage/bind-mounts/ — ścieżki mountów należą do hosta daemon, nie klienta.
- https://docs.github.com/en/actions/reference/runners/self-hosted-runners — ephemeral routing i jeden job.
- https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/secure-use — ryzyko niezaufanego kodu PR na self-hosted runnerach.
