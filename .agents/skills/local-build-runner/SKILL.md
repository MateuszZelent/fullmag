---
name: local-build-runner
description: "Use for full Fullmag builds on a host enrolled with Fullmag_build_runner, including master, branches, worktrees, submission, status, and runner maintenance."
---

# Lokalny build Fullmaga

Przeczytaj `docs/guides/local-container-runner.md` i właściwe recepty `justfile`.
Ustal checkout, HEAD, dirty state i rejestr worktree; storage rozwiąż przez
`scripts/fullmag_storage.py`, bez własnej kopii `.env` i bez stałych ścieżek hosta.

- Jeden `Fullmag_build_runner` obsługuje `master` i wszystkie worktree. Nie uruchamiaj
  drugiego koordynatora ani hostowego wykonawcy SQLite po jego skonfigurowaniu.
- Przed zgłoszeniem sprawdź konfigurację profilu i `runner-container-status`:
  Docker `running` nie wystarcza; sprawdź `health.accepting_jobs` i błąd wykonawcy.
  Brak obsługi profilu blokuje build; nie wybieraj CPU zamiast żądanego GPU.
- Gdy checkout źródeł ma klienta, uruchamiaj recepty z tego checkoutu. Jeżeli
  `master` nie ma jeszcze klienta, można użyć zweryfikowanego klienta z worktree
  runnera, wskazując źródła jawnie, np.:

  `python <runner-checkout>/scripts/local_runner_cli.py --worktree <source-checkout> submit --operation build --profile fem-cpu-release --source commit --ref <full-sha>`

  Ustal obie rzeczywiste ścieżki z Git/rejestru, sprawdź właściciela i wersję
  klienta. Nie utrwalaj ścieżki tymczasowego worktree w instrukcjach ani nie
  kopiuj klienta/sekretów do źródeł. Jeśli zatwierdzony klient jest niedostępny,
  zgłoś blokadę. Nie twierdź, że `just runner-build` istnieje na starym `masterze`.
- Dla bieżących zmian wybierz `runner-build snapshot`; dla dokładnego commita
  `runner-build commit <profile> <full-sha>`. Nie utożsamiaj nazwy brancha
  z niezmienną wersją źródeł. Nieśledzone wejścia wymagają jawnego
  `--include-untracked`; wstrzymaj edycje na czas capture, również u subagentów.
- „Build mastera” oznacza SHA uzyskany przez `git rev-parse master`, a nie
  bieżący HEAD przypadkowego checkoutu. Zmiany niezatwierdzone wybieraj wyłącznie
  przez jawny snapshot właściwego checkoutu. Nie przełączaj dirty checkoutu.
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
Lekkie testy i naukowe recepty runtime nie są automatycznie zadaniami katalogu
buildów. Zachowaj ich odrębne bramki i zasady współdzielenia zasobów.
