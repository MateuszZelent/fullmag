# Porządek worktree i buildów Fullmag

Status: implementacja źródłowa gotowa do review, 2026-09-09; kwalifikacja
runtime pozostaje ograniczona zgodnie z raportem weryfikacji.
Pierwotna propozycja poniżej zachowuje kontekst decyzji; bieżący kontrakt opisuje `docs/guides/fullmag-build-storage-governance.md`.
Zakres: wdrożenie reguł i kontroli Windows/Linux oraz ręcznych recept just; bez usuwania istniejących danych i synchronizacji z remote.

## Potwierdzony problem

- Checkout: `C:\git\fullmag\fullmag`; zawiera zastane zmiany UI, `.gitignore` i submodułów.
- `git worktree list --porcelain`: 123 rejestracje, 99 `prunable`. Nie jest to liczba katalogów bezpiecznych do usunięcia.
- Istnieją `C:\fullmag-build`, `C:\fullmag-cache`, `C:\fullmag-tmp` oraz liczne katalogi build/worktree w `C:\git\fullmag`.
- `scripts/windows/run_fullmag.ps1`, `setup_fullmag.ps1`, `run_fullmag_wsl.ps1` i `verify_fem_frequency_domain_native_contract.ps1` nadal zawierają domyślne ścieżki do głównego katalogu dysku.
- `.agents/instructions/backend.md` nadal nakazuje stare domyślne katalogi. Plan `2026-09-02-project-build-storage-concurrency.md` wskazuje już `C:\git\fullmag\storage`. Instrukcje i plan są sprzeczne.
- Wyszukanie plików storage w `scripts` nie znalazło proponowanego `fullmag_storage.py`; istnieją skrypty managed FEM. Nie należy przedstawiać starego planu jako wdrożenia.
- To ukierunkowana inspekcja źródeł i katalogów, nie pełny audyt dysku ani pomiar zajętości.

## Docelowy układ Windows

```text
C:\git\fullmag\
  fullmag\                   główny checkout
  worktrees\<task-id>\       dodatkowe checkouty źródeł
  storage\
    builds\<worktree-id>\<profile-id>\
    cache\                   cache współbieżnie bezpieczne
    runtimes\                zweryfikowane generacje runtime
    runs\<task-id>\<run-id>\ wyniki eksperymentów agenta
    tmp\<task-id>\           pliki tymczasowe zadania
    index\                   rejestr właścicieli, stanów i ścieżek
    locks\                   blokady buildów i publikacji
```

To jedyne domyślne miejsca nowych danych Fullmag. Nie tworzymy kolejnych katalogów typu `build-final2`, `audit-target`, `.worktrees` w checkoutcie ani katalogów Fullmag w katalogu głównym dysku.
Jawnie wskazane przez użytkownika wyniki naukowe pozostają w wybranej lokalizacji. Instalacje systemowe, dane samej aplikacji Codex i wewnętrzny magazyn Docker Desktop nie są cache Fullmag do automatycznego przeniesienia.
Ścieżki wyznacza tożsamość głównego repozytorium, nie `cwd.parent`: worktree może leżeć na innej głębokości.

## Zasady do AGENTS.md

1. Przed utworzeniem worktree sprawdź istniejące checkouty i rejestr zadania. Użyj zgodnego worktree tego zadania, jeśli nie ma aktywnego innego właściciela. Nie twórz worktree dla samego audytu, planu lub niewielkiej edycji dokumentu.
2. Nowe worktree wymaga wpisu: task-id, właściciel/sesja, ścieżka, branch, bazowy commit, cel i stan. Domyślnie jedno worktree na zadanie; dodatkowe wymaga konkretnej niezależnej potrzeby zapisanej w rejestrze.
3. Utworzenie worktree nie oznacza polecenia fetch/pull/rebase, aktualizacji submodułów ani instalacji wszystkich zależności. Używaj ustalonego lokalnego ref; aktualizację remote wykonuj, gdy wymaga jej zadanie, z jawnym wskazaniem bazy.
4. Wszystkie buildy, również diagnostyczne, korzystają z jednego resolvera storage i preflightu. Zakaz fallbacku do checkoutu, C:\, profilu użytkownika lub losowego TEMP w razie braku uprawnień. Błąd ścieżki kończy polecenie przed zapisem.
5. Rust, CUDA/CMake i frontend używają zgodnego profilu builda przypisanego do worktree. Nie kopiuj targetów i node_modules pomiędzy worktree. Współdziel tylko cache, których narzędzie obsługuje współbieżność.
6. Na koniec pracy zapisz stan worktree, buildów, procesów i wyników: zakończone, oczekuje review, zablokowane albo zachowane WIP. Podaj powód pozostawienia oraz następny krok. Przerwane zadanie musi dać się odzyskać z rejestru.
7. Zakończenie zadania nie upoważnia do usunięcia niezintegrowanego kodu. Sprzątanie wymaga autoryzacji i ponownego sprawdzenia zmian, unikalnych commitów, procesów, mountów i ścieżek. Wiek i `prunable` nie są dowodem zbędności.

W AGENTS.md pozostaje krótka reguła i link do jednej polityki. Szczegóły nie są kopiowane do każdego skilla.

## Buildy: izolacja bez namnażania kosztów

Profil obejmuje platformę, toolchain, konfigurację debug/release, funkcje, rodzinę backendu i zależności ABI. Nie używamy samej nazwy brancha jako tożsamości.
Zwykłe kolejne kompilacje w jednym worktree używają tego samego zgodnego katalogu przyrostowego pod blokadą. Równoczesny drugi zapis do tego katalogu czeka lub kończy się czytelnym błędem; nie tworzy sam kolejnego targetu.
Osobna generacja jest potrzebna do izolowanej kwalifikacji, zmiany niezgodnego toolchainu lub publikacji runtime. Manifest zapisuje commit i stan lokalnych zmian; cache nie dowodzi zgodności binariów ze źródłami.
To proponowana korekta starego planu: osobny `build_N` dla każdego wywołania nie powinien być domyślnym trybem codziennej pracy.

| Obszar | Wymagane kierowanie |
| --- | --- |
| Rust | `CARGO_TARGET_DIR` w profilu; Cargo/Rustup cache w storage |
| CUDA/CMake | jawny katalog `-B` w profilu; cache CUDA i temp w storage |
| Frontend | pnpm store w cache, output Vite/TS i cache testów w profilu, przeglądarki w cache |
| node_modules | instalacja zależna od worktree; jeżeli narzędzie wymaga lokalnej ścieżki, kontrolowany i zarejestrowany link do storage, bez kopiowania katalogu |
| FEM Windows | istniejący managed `just` → launcher Docker Desktop; sprawdzone bind mounty |
| FEM Linux | istniejąca ochrona ext4/CIFS; odrębne wdrożenie hosta, bez mechanicznej zamiany ścieżek Windows |
| Wyniki i logi | identyfikator zadania/run oraz jawne ścieżki; nie mnożyć raportów w root repo |

Nie zmieniamy kontraktu publicznego `fullmag x.py` i jego `x.zarr` przez politykę porządku. Eksperymenty agenta dostają jawny output-dir w storage.

## Co faktycznie wymusza reguły

- Instrukcje i skille określają zachowanie, ale nie stanowią nieprzekraczalnej blokady systemowej.
- Wspólny preflight sprawdza absolutne i rozwiązane ścieżki, marker storage, wyjście przez junction/symlink, zmienne środowiskowe, właściciela, blokadę i mounty przed mkdir/build/install.
- Stare zmienne `FULLMAG_WINDOWS_*_ROOT` mogą być adapterami zgodności wyłącznie po walidacji; nie mogą otwierać drugiej dowolnej przestrzeni zapisu.
- Każda wspierana recepta build/test/install musi wywołać preflight. Błędne wywołanie nie może najpierw pobrać zależności, a dopiero potem sprawdzać ścieżek.
- Testy CI wykrywają pominięcie preflightu i powrót starych defaultów. Kontrola zmian CI nie blokuje sama zapisu na lokalnym dysku.
- Twarda granica zapisu wymaga konfiguracji sandboxa/uprawnień poza kontrolą edytowanego repo. Sam wrapper można ominąć surowym poleceniem. Dostęp do Docker daemon również wymaga uwzględnienia w granicy uprawnień.
- Profil uprawnień hosta należy osobno sprawdzić i przetestować. Obecna sesja nie ma storage/worktrees w zadeklarowanych writable roots; nie wolno zastępować odmowy zapisem w przypadkowym miejscu.
- Nie obiecujemy całkowitego zakazu wygenerowanych plików w całym zapisywalnym checkoutcie poprzez samo AGENTS.md. Mocniejsza izolacja wymaga kontrolowanego środowiska builda i mountów.

## Zmiany w skillach

- `using-git-worktrees`: jedna lokalizacja, reuse, rejestr właściciela, jawna baza, bez automatycznego bootstrapu.
- `finishing-a-development-branch`: obowiązkowy stan końcowy zasobów, klasyfikacja do sprzątania, zachowanie WIP i zasad autoryzacji.
- `executing-plans` oraz `verification-before-completion`: checkpoint obejmuje pozostawione zasoby; ukończony kod i posprzątane zasoby raportowane osobno.
- Skille backendowe: link do wspólnego kontraktu storage, bez kolejnych własnych ścieżek i wyjątków.
- Nie dodajemy nowego skilla powtarzającego reguły wszystkich powyższych.

## Kolejność wdrożenia i dowody odbioru

1. Uzgodnić tę politykę ze starszym planem; zaktualizować AGENTS.md, backend.md i wymienione skille w jednym spójnym zakresie. Sprawdzić brak sprzecznych normatywnych defaultów; historyczne raporty oznaczyć jako historyczne, nie przepisywać historii.
2. Rozszerzyć istniejące mechanizmy storage o wspólny resolver i preflight dla Windows. Podpiąć run/setup/verify, aliasy, just/Make i Compose. Testy: worktree na innej głębokości, niedozwolony env override, junction escape, brak uprawnień i kolizja dwóch buildów. Każda odmowa przed pierwszym zapisem.
3. Sprawdzić rzeczywiste wyjścia Rust, FDM CUDA, frontendu oraz FEM CPU/GPU: polecenie, exit code, manifest i różnica inventory przed/po. Każdy nieuruchomiony tor oznaczyć NOT VERIFIED. Nie wystarczy test wyszukujący tekst w skrypcie.
4. Dodać rejestr i czytelny raport: ścieżka, właściciel, stan, rozmiar, ostatnia aktywność, powód zachowania, kandydat do sprzątania. Po zabiciu procesu stan ma być odzyskiwalny; sam wygasły lease nie upoważnia do kasowania.
5. Dopiero po zatrzymaniu przyrostu bałaganu wykonać pełny inventory legacy: worktree, unikalne commity/WIP, katalogi build/cache, procesy i kontenery. Nie skanować automatycznie cudzych danych całego C: ani nie przenosić aktywnych buildów.
6. Przygotować listę konkretnych ścieżek do migracji/usunięcia z rozmiarem i dowodami; wykonać zatwierdzony zakres. Zostawić działający poprzedni runtime do czasu walidacji nowego. Retencja wskazuje kandydatów, nie usuwa wyników naukowych ani WIP automatycznie.

Warunek sukcesu: po pracy w dwóch worktree wszystkie nowe kontrolowane artefakty są w zadeklarowanych miejscach; drugi zgodny build używa cache; konflikt zapisu jest blokowany; każde pozostawione worktree ma właściciela i stan; odmowa uprawnień nie tworzy alternatywnego storage.

## Checkpoint wykonania

- Izolacja: `C:\git\fullmag\worktrees\storage-governance-20260909`, branch `codex/storage-governance-20260909`, baza `0bcd09558ac506e4ec334d24e98ce392f23d4473`. Bez fetch i merge; po zatwierdzeniu użytkownika implementację zapisano w czterech logicznych commitach.
- Rejestr właściciela: `storage/index/storage-governance-20260909-f3f7002249d58cd4.json`, zadanie `01a0856f-0209-7461-bbc2-b49b3c08cf4a`, stan active.
- [x] Wspólny resolver, marker, walidacja override/junction, blokada OS, stan procesu i rejestr worktree.
- [x] Bezpieczne, zewnętrzne compatibility links; brak automatycznego przenoszenia istniejących katalogów.
- [x] Ujednolicenie AGENTS, backend instructions i skilli; guide Windows/Linux.
- [x] Integracja wszystkich launcherów Windows i Compose overlay; parser PowerShell, test rzeczywistej odmowy przed zapisem i źródłowe testy launcherów przechodzą. Pełny Docker Desktop runtime pozostaje `NOT VERIFIED`.
- [x] Integracja just/Make i Linux managed storage. `just storage-info`, lista i dry-render zmienionych recept przechodzą; Make nie jest zainstalowany na hoście Windows, a finalny managed Linux runtime pozostaje `NOT VERIFIED`.
- [x] Integracja frontendowych wyjść Next, pnpm, typecheck i test cache oraz kontrola konsumentów. Pełny frontend preflight bezpiecznie odrzuca istniejący realny `.artifacts`, więc migracja tego katalogu i rzeczywisty build pozostają `NOT VERIFIED`.
- [x] Review całości, testy przekrojowe, raport ograniczeń i stan worktree gotowy do review bez commit/merge.
- Testy core po końcowych zmianach: Windows 23 przypadki, 21 PASS i 2 Linux-only SKIP. Wcześniejszy test Ubuntu2: 18 PASS, przed końcowym rozszerzeniem zestawu. Test Linux wykrył nieobsługiwane `git worktree list -z`; poprawiono kompatybilny odczyt starszego Git.
- Managed solver execution i walidacja fizyki: NOT VERIFIED (dotychczas uruchamiano testy infrastruktury, nie obliczenia solverów).
