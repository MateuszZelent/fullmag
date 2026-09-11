---
name: local-build-runner
description: "Use when submitting, observing, or maintaining Fullmag builds through the local Docker Desktop queue for a specific worktree or commit."
---

# Lokalny build Fullmaga

Przeczytaj `docs/guides/local-container-runner.md` i właściwe recepty `justfile`.
Ustal checkout, HEAD, dirty state i rejestr worktree; storage rozwiąż przez
`scripts/fullmag_storage.py`, bez własnej kopii `.env` i bez stałych ścieżek hosta.

- Jeden `Fullmag_build_runner` obsługuje wszystkie worktree. Nie uruchamiaj
  drugiego koordynatora ani hostowego wykonawcy SQLite po jego skonfigurowaniu.
- Dla bieżących zmian wybierz `runner-build snapshot`; dla dokładnego commita
  `runner-build commit <profile> <full-sha>`. Nie utożsamiaj nazwy brancha
  z niezmienną wersją źródeł. Nieśledzone wejścia wymagają jawnego
  `--include-untracked`; wstrzymaj edycje na czas capture, również u subagentów.
- Zapisz job ID i source digest. Obserwuj status/logs/wait przez API;
  timeout obserwatora nie oznacza anulowania. Nie zwalniaj lease na podstawie wieku.
- Obraz, mounty i komendy ustala operatorowy katalog, nie payload zadania.
  Worker nie otrzymuje socketu Dockera, tokenu API ani checkoutu hosta.
- Pauza kończy przyjmowanie zadań i pozwala dokończyć aktywny build;
  wznowienie jest jawne. Aktualizacja obrazu wymaga pustego aktywnego slotu.
- `runner-retention-plan` jest tylko odczytem. Nie wykonuj globalnego prune
  ani kasowania cache/artefaktów. Zablokowane usuwanie wymaga decyzji operatora,
  nie alternatywnego polecenia obchodzącego kontrolę.

Sukces buildu wymaga terminalnego `succeeded`, exit 0 oraz zweryfikowanego
receipt i hashy wymaganych artefaktów. Osobno raportuj build, uruchomienie,
fizykę i kwalifikację wydania. Brak dowodu pozostaje `NOT VERIFIED`.
