# ADR 0030 — Project storage i współbieżność buildów

**Status:** accepted for implementation (polityka)

**Date:** 2026-09-09

**Decision makers:** Fullmag core

## Kontekst

Buildy, cache, runtime’y, logi i worktree Fullmag były tworzone w kilku
niezależnych lokalizacjach. Instrukcje, launchery i starsze plany wskazywały
różne defaulty, a sam wpis `prunable` nie rozstrzygał, czy katalog zawiera
unikalny commit, dirty WIP, aktywny build albo zamontowane dane. Stan z
2026-09-09 obejmował 123 rejestracje worktree, w tym 99 `prunable`; jest to
sygnał do kontrolowanego inventory, a nie zgoda na masowe usuwanie. Inspekcja
była ukierunkowana i nie stanowi pełnego audytu całego dysku `C:`.

Decyzja rozdziela cztery pojęcia:

- **project root** — nadrzędny katalog wspólnego repozytorium Git;
- **repo/worktree root** — konkretny checkout źródeł;
- **project storage root** — zaakceptowana granica danych generowanych przez
  build i uruchomienia;
- **build profile** — jeden zgodny mutable output przypisany do worktree,
  platformy i zestawu narzędzi, ze stanem ostatniej operacji.

Cache współdzielony, zweryfikowany runtime oraz wynik naukowy są osobnymi
kategoriami. Cache nie dowodzi zgodności binariów ze źródłem, a plan lub
instrukcja nie jest dowodem działającego runtime’u.

## Decyzja

### Jedna granica storage na projekt

Tożsamość projektu wyznacza główny checkout z pierwszego rekordu
`git worktree list --porcelain`, po wcześniejszym potwierdzeniu repozytorium i
wspólnego katalogu Git. Nie wyznacza jej `cwd.parent`, głębokość worktree ani
nazwa brancha. Domyślne project storage roots to:

| Host | Project storage root | Trasa wykonania |
| --- | --- | --- |
| Windows | `C:\git\fullmag\storage` | native FDM/Rust/Python/Control Room; Docker Desktop dla FEM |
| dedykowany Linux runner | `/zfn2/mateuszz/git/fullmag/storage` | managed, container-backed `just` dla FEM/MFEM/CUDA |

`FULLMAG_PROJECT_STORAGE_ROOT` jest kanonicznym override’em całego rootu.
Istniejące zmienne narzędziowe są dozwolone wyłącznie jako zwalidowane
podkatalogi właściwej części storage. Resolver akceptuje root po sprawdzeniu
absolutności, project identity, markera projektu, containment oraz
junction/symlink escape; wymagany mount i możliwość utworzenia katalogów są
sprawdzane przy inicjalizacji przed uruchomieniem komendy.
Odmowa kończy operację przed `mkdir`, instalacją, pobraniem zależności lub
kompilacją. Nie ma fallbacku do repozytorium, rootu dysku, profilu użytkownika
ani niekwalifikowanego `TEMP`/`/tmp`.

Struktura logiczna jest stała:

```text
<project-root>/
  fullmag/                         repo root
  worktrees/<task-id>/             dodatkowe checkouty źródeł
  storage/
    builds/<worktree-id>/<profile-id>/
    builds/<worktree-id>/frontend/
    cache/                         tylko cache bezpieczne współbieżnie
    runtimes/<worktree-id>/        compatibility/staging, nie dowód kwalifikacji
    runs/<worktree-id>/            wyniki i logi uruchomień
    tmp/<worktree-id>/<profile-id>/ staging krótkotrwały
    index/                         rejestr właścicieli i stanów
    locks/                         blokady alokacji i publikacji
```

Każda wspierana recepta build/test/install, launcher, Compose i skrypt
publikacji musi używać tego resolvera i preflightu przed pierwszym zapisem.
Zmienne `FULLMAG_WINDOWS_BUILD_ROOT`, `FULLMAG_WINDOWS_CACHE_ROOT`,
`FULLMAG_WINDOWS_TEMP_ROOT` i podobne mogą być nazwami transportowymi dla
Compose lub istniejących adapterów, ale ich wartości muszą pochodzić z
zaakceptowanego storage/build lease. Nie ustanawiają drugiego defaultu.

### Worktree i źródło

Nowe worktree są tworzone pod `<project-root>/worktrees/<task-id>` po sprawdzeniu
istniejących rejestracji. Najpierw należy ponownie użyć zgodnego worktree tego
zadania, jeśli nie ma aktywnego właściciela. Domyślnie zadanie ma jedno
worktree; dodatkowe wymaga zapisanej, niezależnej potrzeby.

Rejestr worktree zawiera `task_id`, właściciela/sesję, ścieżkę, branch, bazowy
commit, cel i stan. Utworzenie worktree nie oznacza `fetch`, `pull`, `rebase`,
aktualizacji submodułów ani instalacji wszystkich zależności. Bazę wybiera
zadanie jawnie. Audyt, plan i mała edycja dokumentu nie tworzą nowego
checkoutu tylko z powodu samej izolacji.

### Build, cache i równoległość

Profil builda powinien rozróżniać platformę, toolchain, debug/release, funkcje,
rodzinę backendu, urządzenie, precyzję i zależności ABI. Obecny resolver używa
jawnej nazwy profilu i nie wylicza automatycznie pełnego fingerprintu ABI;
reuse po niezgodnej zmianie wymaga wyboru nowego profilu. Mutable output jest
przypisany do `(project, worktree, profile)` i zawiera Cargo target lub
native/staging oraz atomowy status ostatniej operacji. Nie wolno współdzielić
`target`, `node_modules` ani native output pomiędzy worktree.

Kolejne zgodne kompilacje w jednym worktree używają tego samego profilu pod
blokadą. Drugi zapis do tego profilu czeka albo kończy się czytelnym błędem; nie
tworzy sam kolejnego płaskiego katalogu. Osobna generacja jest uzasadniona
izolowaną kwalifikacją, niezgodnym toolchainem, zmianą ABI lub publikacją
runtime’u. Shared cache jest dopuszczony tylko wtedy, gdy konkretne narzędzie
gwarantuje bezpieczną współbieżność.

Core runner zapisuje commit, dirty state, profil, ścieżki, proces, host, status
i exit code. To ślad operacyjny, nie manifest kwalifikacji. Publikacja runtime’u
musi dodatkowo zapisać requested/resolved execution, wersje narzędzi, hashe i
artefakty oraz zachować poprzednią sprawną generację po błędzie.

### Osobne trasy Windows i Linux

Windows native używa `scripts/windows/run_fullmag.ps1`; FEM CPU/GPU używa
`scripts/windows/run_fullmag_fem.ps1`, Docker Desktop i bind mountów z
zaakceptowanego storage. Launchery Windows nie wywołują `wsl.exe`, nie używają
WSL checkoutu i nie wprowadzają cichego CPU fallbacku dla wymuszonego GPU.
`run_fullmag_wsl.ps1` jest historycznym aliasem zgodności.

Linux managed używa repozytoryjnego `justfile` i container-backed recipes.
`/zfn2/mateuszz/git/fullmag/build-volumes/*.ext4` oraz
`/mnt/fullmag-zfn2-native` są zarządzaną infrastrukturą backing/mount profilu,
a nie drugim publicznym project storage root. Ochrona ext4, `findmnt`, loop
device i zakaz bezpośredniego builda na CIFS pozostają wymagane. Nie zastępuje
się ich mechaniczną zamianą na ścieżki Windows.

### Legacy, inventory i sprzątanie

Istniejące flat roots, takie jak `C:\fullmag-build`, `C:\fullmag-cache` i
`C:\fullmag-tmp`, pozostają read-only inputs do inventory/migracji. Nie są
aktualnymi defaultami; nowe buildy muszą je odrzucić z komunikatem wskazującym
`FULLMAG_PROJECT_STORAGE_ROOT`. Nie przenosi się ani nie usuwa ich
automatycznie.

Podstawowe inventory jest read-only i raportuje zarejestrowane worktree,
właściciela, stan oraz wykryte rooty legacy bez prawa do usuwania. Pełne
inventory poprzedzające cleanup musi dodatkowo zebrać kategorię, rozmiar,
mtime, manifest/status, lease oraz dowody aktywnego procesu/kontenera i mountu.
Prune domyślnie wykonuje dry-run. Apply wymaga autoryzacji dla
konkretnej kategorii i ścieżek oraz ponownego sprawdzenia dirty state,
unikalnych commitów, procesów, kontenerów, mountów, lease’ów, current runtime
i containment. `prunable`, wiek lub wygasły lease nie są dowodem zbędności.

### Granica egzekwowania

`AGENTS.md`, skille i testy źródłowe określają zachowanie agenta, ale nie są
nieprzekraczalną blokadą systemową. Twarda granica wymaga konfiguracji
uprawnień/sandboxa hosta, zatwierdzonych mountów i dostępu do Docker daemon.
Wrapper można ominąć surowym poleceniem, dlatego kwalifikacja musi obejmować
rzeczywisty command, inventory przed/po, manifest i ścieżki. Nie deklaruje się
„całkowitego zakazu zapisu” wyłącznie na podstawie dokumentacji.

## Konsekwencje

### Rozszerzenie 2026-09-11: właściwości zamiast jednego filesystemu

Użytkownik zatwierdził rozdzielenie historycznej trasy `linux-ext4-loop-v1`
od nowej bramki `capabilities-v1`. Ext4 nie jest wymaganiem FEM. Nowy profil
ma oceniać rzeczywiste właściwości storage osobno dla źródeł, artefaktów i
buildów, zachowując containment, tożsamość mountu, lease i provenance.
Nie ustanawia nowego rootu ani zgody na migrację danych.

Implementacja i kryteria dopuszczenia są opisane w
[kontrakcie bramki](../guides/storage-capability-gate.md). Sonda właściwości
nie zastępuje kwalifikacji managed FEM; dotychczasowe recepty Linux zachowują
guard ext4 do jawnej migracji. Wynik `passed` sondy nie uprawnia do publikacji
kwalifikowanego runtime’u ani zmiany etykiety CI.

- Nowe artefakty mają jedną, przewidywalną granicę i identyfikowalny właściciel.
- Zgodne buildy korzystają z cache bez tworzenia płaskiego katalogu dla każdego
  wywołania, a kolizja mutable outputu jest widoczna.
- Windows Docker Desktop i Linux ext4 zachowują różne wymagania infrastruktury
  bez mieszania ich w jeden pozorny fallback.
- Legacy dane pozostają dostępne do analizy i rollbacku, ale porządkowanie
  wymaga osobnej procedury i zgody.
- Sama zmiana dokumentacji nie dowodzi, że wszystkie launchery i recepty już
  wywołują resolver. Wdrożenie kodowe musi być potwierdzone testami kontraktu,
  parserem PowerShell/bash oraz rzeczywistym inventory.

## Obowiązki wdrożeniowe

1. Utrzymać jeden resolver layoutu, marker projektu, path guard, blokadę OS,
   rejestr właścicieli i atomowy status operacji.
2. Podpiąć Windows native/FEM, Linux managed `just`, Make, Compose, setup,
   eksport i restore runtime’u przed pierwszym zapisem.
3. Dodać testy: worktree na innej głębokości, niedozwolony override,
   junction/symlink escape, brak uprawnień i kolizja dwóch buildów. Testy
   publikacji runtime’u zachowują osobną bramkę failed candidate/`current`.
4. Dodać read-only inventory i dry-run prune; nie wykonywać migracji ani
   usuwania w ramach samego wdrożenia polityki.
5. Weryfikować osobno source/contract, storage/provenance, managed runtime,
   browser/WebGL, physics i release qualification. Brak toru oznaczać
   `NOT VERIFIED`.

## Migracja i rollback

Migracja legacy jest późniejszym, jawnie zatwierdzonym zadaniem. Kandydat może
zostać skopiowany do `storage/builds/legacy/<date>/<legacy-id>` dopiero po
potwierdzeniu braku aktywnego właściciela, procesu i mountu oraz po zachowaniu
manifestu i logów. Żadne źródła, wyniki naukowe, WIP ani poprzedni runtime nie
są usuwane automatycznie.

Publikacja runtime’u używa stagingu, walidacji, hash-addressed directory,
blokady i atomowego przełączenia `current`. Nieudany build, walidacja, archive
albo rebind zostawia poprzedni poprawny runtime dostępny. Rollback wybiera
poprzednią zweryfikowaną generację; nie uruchamia niezweryfikowanego legacy
artefaktu po cichu.

## Referencje

- `AGENTS.md`
- `.agents/instructions/backend.md`
- `docs/guides/windows-first-development.md`
- `docs/superpowers/plans/2026-09-02-project-build-storage-concurrency.md`
- `docs/superpowers/specs/2026-07-29-persistent-external-builds-design.md`
- `scripts/fullmag_storage.py` (resolver i allocator po wdrożeniu)
