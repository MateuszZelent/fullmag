# Antena: preflight buildu po obecnym Solve — 27.10.2026

> Aktualny checkpoint integracji i zakres dowodów: [27.10.2026, PR #247](2026-10-27-antenna-master-pr247-checkpoint.md). Poniższe statusy opisują kolejne historyczne etapy.

Status: przygotowanie, nie wykonany restart lub build. Pełny E0–E12 pozostaje otwarty.

## Tożsamość i warunek wejścia

Worktree: /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011.
HEAD przygotowania: 5ad6613f649fb82acaceffb574758cd98b6beb79 + zachowany WIP.
Grupa: fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
Backend 3680d47bc74a, frontend f7a5aa61bd1d, port 3203.
Zweryfikowany development attempt 0743c2f8394340f0811cb31f3795ce25,
config SHA256 32366b722187be889f86ead5413237ee9018217f71d7c0c3af34780039eb51a1.
Receipt SHA256 50848cc06658fdf75bffab26d5c9b579f16b7d34c400a5a0abffd996f0aac1d7.

Przed jakąkolwiek operacją lifecycle ponownie sprawdzić dokładny worker PID5124,
katalog run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496,
terminalny attempt-cf3de85649da4f35aa3acb1874b8ed79, brak aktywnych konsumentów
i zwolnienie rezerwacji. Sam timeout obserwacji ani status pliku nie wystarcza.
Zachować terminalną diagnostykę, wynik lub dowód braku publikacji oraz piny
producenta PRZED restartem. Nie ponawiać Solve w reakcji na błąd lub timeout.

## Właściwa trasa

Przeczytano justfile i fullmag-docker-build/references/procedure.md.
Właściwa recepta: docker-dev-restart-idle z powyższym attempt/config, wybranym
worktree i portem 3203. Ostatnie true używa istniejącego allow-prepared-session;
nie anuluje/uruchamia Solve ani nie zastępuje terminal-session preflight.
Utrzymać wyłącznie procesowy FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples zgodnie
z wcześniejszą zgodą użytkownika; nie zmieniać wspólnego .env ani mountów.
Launcher zatrzymuje na czas kontroli własny frontend, ponownie sprawdza API,
prywatną sieć i native drain, a następnie ten sam backend buduje i uruchamia API.
Cache i dane użytkownika pozostają. Nie stosować host cargo/cmake/raw compose
ani dawnego runnera. Przy nowej blokadzie zatrzymać dependent krok i odczytać
konkretną przyczynę, bez ręcznego przejęcia ownera lub blokad.

Do kompilacji produkcji oczekują m.in. timestampy StageExecution oraz wąski retry
shared inspection read. Poprzednio zaakceptowane source/native identity i wyniki
pozostają przypięte do ich rzeczywistego producenta; nowy API build nie zmienia
historycznych digestów ani kwalifikacji. Testów jednostkowych nie kompilować.
Po buildzie sprawdzić manifest, receipt, API i rzeczywisty StageExecution bez
nowego Solve; odczyt V/J/H/cold-load zależy od terminalnego wyniku naukowego.

## Miejsce i retencja

Pomiar host D: około 119085813760 B wolne. Widok /build oraz package/control:
369103687680 B dostępne logicznie w Docker VM. /state/runs ma własny filesystem,
około 235750879232 B dostępne. To pomiary w czasie przygotowania; host/VM nie
są niezależnymi gwarantowanymi pulami i należy je ponowić przed alokacją.
Dysk E: nieobecny w Get-Volume. Nie tworzymy nowego backing image, więc nie
jest to powód fallbacku do starej lokalizacji ani zmiany istniejących mountów.

Pakiet /opt/fullmag/package: 5638927840 B logicznie, 56 regularnych plików
z wyłączeniem podążania za symlinkami (Unix ms 1793055710223). Zachować aktualny
pakiet, rollback, aktywny cache i całe dowody. Żadnego prune, usuwania worktree,
kandydatów lub wyników. Nie udowodniono zbędności żadnego z tych zasobów;
ponowna ocena dopiero po ukończonej publikacji i ustaleniu referencji rollback.

Skill fullmag-build-stage-cleanup nie występuje ani w wybranym worktree,
ani w .agents/skills głównego checkoutu. Zastosowano fallback zasad retencji
AGENTS.md, fullmag-build-storage-governance oraz procedury fullmag-docker-build.
Brak skilla odnotowano; nie zastąpiono go automatycznym kasowaniem danych.
Dowód: control volume verification/postsolve-build-preflight-20261027/
package-and-retention-inventory.json. Stan wykonania buildu pozostaje NOT RUN.

## Terminalny warunek wejścia potwierdzony

27.10.2026 ponownie odczytano żywe API: solver=failed, run dokładnie
62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496.
Lease state=released; released_at=2026-10-26T23:10:07.375435998Z; PID5124
nie istnieje. Próba zakończona native wall-time, bez artefaktów. Nadal obowiązuje
pełna kontrola idle/drain w launcherze bezpośrednio przed restartem.
Status buildu w chwili tego zapisu: NOT RUN. Nie uruchamiać nowego Solve.

## Wykonanie i rzeczywisty wynik

Recepta `just docker-dev-restart-idle` zakończona succeeded, operation
cb64d7ff17f144739d78745a9483d16a; config pozostał identyczny. Receipt SHA256
1d71c0f3ed35d599b09cf392f7d31cad56bbba66e148ca837467a9e453808ca0.
Native terminal-session preflight i graceful drain przeszły. Ten sam backend
budował i uruchomił API; nie wykonano host cargo/cmake ani nowego Solve.
Make exit 0, 416862 ms; pakowanie 24 plików 4345 ms, weryfikacja 3623 ms.
Pełna operacja trwała około 683 s. Cache zachowany, package cache hit=false.
Źródła: 5ad6613f649fb82acaceffb574758cd98b6beb79 + WIP, snapshot
af7b536b41562148c06975ac0562ffe42ab3ad25025eda9d7a4b4178ea3c4949.
Manifest/runtime provenance SHA256
99854b11c26a49c99b208cee7ed6a0b65db74c89c232d7a72dc99a56462025ff.
Trzy poprawki produkcji mają identyczne SHA256 w worktree i build shadow
(build-shadow-bindings.json); kompilacja nie obejmowała testów jednostkowych Rust.

API health=ok, frontend healthy. Publiczny GET przypiętego project/run zwraca
200, catalog revision 1529, ten sam task/attempt/epoch, lifecycle failed oraz
artifact_ids=[]. Wynik tej próby nadal nie istnieje. Dowód: build-complete-review.json.

**Otwarty problem obserwacji:** zwykły idle restart nie odtwarza aktywnej sesji
API (health.active_session=false; zasoby current/status i stage execution 404).
Nie potwierdzono więc nowych timestampów przez StageExecution HTTP ani widoku
Failed w rzeczywistym Workspace. Nie przypisujemy sukcesu kompilacji do tych
bramek. Scena jest zachowana w immutable definition CAS
071c43aa620db0c67fbadfa7f35d72d85e8fbe11908a265c32e6db44946cb611;
nie otwarto starszego FMS z inną siatką i nie sfałszowano ramki live.
Istniejący private pre-listen accepted reattach ma własne dowody activation/
reconciliation; nie jest dowolnym HTTP wyborem runu. Następny krok to poprawne
przywrócenie tej zakończonej obserwacji, bez zamiany jej w nowy Solve.

Retencja: obecny pakiet oraz dwa zachowane backupy (2819396439 B i 2819531396 B),
zero kandydatów, retired puste. Nie usuwano backupów, cache, wolumenów ani danych
użytkownika. Brak ogólnego GC/quota pozostaje ograniczeniem.

Podczas kompilacji Windows miał około 0,93 GiB wolnego RAM, dodatkowe wejście
WSL zakończyło się WSAETIMEDOUT. Diagnostyka Windows Docker CLI potwierdziła
pracujący rustc; build następnie się ukończył, WSL znów odpowiada. Brak OOM/
oom_kill w bieżącym cgroup; licznik memory.max wskazywał presję/reclaim.
Nie zwiększano limitów i nie restartowano Docker Desktop ani WSL.

Frontend: ponowiona interpretowana regresja stopki: 7 grup PASS; root Python
unittest formatu dowodów: 14 testów PASS. To testy źródeł/SSR i formatów,
bez kwalifikacji numerycznej, browser/WebGL, nowego HTTP pól lub Solve.
Dowody frontendu: /state/development/verification/antenna-status-20261027/
telemetry-source-recheck.json. Root Python: verification/closed-loop-smoke-
surface-evidence-20261027/root-recheck.json w control volume.
