# #183 — przedwczesne utworzenie katalogu koordynatora

#183 / 57615a161f6d4db5bd475a3499b6c5ef zakończył się terminalnym blocked przed kompilacją. Koordynator zgłosił Errno 17 File exists dla katalogu joba. Jego build_executor tworzy run_root z exist_ok=False; konfiguracja kontrolera utworzyła wcześniej podkatalog tego rootu. Kapsuła przeszła verify_source i nie zawierała bytecode — naprawa #182 działała, lecz nie obejmowała drugiego konfliktu.

Wprowadzono prepare_controller_config i CLI --prepare-job, które tworzą wyłącznie runs/<worktree-id>/scientific-batches/nonzero-k-validation/<job-id>/controller-config.json. validate_observer_root odrzuca konfigurację w katalogu koordynatora przed obserwacją. Kontrole job ID, worktree ID, SHA i kapsuły poprzedzają mkdir. Katalog koordynatora pozostaje wyłącznie własnością runnera.

6 lekkich testów Python PASS: rzeczywisty import bez bytecode, terminalne blocked, source identity, exit0, przygotowanie bez utworzenia rootu joba i odrzucenie sprzecznej tożsamości/traversal. Poprzedni kontroler 42767 terminalny exit1. Niczego nie usunięto ani nie osłabiono bramki.

Następnie: nowy snapshot runtime-v2, przygotowanie konfiguracji przez kontrolowany CLI, jeden obserwator i seria Γ/DE/BV. Brak nowych częstotliwości; pełny S00–S12, runtime, nauka i integracja pozostają otwarte.
