# Plan uporządkowania branchu C-drive recovery

> Dla agentów: wykonuj kroki kolejno i nie usuwaj danych przed zakończeniem kontroli zachowania artefaktów.

**Cel:** zachować wartościowy audyt antenowy, nie przenosić niezweryfikowanych artefaktów na `master`, a następnie bezpiecznie usunąć aktywny branch i worktree `c-drive-recovery`.

**Podejście:** najpierw rozdzielamy dokumentację od snapshotów i plików roboczych. Raport antenowy otrzymuje osobną, czystą ścieżkę weryfikacji względem aktualnego `master`; dopiero po zachowaniu jego kopii oraz potwierdzeniu losu katalogu `target-review-scratch/` usuwamy aktywny worktree. Branch archiwalny pozostaje do czasu zakończenia przeglądu raportu.

**Narzędzia:** Git, repozytoryjny walidator dokumentacji naukowej, bundlowany Python, PowerShell na Windows.

## Ograniczenia

- Aktualny `master` i `origin/master` pozostają bez zmian funkcjonalnych poza jawnym, osobnym commitem dokumentacyjnym.
- Nie merge’ujemy całego `codex/c-drive-recovery-20260824`.
- Nie usuwamy `codex/archive/c-drive-recovery-20260825` przed potwierdzeniem, że raport jest zachowany i zweryfikowany.
- Nie usuwamy ani nie nadpisujemy `target-review-scratch/` bez osobnego potwierdzenia użytkownika.
- Snapshoty `.codex-edit/`, `.superpowers/sdd/`, skrócony `uv.lock` i zmiany cofające reguły `AGENTS.md` nie mogą trafić na `master`.

---

### Zadanie 1: Zarejestrować stan przed porządkowaniem

**Zakres:** wyłącznie odczyt; bez zmian w repozytorium.

- [ ] Potwierdzić SHA `master`, SHA `origin/master` oraz SHA aktywnego i archiwalnego branchu.
- [ ] Potwierdzić, że `codex/c-drive-recovery-20260824` i `codex/archive/c-drive-recovery-20260825` wskazują ten sam commit.
- [ ] Zarejestrować status worktree `C:/Users/admin/Documents/Fullmag`, ze szczególnym uwzględnieniem `target-review-scratch/`.
- [ ] Nie kontynuować usuwania, jeśli aktywny branch lub archive ref nie wskazuje oczekiwanego SHA.

Weryfikacja:

    git rev-parse master origin/master codex/c-drive-recovery-20260824 codex/archive/c-drive-recovery-20260825
    git -C C:/Users/admin/Documents/Fullmag status --short --branch

### Zadanie 2: Wydzielić kandydaturę dokumentacyjną

**Pliki kandydujące:**

- `docs/audits/2026-08-24-microwave-antenna-module-production-audit-and-remediation-plan.md`
- `docs/audits/2026-08-24-microwave-antenna-module-production-audit-and-remediation-plan.source-map.json`

- [ ] Utworzyć osobną gałąź z aktualnego `master`, bez dziedziczenia niezweryfikowanych zmian C-drive.
- [ ] Przenieść wyłącznie dwa pliki raportu i source-map z archive ref.
- [ ] Zaktualizować sekcję proweniencji raportu o SHA aktualnego `master`, zachowując historyczne SHA jako źródła audytu.
- [ ] Uruchomić walidator source-map z repozytoryjnym bundlowanym Pythonem.
- [ ] Uruchomić `git diff --check` wyłącznie dla tego dokumentacyjnego commitu.
- [ ] Jeśli walidacja lub odwołania do symboli nie przejdą na aktualnym `master`, zatrzymać merge raportu i pozostawić go tylko w archive ref.

Weryfikacja:

    & 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py <raport>.source-map.json --repo-root .
    git diff --check HEAD^..HEAD

### Zadanie 3: Rozstrzygnąć los artefaktu `target-review-scratch/`

- [ ] Sprawdzić rozmiar, liczbę plików i typy zawartości katalogu.
- [ ] Jeśli zawiera wyłącznie artefakty testowe/buildowe, uzyskać potwierdzenie ich usunięcia albo przenieść je do zatwierdzonej lokalizacji na `D:/git/fullmag/...`.
- [ ] Jeśli zawiera źródła lub dowody audytowe, zachować je poza usuwanym worktree i zapisać lokalizację w podsumowaniu.
- [ ] Nie używać `git worktree remove --force`, dopóki ten krok nie ma jawnego wyniku.

### Zadanie 4: Usunąć tylko aktywny worktree i branch

Warunek wejścia: Zadania 1–3 zakończone, raport zachowany albo świadomie odrzucony, a `target-review-scratch/` zabezpieczony albo jawnie przeznaczony do usunięcia.

- [ ] Usunąć worktree `C:/Users/admin/Documents/Fullmag` bez naruszania `D:/git/fullmag` ani archive ref.
- [ ] Usunąć lokalny branch `codex/c-drive-recovery-20260824`.
- [ ] Pozostawić `codex/archive/c-drive-recovery-20260825` do czasu zakończenia osobnego przeglądu raportu antenowego.
- [ ] Sprawdzić `git worktree list --porcelain`, `git branch --list` oraz czystość `master`.

Weryfikacja końcowa:

    git worktree list --porcelain
    git status --short --branch
    git rev-parse master origin/master

### Kryterium zakończenia

Porządkowanie jest zakończone dopiero wtedy, gdy aktywny C-drive worktree i branch zostały usunięte, archive ref nadal wskazuje zachowany commit, `target-review-scratch/` ma jawnie rozstrzygnięty los, a `master` pozostaje czysty i równy `origin/master`.
