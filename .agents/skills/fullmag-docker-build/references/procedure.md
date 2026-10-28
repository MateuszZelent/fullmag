# Procedura od zera — build-data w wolumenach Docker

## Spis

1. Tożsamość i przygotowanie hosta
2. Mapa danych i warunki zgodności
3. Toolchain, aplikacja i iteracje
4. Miejsce i retencja
5. Minimalny odbiór
6. Aktualne granice i dowody

## 1. Tożsamość i przygotowanie hosta

Na nowym komputerze sprawdź dostępność Git, Pythona właściwego dla hosta
i silnika Docker Linux. Windows używa Docker Desktop; WSL wymaga włączonej
integracji dystrybucji. Linux/WSL używa bieżącego endpointu Docker. Pełny obraz zawiera realizacje FDM/FEM CPU/GPU; GPU wymaga
potwierdzonego dostępu urządzenia z kontenera. Wymuszonego GPU nie zamieniaj
na CPU. Nie instaluj CUDA, MFEM, hypre, libCEED ani kompilatorów Fullmaga na
hoście jako obejścia trasy kontenerowej.

Na nowym klonie skonfiguruj lokalny .env głównego checkoutu w natywnym
Windows PowerShell:

```powershell
Set-Location "<główny-checkout>"
python -B scripts/setup_docker.py
python -B scripts/setup_docker.py --check
```

Kreator zapisuje FULLMAG_PROJECT_STORAGE_ROOT i ustawienia operatora. Wybierz
storage dla sesji, wyników, projektów i ustawień; cache, pakiety, logi oraz
receipty buildu zostają w Docker volumes/BuildKit. Sprawdzenie --check niczego
nie zapisuje. Na tym samym hoście worktree dziedziczą konfigurację przez
resolver; nie twórz osobnego .env dla każdego worktree. Nie nadpisuj
istniejących ustawień. Te polecenia konfigurują hosta, ale nie budują, nie
uruchamiają ani nie usuwają kontenerów.

Odczytaj branch, pełny HEAD, dirty status, rejestr checkoutu i główny checkout
przez Git. Użyj istniejącego worktree zadania. Źródła mogą być dirty, ale manifest
buildu musi opisywać rzeczywiste wejście. Zachowaj cudze zmiany.

Przykładowe zmienne PowerShell są parametrami operatora, nie stałymi hosta:

```powershell
$source = "<absolutny-wybrany-checkout>"
$port = 3197
Set-Location $source
```

W Linux/WSL przejdź do tego samego wybranego checkoutu przez `cd`, a kreator
uruchom przez `python3 -B scripts/setup_docker.py`. Sesje/wyniki wymagają jawnego
storage użytkownika: Windows NTFS/ReFS albo Linux/WSL ext4/xfs/btrfs.
Szczegóły: [konfiguracja Linux/WSL](../../../../docs/guides/docker-setup-linux-wsl.md).
Kreator `.env` jest konfiguracją operatora; nie daje zgody na składowanie tam
cache, kontekstów, binariów lub logów builda. Nie kopiuj `.env` z innego hosta.

Projekt Compose jest `fullmag-master` dla głównego checkoutu lub
`fullmag-worktree-<worktree-id>` dla worktree. Ustal go przed toolchainem i
potwierdź w renderowanej konfiguracji, etykietach i receipcie. Porty mają być
unikalne; sieć bridge prywatna dla grupy. Nie przejmuj innej grupy.

## 2. Mapa danych i warunki zgodności

Nazwy poniżej opisują **role**, nie nowe działające recepty ani przydzielone
rozmiary. Ustal dokładne nazwy i labels w zarządzanym launcherze.

| Rola | Miejsce zapisu | Żywotność |
| --- | --- | --- |
| Źródło | Readonly bind checkoutu i Git common | Dane wejściowe, bez kompilacji w checkoutcie |
| Toolchain | Obraz + warstwy/cache BuildKit | Przypięte wersje i image ID; współdzielenie tylko zgodnych wejść |
| Backend build | Prywatny named volume → `/build` | Workspace, Cargo target, osobne CMake FDM/FEM, TMPDIR i log buildu; Cargo home jest wspólne w nowych renderach |
| Pakiet backendu | Prywatny subpath wspólnego named volume → `/opt/fullmag/package` | Bieżący pakiet, kandydat, rollback; zapieczętowane payloady współdzielone po kluczu |
| Frontend development | Prywatny named volume na katalog roboczy Next | node_modules, Next cache, wygenerowane konfiguracje i next.log; pnpm store wspólny w nowych renderach |
| Kontrola buildu | Named volume, ewentualnie podkatalog build/package | Provenance, wejścia/receipty, staging kontekstów, diagnostyka buildu |
| Dane użytkownika | Jawne bindy skonfigurowanego storage hosta | Sesje, wyniki, projekty i per-group ustawienia; bez technicznego cache |
| Ledger hosta | Dotychczasowy zarządzany kontrakt runtime | Rezerwacje fizycznego hosta, zachowana historia; nie cache kompilacji |

Przy zachowanym hostowym `/state` frontend nie może zapisywać workspace,
cache ani logu budowania do tego bindu. Dopuszczalny jest named volume na
podkatalogu development z readonly bindami `app/src/public/scripts`, jeżeli
wszystkie efektywne ścieżki zapisu nadal leżą w wolumenie. Sprawdzaj mount o
najdłuższym pasującym prefiksie; bind potomny może przykryć prawidłowy volume.

Aktywny Compose zapisuje build provenance do
/opt/fullmag/control/backend/runtime-provenance.json w grupowym control
volume. Zachowaj producenta i konsumentów po tej samej stronie wolumenu;
nie zmieniaj tego na writable host bind. Frontend dostaje wyłącznie swój
ograniczony podkatalog control volume. Ścieżki Cargo/Make /workspace mogą
być aliasem /build/workspace; potwierdź alias w obrazie i rzeczywiste targety.
Nie przykrywaj całego /opt/fullmag mutowalnym wolumenem tylko po to, aby
zmieścić jeden plik provenance.

Nie utożsamiaj named volume z warstwą kontenera. Odtworzenie kontenera ma
zachować cache. Volume oznacz rolą, grupą/checkoutem, profilem i tożsamością
toolchaina. Zmiana źródeł ani UUID runu nie powinny rotować cache. Izoluj profile
dev/release i nie współdziel mutable targetu między niezgodnymi toolchainami.

Przed buildem:

- przejrzyj wszystkie operacje hostowego `mkdir`, copy, archive i zapisu logów
  w launcherze, nie tylko mounty końcowych usług;
- dla Dockerfile użyj repozytoryjnego kontekstu wejściowego z allowlistą albo
  kontekstu przekazanego z Docker-managed staging, bez kopii w hostowym storage;
- zachowaj image pins, storage gates, locks, atomic publish i receipty;
- uruchom audyt JSON Compose ze skilla i następnie sprawdź rzeczywisty inspect.

Audyt mountów obejmuje usługi aplikacji, w tym service-level `tmpfs`, duplikaty
targetów i jawne wybrane zmienne cache. Nie odczytuje image ENV, runtime
symlinków ani override wykonanych przez entrypoint. Nie obejmuje zapisu hostowego launchera ani
wewnętrzną alokację BuildKit. Jego PASS jest warunkiem częściowym; wynik zawsze zawiera
`build_data_qualification: NOT VERIFIED`. External volumes wymagają osobnego
`volume inspect` oraz porównania dokładnej tożsamości/labels z receiptami.
Nested build volumes są odrzucane do osobnego przeglądu ownership/retencji.
Polecenia/entrypoint/ENV obrazu i hostowy BuildKit context muszą być sprawdzone
niezależnie; skrypt nie interpretuje dowolnych programów powłoki.

## 3. Toolchain, aplikacja i iteracje

Po integracji PR #198 aktywny `docker_dev.py up` deleguje do
`docker_volume_dev.py`; `docker_build_control.py` przechowuje operacje w
wolumenie kontrolnym. Dokładne piny `attempt` i `config_sha256` oraz komendy
`docker-dev-resume`, `docker-dev-restart-idle`, `docker-dev-recreate-volume`
oraz aktywację skryptu bez restartu `docker-dev-script`
opisuje [bieżący przewodnik DEV](../../../../docs/guides/docker-volume-development.md).
Nie stosuj starego `docker-dev-recreate` z hostowym receiptem dla tej trasy.
Nie kopiuj konfiguracji ani terminal receipt z wolumenu do hostowego storage.


W natywnym Windows PowerShell przejdź do wybranego checkoutu. Użyj tego samego
checkoutu dla toolchaina i aplikacji; recepta toolchaina wybiera źródło z
bieżącego justfile.

```powershell
Set-Location $source
python -B scripts/setup_docker.py --check
just docker-dev-toolchain
just docker-dev "$source" $port
# Opcjonalnie aktywny model ze skryptu w tym samym checkoutcie:
just docker-dev "$source" $port "examples/fem_relax_gpu_smoke.py"
```

docker-dev-toolchain przygotowuje przypięty obraz zależności przez Compose i
BuildKit dla projektu wybranego checkoutu. To nie jest kontener aplikacyjny i
nie kompiluje backendu. Postęp widać w terminalu oraz Docker Desktop Builds.
Uruchomienie właściwych usług wykonuje docker-dev: stałe serwisy grupy to
backend i frontend; nie uruchamiaj osobnego backend-build ani dawnego
runnera. docker-dev-build jest aliasem zgodności, który uruchamia
usługi, a nie bezpiecznym poleceniem build-only.

Źródła wybranego checkoutu są readonly bindami. Przy każdym starcie backend
sprawdza ich aktualną tożsamość. Jeżeli wejścia się nie zmieniły, używa
zweryfikowanego pakietu z named volume; w przeciwnym razie uruchamia
przyrostowy Cargo/Make w /build, publikuje pakiet do /opt/fullmag/package i
zapisuje build-provenance/logi w control volume. API oraz native runtime
startują w tym samym stałym kontenerze backend. Zmienione zależności mogą
wymagać przebudowy większego fragmentu; nie obiecuj, że każda edycja dotknie
dokładnie jeden crate.

Frontend czyta ten sam readonly checkout i zapisuje pnpm, node_modules, Next.js,
wygenerowane pliki oraz next.log w named volume. Zmiany frontendowe są
wykrywane przez HMR. To wymaga żywego frontendu i nie dowodzi jeszcze, że Home
jest poprawnie widoczny — potrzebny jest test przeglądarkowy.

Po zmianie backendu zapisz projekt, zakończ symulacje i uruchom ponownie
backend swojej grupy. Zwykły restart nie usuwa cache i sam nie ponawia Solve.
Zmiana obrazu albo mountów może wymagać kontrolowanego recreate. Nie kasuj
wolumenów, aby wymusić rebuild.

Skrypt .py rozwiąż względem wybranego checkoutu, np. examples/...py.
Launcher waliduje ścieżkę i hash, a backend wczytuje model jako aktywny w
Workspace. Zwykły skrypt uruchamia Solve; wait_for_solve pozostawia model
gotowy do Compute. Nie ponawiaj automatycznie uruchomienia o nieznanym wyniku.

Dane symulacji i ustawienia zachowują swój Windows storage. Małe handoffy
operacyjne runtime, certyfikaty przyjęcia storage i wskaźnik uruchomienia również
pozostają po stronie hosta; nie są cache, logami ani receiptami buildu.
Tymczasowe metadane Compose mogą przejść przez systemowy temp i są usuwane po
zakończeniu launchera. Sprawdź ten wyjątek po awarii launchera, ale nie umieszczaj
tam źródeł, archiwów, pakietów ani logów.

### Generowanie kontraktów API podczas developmentu

Po zmianie schematu najpierw zbuduj i uruchom backend oraz frontend tej samej
grupy. Następnie z wybranego checkoutu w natywnym PowerShell uruchom:

```powershell
just docker-dev-codegen "$source"
# Równoważne wejście:
just generate-api-openapi "$source"
```

To operacja na już działających usługach, bez lifecycle i bez dodatkowego
kontenera budującego. Brak usług lub niezgodna provenance jest błędem; nie
przechodź do hostowego Cargo ani `generate-api-openapi-legacy`. Staging,
zależności i receipt pozostają w wolumenach. Cztery wygenerowane źródła
OpenAPI/TypeScript są celowo publikowane w checkoutcie i wymagają przeglądu
oraz commita. Test źródeł helpera nie zastępuje rzeczywistego wykonania codegen.

Bieżące recepty volume DEV oraz dokładny format restartu i odtworzenia opisuje
[przewodnik operacyjny](../../../../docs/guides/docker-volume-development.md).
Nie używaj wycofanej komendy `docker-dev-recreate` z hostowym receiptem dla tej
trasy. Nowa próba przechowuje konfigurację i wynik w wolumenie kontrolnym.

## 4. Miejsce i retencja

Nowe grupy korzystają z [kontraktu współdzielenia i retencji](../../../../docs/guides/shared-build-storage.md). Po udanym zarządzanym starcie retencja pakietów i prywatnego incremental działa automatycznie; `docker-dev-maintain-cache` służy również do jawnego ponowienia. Przed usunięciem worktree `worktree-finish ... completed` wykonuje kwalifikowane sprzątanie jego prywatnych wolumenów/namespace; aktywny konsument blokuje zakończenie. Nigdy nie usuwa całego `fullmag-shared-*`.


Stosuj [kontrakt danych builda](artifact-policy.md): mapa writerów, ograniczenie
duplikacji, cache, Docker logs/BuildKit i rozdzielone operacje restart/recreate/GC.
Sama obecność named volume nie dowodzi kontroli zużycia dysku.

Przed zimnym buildem zmierz fizyczne wolne miejsce dysku danych Docker Desktop,
wolne miejsce w systemie plików VM i w wolumenach. Nie przenoś starego progu
8/16 GiB backing frontendu jako gwarancji miejsca na pełny toolchain/Cargo.
Przed buildem kandydata uwzględnij jednoczesną obecność cache, aktualnego
pakietu, rollbacku i nowego kandydata. Brak danych o przyszłym rozmiarze oznacz
jako oszacowanie, nie gwarancję.

Przy każdym etapie zapisz w Docker-managed miejscu: image IDs, commit/dirty
manifest, nazwy/labels wolumenów, początek/koniec, exit code, rozmiary przed/po
i wynik retencji. Kontroluj sumę użytych danych i narastanie generacji, nie
tylko pojemność logiczną VHDX. Nie deklaruj quota, jeżeli sterownik jej nie
egzekwuje. Nie sumuj współdzielonych warstw obrazów jako niezależnych kopii.

Retencja ma odróżniać:

- **pakiety:** bieżący + jeden zweryfikowany rollback; starsze binaria dopiero
  po trwałej publikacji i pod blokadą. Retired zachowuje receipt i rotację, bez
  pełnych kopii logów; limit wynosi 8 archiwów i 64 MiB plików. Legacy logi
  są hashowane tylko dla wpisów, które pozostaną w budżecie;
- **aktywny cache przyrostowy:** pozostaje dla kolejnego buildu;
- **nieaktywne generacje:** kandydaci do osobnego bounded cleanup po ustaleniu
  właścicieli, mountów, lease, rollbacku i referencji wyników;
- **orphan staging po awarii:** nie usuwać wyłącznie po nazwie lub wieku;
  wymaga dowodu zakończenia procesu/operacji i braku referencji;
- **logi i metadane:** stdout/stderr usługi Compose ma obecnie rotację
  `json-file` `10m × 3`; `next.log` ma limit 64 MiB i przy kolejnym starcie
  pełny log jest atomowo obracany do jednej poprzedniej kopii pod runtime
  lockiem. Nadmiar trafia do Docker stdout; `/retired` ogranicza duplikację
  do 8 wpisów / 64 MiB, ale
  Cargo/CMake/BuildKit i stare wolumeny nadal nie mają ogólnego GC;
- **sesje/wyniki/settings/ledger:** poza cleanupem builda.

Nie wykonuj globalnego `docker system prune`, `volume prune`, kasowania targetu
ani usuwania wszystkich starych grup. Zachowaj istniejący cache, jeżeli nie
można dowieść jego zbędności. Przed autoryzowanym cleanupem ponów kontrolę
konsumentów; zachowaj plan, receipt i pomiar faktycznie odzyskanych bajtów.
Nie wolno zastąpić tej procedury wyłączaniem blokad ani usuwaniem provenance.

## 5. Minimalny odbiór

Minimalny dowód wykonania:

- od zera: obrazy i pełny backend/frontend zbudowane w wybranej grupie;
- inspect: źródła readonly, build/logi/cache/provenance w Docker volumes,
  runtime dane nadal we właściwym storage hosta;
- API gotowe i Home widoczne; sam status kontenera `Running` nie wystarcza;
- restart bez zmian: ten sam cache, brak nowej generacji i dowód cache-hit;
- mała zmiana backendu: lista rzeczywiście kompilowanych modułów i czas;
- HMR po edycji w wybranym checkoutcie hosta: treść widoczna bez reloadu dokumentu;
- wielokrotny build: bieżący + rollback, kontrolowany przyrost metadanych,
  brak narastających niepotrzebnych binariów/stagingu;
- osobno, gdy zlecone: realne FDM/FEM CPU/GPU oraz skrypt auto/wait.

## 6. Aktualne granice i dowody

Bieżąca ścieżka live-shadow-v1 ma named volumes na backend /build,
/opt/fullmag/package, frontend /state/development i techniczne receipty.
Szczegóły oraz wyjątki hostowe są w bieżącej sekcji inwentarza writerów.
Historyczne tabele audytu zachowują stan sprzed migracji i nie opisują
automatycznie aktualnego HEAD. Przy zmianie kodu ponownie sprawdź mounty,
launchery i wszystkie writery; nie cofaj się do starej oceny bez nowych dowodów.

Znane ograniczenia, które trzeba raportować w każdym odbiorze:

- wolumeny nazwane, obrazy i BuildKit przeżywają usunięcie kontenera;
- brak ogólnego GC/quota dla named volumes, BuildKit oraz cache Cargo/CMake;
  nie twierdź, że całe zużycie Docker jest ograniczone;
- Docker Desktop cold build/start, rzeczywisty inspect, restart cache-hit,
  incremental rebuild, frontend HMR, uruchomienie .py i GPU pozostają
  NOT VERIFIED, dopóki nie ma dowodu z tej grupy na docelowym hoście.
