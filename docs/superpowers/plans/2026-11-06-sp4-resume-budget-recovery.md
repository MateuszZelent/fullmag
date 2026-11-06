# Odzyskanie grupy SP4 po odmowie budżetu podczas resume

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zatrzymać dokładnie uwierzytelnione diagnostyczne API po nieudanym resume i odtworzyć grupę z jej zachowanym budżetem, aby wznowić kwalifikację SP4.

**Architecture:** Rozszerzyć istniejący cold stored-budget recovery o osobny wariant `cold-resume-restore-stored-budget`. Rozdzielić niezmienny parent development od bieżącej inkarnacji opisanej przez failed resume. Ponownie wykorzystać istniejące probe, blokady, zapis intencji, pojedynczy SIGTERM i obsługę nieznanego wyniku; nie tworzyć drugiego kontrolera runtime.

**Tech Stack:** Istniejące helpery Python, Docker Compose, group ledger v4 i zachowane receipty.

**Spec:** Sekcja „Przywrócenie zapisanego budżetu po odmowie cold startu” w `docs/guides/docker-volume-development.md`, obowiązujące granice ownership/drain z AGENTS.md oraz kontrakt poniżej. Odczytowa diagnoza: `sp4-diagnostics/sp4-budget-recovery-admission-20261106.md` w storage grupy; SHA256 `44ec1535801a729f07ddc6f15459a87e7202ee87b454f15c14fb506eda70f816`.

## Stan początkowy i granice

- Baza: master `1ede155757580d3d23fbd6d241eecd80de405185`, PR #406 scalony, wszystkie CI zielone. Bramka FEM CPU/GPU `47807a4019d248ca96a9cea7f64c6d8b` przeszła; nie jest to pełna kwalifikacja SP4.
- Parent development `00666d06ec8d4933839e85d233fd1805`, Compose SHA256 `5ef5d45a32e100cd3ea801163e0788be0098c67582f7042e3ed46297676762b0`.
- Bieżące failed resume `e04b27b18d754fe5ae51cfa5ea6290c5` opisuje inne StartedAt niż parent. Nie wolno zmieniać ani zastępować parent receipt treścią resume.
- Historyczny drain pochodzi z iteracji `cf049cbb508a4191a461c7dcf06f0635`. Drain zakończył się poprawnie; późniejszy rebuild tej iteracji nie przeszedł. Zakończony recreate `8776558ba84d411eba7eaa0bbcb753a7` potwierdza usunięcie dokładnej poprzedniej pary.
- Zachowany budżet Compose: 40 CPU/32 GiB; odmówiony: 8 CPU/64 GiB. Native RAM to odpowiednio 31/63 GiB po odjęciu 1 GiB dla API. Przywrócenie bierze wartości wyłącznie z uwierzytelnionej starej polityki i historycznego Compose.
- Bez zmiany ledger policy, CAS, lease, OWNER, process-tree, sesji, Zarr i skryptów. Bez fresh-state, resetu, nowego Solve, SIGKILL oraz ręcznego Docker stop/update. Nie usuwać aktywnego worktree.
- Dotychczasowe warianty zachowują swoje reguły. Nowy wariant nie udziela uprawnienia do native recovery ani do dowolnej zmiany budżetu.
- Zmiana doprecyzowuje obsługę istniejącego lifecycle i nie zmienia własności runtime ani kontraktu fizyki. Aktualizacja poradnika wystarczy; osobny ADR jest wymagany dopiero, gdy implementacja potrzebowałaby nowej granicy uprawnień.

## Kontrakt dowodu

1. Powiązać pełne, niezmienne development terminal/receipt/Compose i failed resume terminal/receipt/current z tą samą grupą, źródłami, obrazem i config SHA. Resume musi wskazywać dokładny parent i aktualne container ID/StartedAt/cgroup-ready. Uwierzytelnić aktualny failure fence o etapie `runtime_startup` i dokładnym błędzie odmowy polityki.
2. Uwierzytelnić istniejący Drained process-tree, terminal OWNER, dawny Ready pin i `backend-drain.json` jako zakończony etap historycznej iteracji. Sam stan `failed-confirmed` całej iteracji nie wystarcza. Pełny completed recreate oraz jego retained snapshot muszą dowodzić usunięcia obu poprzednich ID i ciągłości state root/namespace. Nie akceptować dowolnego starego drain.
3. Uwierzytelnić ledger v4 i jego snapshot CAS; sprawdzić SHA bajtów i pełną równość zapisanej polityki z historycznym native config. Odtworzyć `CanonicalInventory` dokładnie według Rust w `compute_node_snapshot.rs`, w kolejności serde, bez sortowania kluczy. Odtworzony stary digest musi równać się zachowanemu.
4. Podmienić w tym samym materiale tylko `cpu_quota.capacity_millis` na wartość potwierdzoną przez aktualny cgroup, jego widocznych przodków, Compose i resume cgroup-ready. Ponownie obliczony digest musi równać się odmówionemu. Wymagać pełnego equality requested policy z projekcją starej po podstawieniu dokładnie CPU, RAM i obliczonego digestu. Inne różnice lub nieznany schema/kształt odmawiają operacji.
5. Ponowić istniejące kontrole diagnostycznego API, braku bieżącego native owner, zwolnienia lease/reservation, terminalnych katalogów, pinów runów, certyfikatu, mountów i wszystkich konsumentów. Obserwacje stabilne muszą być identyczne przed i po stopie. Zachować blokady istniejącej recepty.
6. Preview publikuje konkretny plan; apply wymaga jego SHA, ponownie zbiera dowody, zapisuje intencję przed pojedynczym SIGTERM i obserwuje wynik. Wynik nieznany zachowuje intencję i pozwala tylko na istniejącą ścieżkę obserwacji/continuation, bez ponownego sygnału.
7. Nowy wariant journalu jawnie wiąże parent, resume, drain i recreate. Konsument recreate uwierzytelnia cały ten łańcuch również po usunięciu starego kontenera. Nie może wrócić do StartedAt parenta ani do legacy wariantu jako fallbacku. Docelowy runtime nadal musi przejść pełne porównanie ze starą polityką ledgeru.

## Review Focus

- Stary parent i nowy resume: rozjazd inkarnacji ma odmówić stopu, poprawny rebuild ma zachować stare dowody.
- Nieudana iteracja z częściowym/innym drain: wyłącznie zakończony i dokładnie powiązany etap daje uprawnienie.
- Zmiana GPU, CPU topology/affinity, epoch, host ID lub digestu CAS: projekcja quota nie może jej ukryć.
- Nowy konsument, aktywny lease albo zmieniony katalog/run/fence między preview a apply: odmowa bez sygnału.
- Przerwanie po wysłaniu SIGTERM lub po usunięciu kontenera: zachowanie intencji i brak replay; reentry tylko z dokładnymi pinami.

## Wykonanie

### 1. Predykaty i regresje dowodów

**Pliki:** nowe `scripts/docker_volume_resumed_budget_proof.py`, `scripts/docker_volume_resumed_budget_projection.py` oraz odpowiadające im testy; istniejące `docker_volume_cold_budget_restore.py`, `docker_volume_preowner_drained.py`, `docker_volume_drained_successor.py` jako konsumenci/referencje.

- [x] Dodać czyste walidatory parent/resume/inkarnacji, historycznego drain/recreate i projekcji quota. Funkcje przyjmują odczytane dokumenty/bajty oraz jawne oczekiwane piny; nie wykonują Docker ani zapisu. Wyniki zawierają uwierzytelnione digests i budżet do przywrócenia.
- [x] RED/GREEN dla rzeczywistego układu failed parent → failed resume po udanym native teście, failed iteration z udanym drain → completed recreate. Zachować osobne role tych dokumentów.
- [x] Negatywne przypadki: zmienione source/config/ID/StartedAt, niedokończony drain/recreate, obecność starego ID, brak CAS, zmienione bajty, błędna serializacja, niezgodny cgroup, dodatkowa zmiana polityki. Rzeczywiste quota40000 →8000 ma odtworzyć digests `9fa2f09517d6103721a239196addc731c909640ac2c8a46b7ce851353ce0159f` i `8cea2964026e3a66592a8bed345b6dfc68238451ae48f9ab14228344b8372c6d`.

### 2. Podpięcie istniejącego managed stop i recreate

**Pliki:** `scripts/docker_volume_cold_budget_restore.py`, `scripts/docker_volume_stop_preowner_policy.py`, `scripts/docker_dev.py`, odpowiednie konsumujące fragmenty `scripts/docker_volume_dev.py`; ich istniejące testy oraz `docs/guides/docker-volume-development.md`.

- [x] Dodać zamknięty wariant `cold-resume-restore-stored-budget` z wymaganymi pinami resume i historycznego recreate obok istniejącego drain attempt. Nie dopuszczać tych parametrów do starych wariantów.
- [x] W `_collect` zachować oddzielny parent i bieżący startup witness. Użyć nowego dowodu bez produkowania sztucznego development terminala. Ponownie wykorzystać istniejące probe, lock, intent, SIGTERM, journal i continuation.
- [x] Uwierzytelnić wariant w czytniku journalu i w retained/recreate continuation, także po usunięciu dokładnych ID. Związać kod nowych predykatów z identity kontrolera.
- [ ] RED/GREEN dla stale preview, race owner/lease/run/catalog, interrupted signal/publication, zmienionego helpera, niewłaściwego journalu oraz usuniętego kontenera. Stare testy cold restore i pozostałych wariantów muszą pozostać zielone.
- [ ] Uzupełnić poradnik: dokładne preview/apply i continuation, zakres zachowanych danych oraz ograniczenia. Przejrzeć diff, wykonać adekwatne testy interpretowane i zapisać spójny commit.

### 3. Kwalifikacja i powrót do SP4

- [ ] Niezależny review granic uprawnień i utraty danych, CI, PR/merge oraz fast-forward mastera z zachowaniem cudzych zmian. Nie powtarzać niezmienionych zielonych testów wyłącznie po commicie.
- [ ] Świeży preview na dokładnym failed resume; sprawdzić plan, apply jego SHA, potwierdzić zatrzymanie tylko tej inkarnacji oraz zachowanie wszystkich pinów. Żadnego wymuszenia po odmowie.
- [ ] Managed recreate bez fresh-state i bez skryptu, z budżetem40/32 z dowodu. Sprawdzić HostConfig CPU/RAM/swap, zgodność ledgeru, native gate i zdrowe API na aktualnym masterze. Oczekiwany swap64 GiB wymaga odczytu; nie istnieje zmienna `FULLMAG_DEV_BACKEND_SWAP_GIB`.
- [ ] Świeża kwalifikowana archiwizacja jednego zakończonego wpisu historii; wszystkie Zarr i provenance zachowane. Bieżący podgląd odmówił na niepełnym failed-development receipt, więc nie przeniesiono żadnego wpisu.
- [ ] Przejść preflight zapisanego drivera `sp4_run_gpu_validation_probe_20261106.py`, potem jedna próba strict GPU50 fs. Zachować oryginalny Zarr, native i `main.py`, sprawdzić aktualne bramki energii/torque i wykonać kwalifikowaną retencję etapu.
- [ ] Kontynuować pełny profil CUDA i SP4 A/B. Udany recovery lub krótka próba nie zamyka głównego celu porównania czterech solverów z MuMax3 GPU.

### Checkpoint implementacji

Odczytowy pełny `_collect` na rzeczywistym środowisku przeszedł: budżet40/32, zwolnione zasoby,9 terminalnych katalogów, native owner/config/fence/receipty i historyczny recreate uwierzytelnione. Źródła:141 testów przeszło łącznie (124 testy recovery/projection/retained consumers,2 dodatkowe regresje CLI i archiwalnego ownera,15 kontraktu workflow); interpreter podstawowy nie miał PyYAML, test workflow wykonano istniejącym venv projektu. Review oraz managed preview/apply i runtime nadal w toku. Brak sygnału Stop i brak nowego Solve.
