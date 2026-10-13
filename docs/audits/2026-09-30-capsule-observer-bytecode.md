# #182 — bytecode obserwatora naruszył membership kapsuły

Job 116603d0835d4309b03b7981d23d89f8 został terminalnie blocked przed uruchomieniem builda. Koordynator: CoordinatorError: Capsule tree membership mismatch. Kontroler 31729 uruchamiał skrypt klienta z niezmiennej kapsuły i dopisał bytecode Pythona. Zatrzymano wyłącznie własny proces obserwatora; handle zakończony exit1.

Sprawdzenie UTF-8 wszystkich wpisów manifestu: 0 brakujących, 0 zmienionych; 8 dodatkowych plików .pyc w scripts/__pycache__ i scripts/local_runner/__pycache__. Diagnoza zachowana obok kapsuły w f8513d92772a43508f885c6de3f439e5/capsule-membership-diagnosis.json. Kapsuły ani bytecode nie usunięto, nie zmieniono manifestu i nie osłabiono bramki.

Nowy scripts/run_nonzero_k_validation_controller.py obserwuje przez klienta worktree, a wszystkie procesy Pythona otrzymują -B i PYTHONDONTWRITEBYTECODE=1. Sprawdza job ID, digest i exit0; blocked/interrupted są terminalne. Trasa pilota pozostaje source-pinned do nowej kapsuły, Γ oraz DE/BV L2/t3/t6/t9, zatrzymanie po pierwszym błędzie.

4 lekkie testy Python PASS, w tym wykonany import zależności bez zmiany membership ani bajtów tymczasowego drzewa źródeł. Nowy job wolno zlecić po terminalnej diagnozie #182, z nową kapsułą/request key. To nie wznowienie wskutek timeoutu. Nie kompilowano testów natywnych; science/runtime/integracja i cały S00–S12 nadal otwarte.


## Zweryfikowane ponowienie

#183 / 57615a161f6d4db5bd475a3499b6c5ef: running, runtime-v2. Source digest 0eb811dfd3ce7672348ef882d6718390c038ce1923b6aa44b68ff635239988b7, native snapshot b333c864fd02ee3a72b72098988f864ce21bca082125bbd1d8490767ec803585. Pełne verify_source na nowej kapsule PASS; bytecode count=0. Kontroler 42767 aktywny. Snapshot jawnie zawiera tracking_mass.rs i nowe kontrole tożsamości pól. Nowych częstotliwości jeszcze brak; receipt/runtime/nauka/integracja są otwarte.
