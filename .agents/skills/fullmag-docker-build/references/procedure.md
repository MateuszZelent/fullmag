# Procedura od zera — build bez hostowego storage

## Spis

1. Tożsamość i przygotowanie hosta
2. Mapa danych i warunki zgodności
3. Toolchain, aplikacja i iteracje
4. Miejsce i retencja
5. Odbiór i obecne przeszkody

## 1. Tożsamość i przygotowanie hosta

Na nowym komputerze sprawdź dostępność Git, natywnego Pythona i Docker Desktop
z silnikiem Linux. Pełny obraz zawiera realizacje FDM/FEM CPU/GPU; GPU wymaga
potwierdzonego dostępu urządzenia z kontenera. Wymuszonego GPU nie zamieniaj
na CPU. Nie instaluj CUDA, MFEM, hypre, libCEED ani kompilatorów Fullmaga na
Windows jako obejścia trasy kontenerowej.

Odczytaj branch, pełny HEAD, dirty status, rejestr checkoutu i główny checkout
przez Git. Użyj istniejącego worktree zadania. Źródła mogą być dirty, ale manifest
buildu musi opisywać rzeczywiste wejście. Zachowaj cudze zmiany.

Przykładowe zmienne PowerShell są parametrami operatora, nie stałymi hosta:

```powershell
$source = "<absolutny-wybrany-checkout>"
$port = 3197
Set-Location $source
```

Konfiguracja sesji/wyników na Windows nadal wymaga jawnego storage użytkownika.
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
| Backend build | Prywatny named volume → `/build` | Workspace, Cargo home/target, osobne CMake FDM/FEM, TMPDIR i log buildu |
| Pakiet backendu | Prywatny named volume → `/opt/fullmag/package` | Bieżący pakiet, kandydat, rollback, archiwum receiptów |
| Frontend development | Named volume na cały katalog roboczy Next | pnpm store, node_modules, Next cache, wygenerowane konfiguracje i next.log |
| Kontrola buildu | Named volume, ewentualnie podkatalog build/package | Provenance, wejścia/receipty, staging kontekstów, diagnostyka buildu |
| Dane użytkownika | Dotychczasowe jawne bindy Windows | Sesje, wyniki, projekty i per-group ustawienia; bez technicznego cache |
| Ledger hosta | Dotychczasowy zarządzany kontrakt runtime | Rezerwacje fizycznego hosta, zachowana historia; nie cache kompilacji |

Przy zachowanym `/state` Windows frontend nie może zapisywać workspace,
cache ani logu budowania do tego bindu. Dopuszczalny jest named volume na
podkatalogu development z readonly bindami `app/src/public/scripts`, jeżeli
wszystkie efektywne ścieżki zapisu nadal leżą w wolumenie. Sprawdzaj mount o
najdłuższym pasującym prefiksie; bind potomny może przykryć prawidłowy volume.

Provenance nie może być writable plikiem z hostowego storage. Przenieś jego
zapis i odczyt konsumentów do kontrolnego katalogu w wolumenie, zachowując
walidację hashy i trwałość publikacji. Ścieżki Cargo/Make `/workspace` mogą
być aliasem `/build/workspace`; potwierdź alias w obrazie i rzeczywiste targety.
Preferuj np. `FULLMAG_PACKAGE_PROVENANCE=/build/control/provenance.json`;
nie przykrywaj całego `/opt/fullmag` mutowalnym wolumenem tylko po to, aby
zmieścić jeden plik. Auditor uwzględnia tę zmienną oraz obecny fallback obrazu.

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

Istniejące nazwy wejść operacyjnych to:

```powershell
Set-Location $source
just docker-dev-toolchain
just docker-dev "$source" $port
# Opcjonalny skrypt z tego samego checkoutu:
just docker-dev "$source" $port "examples/fem_relax_gpu_smoke.py"
```

Uwaga: w bazowej implementacji `just docker-dev-build` wywołuje ścieżkę `up`
i może uruchomić usługi. Nie traktuj nazwy jako gwarancji build-only. Pozostałe
trasy i pośrednie zapisy wrappera opisuje [audyt recept](recipe-audit.md).

**Nie wykonuj tej sekwencji jako volume-only, dopóki kontrola kodu nie wykaże
usunięcia zapisów builda w hostowym storage.** Te nazwy nie oznaczają, że migracja
jest ukończona. Nie dodawaj fikcyjnego `--volume-only` lub nieistniejącej recepty.

1. Toolchain przygotuj na nowym hoście lub po zmianie jego pinów. Recepta
   przekazuje `--direct-development`; bez tej flagi bootstrap używa projektu
   `fullmag-toolchain`. Samo późniejsze podanie `$source` do `docker-dev` nie
   zmienia wcześniej wybranego projektu bootstrapu.
2. Compose/BuildKit buduje obraz zależności oraz brakujące zgodne base/helper
   images. Postęp jest w terminalu / Docker Desktop Builds. Zasoby BuildKit
   nie są trzecią stałą usługą aplikacji.
3. Stały `backend` pod własną blokadą przechwytuje spójny manifest readonly
   źródeł. Synchronizuje jeden ext4 workspace, zachowując metadane identycznych
   plików; nie archiwizuje całego checkoutu per restart.
4. Zgodny pakiet daje `phase=start state=cache-hit`; w przeciwnym razie
   uruchamia się przyrostowy Cargo/Make. Zmienione zależne moduły mogą wymagać
   kompilacji. Zmiana ABI/flag/pinów może poszerzyć zakres. Mierz to zamiast
   obiecywać build w kilka sekund.
5. Kandydat powstaje w wolumenie. Zweryfikuj pełne pliki/hash/provenance,
   opublikuj trwale, zachowaj poprzedni rollback i dopiero uruchom API/native
   runtime w tym samym kontenerze. Kompilacja i API są w logu `backend`.
6. `frontend` używa tego samego checkoutu i HMR. Zależności instaluje frozen
   z repozytoryjnego lockfile do wolumenu; hostowe node_modules nie są wejściem.
7. Po zmianie backendu zapisz projekt, zakończ symulacje i restartuj wyłącznie
   backend swojej grupy. Restart nie powtarza Solve. Zmiana obrazu/mountów może
   wymagać kontrolowanego recreate, nie usunięcia cache.
8. Skrypt `.py` rozwiąż w wybranych źródłach, zweryfikuj hash i wczytaj jako
   aktywny model Workspace. Zwykły skrypt uruchamia Solve; `wait_for_solve`
   pozostawia model gotowy do Compute. Nie ponawiaj automatycznie przyjętego
   lub niepotwierdzonego uruchomienia.

Pełny source digest i native source identity to odrębne kontrakty. W bazowej
implementacji także edycja frontendu może ominąć pakietowy fast path, choć nie
zmienia natywnego dirty digestu. Nie osłabiaj provenance dla szybszego startu;
oddzielną optymalizację uzasadnij pomiarem i testem.

## 4. Miejsce i retencja

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
  po trwałej publikacji, pod blokadą, po zachowaniu logów/receiptów;
- **aktywny cache przyrostowy:** pozostaje dla kolejnego buildu;
- **nieaktywne generacje:** kandydaci do osobnego bounded cleanup po ustaleniu
  właścicieli, mountów, lease, rollbacku i referencji wyników;
- **orphan staging po awarii:** nie usuwać wyłącznie po nazwie lub wieku;
  wymaga dowodu zakończenia procesu/operacji i braku referencji;
- **logi i metadane:** wymagają osobnej jawnej polityki, bo sama retencja
  binariów ich nie ogranicza;
- **sesje/wyniki/settings/ledger:** poza cleanupem builda.

Nie wykonuj globalnego `docker system prune`, `volume prune`, kasowania targetu
ani usuwania wszystkich starych grup. Zachowaj istniejący cache, jeżeli nie
można dowieść jego zbędności. Przed autoryzowanym cleanupem ponów kontrolę
konsumentów; zachowaj plan, receipt i pomiar faktycznie odzyskanych bajtów.
Nie wolno zastąpić tej procedury wyłączaniem blokad ani usuwaniem provenance.

## 5. Odbiór i obecne przeszkody

Minimalny dowód wykonania:

- od zera: obrazy i pełny backend/frontend zbudowane w wybranej grupie;
- inspect: źródła readonly, build/logi/cache/provenance w Docker volumes,
  runtime dane nadal we właściwym Windows storage;
- API gotowe i Home widoczne; sam status kontenera `Running` nie wystarcza;
- restart bez zmian: ten sam cache, brak nowej generacji i dowód cache-hit;
- mała zmiana backendu: lista rzeczywiście kompilowanych modułów i czas;
- HMR po edycji na Windows: treść widoczna bez reloadu dokumentu;
- wielokrotny build: bieżący + rollback, kontrolowany przyrost metadanych,
  brak narastających niepotrzebnych binariów/stagingu;
- osobno, gdy zlecone: realne FDM/FEM CPU/GPU oraz skrypt auto/wait.

Stan bazowy z audytu 18.10.2026 — sprawdź, czy aktualny kod już to naprawił:

| Przeszkoda | Miejsce kontroli |
| --- | --- |
| Toolchain context/logi/receipty powstają na hoście | `scripts/bootstrap_docker_toolchain.py::build`, `capture_inputs` |
| Base/wrapper contexts i receipty w hostowych builds/runs | `scripts/docker_dev.py::_development_base_context`, `_ensure_development_base`, `_runtime_image_reference` |
| Writable host bind provenance | `compose.dev.yaml`, `docker/all-in-one/backend_dev.py::_publish_runtime_provenance` |
| Frontend ext4 backing i next.log na Windows | `scripts/docker_frontend_cache.py`, `docker/all-in-one/frontend_dev.py`, `compose.dev.yaml` |
| Brak GC wszystkich starych generacji i orphan staging | `docker_backend_volume_cache.py`, `backend_dev.py`, aktualny przewodnik retencji |

Przy tych przeszkodach raportuj: „obecne recepty nie spełniają volume-only”,
z dokładnym zapisem/mountem do migracji. Nie uruchamiaj zgodnego tylko z dawną
architekturą buildu i nie przedstawiaj go jako realizacji tej procedury.
