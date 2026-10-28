# R6: odłączanie importu, rzeczywisty solver i wspólny widok

Worktree: `eigensolve-integration-ui-20261026`, branch
`codex/eigensolve-integration-ui-20261026`. Kontynuacja raportu UX z 28.10.2026.

## Kontrakt i kolejność

1. Odłączyć import jako prezentację `imported_read_only`, bez udawania lokalnie
   zakończonego Solve. Wymagane: zamknięcie admission, brak komend w toku,
   poprawny terminalny stan projekcji, gotowy runtime, kanoniczny opublikowany
   import z pasującymi identyfikatorami, brak accepted-reattach oraz brak
   lokalnego katalogu runu i jakiejkolwiek rezerwacji tego runu w ledgerze.
   Dowód braku jest trzymany pod istniejącą blokadą host→store również podczas
   wyczyszczenia wskaźnika. Archiwum importu i referencje wyników pozostają.
   Przed wyczyszczeniem ponownie sprawdzany jest import. Replay nie wykonuje Solve.
2. Zbudować backend w istniejącej grupie Docker po kontrolowanym drain.
   Nie zmieniać innych grup ani usuwać danych. Uruchomić dokładnie jeden pilot
   FEM CPU k=10 przez zarządzaną aktywację skryptu, zachowując receipt.
3. Podczas rzeczywistego `running` sprawdzić float/move/resize/maximize/restore/
   hide/show/dock. Ten sam run ID przed i po operacjach, brak Stop/Cancel/Solve
   z obsługi paneli, zakończenie i zapis wyników są warunkami PASS.
4. Widok wspólny: istniejący layout `Chart + 3D` z regulowaną proporcją oraz
   inspektorem po prawej. Dodać bezpośredni przycisk przy modzie i zachować
   podział przy Show/Animate następnego modu. Nie tworzyć drugiej instancji 3D,
   drugiego solvera ani nowego źródła stanu wyboru. Zweryfikować w przeglądarce.

## Stan początkowy

- UI działa na `http://localhost:3217/session/eigen-mode-ui-de-signed15`.
- Wynik w UI jest importem 15 punktów; nie jest aktywnym obliczeniem.
- Poprzednia aktywacja została odrzucona przed mutacją: `live_retirement_busy`.
- WSL: około 7,9 GiB wolnego przy pierwszym pomiarze; równolegle budują inne grupy.
- 14 wcześniejszych cudzych plików pozostaje poza zakresem zmian.

## Weryfikacja w toku

- 67 testów transportu retirement Pythona: PASS, bez kompilacji testów.
- Nowe regresje Rust: import poprawny, niespójna tożsamość, brak dokumentu,
  obcy namespace, aktywny stan, brak prawa do deklarowania lokalnego katalogu.
  Wykonanie wyłącznie w GitHub Actions: oczekuje.
- Runtime, rzeczywisty solver i R6: NOT VERIFIED do zebrania nowych dowodów.
