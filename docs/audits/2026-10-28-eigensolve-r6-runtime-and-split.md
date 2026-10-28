# R6: odłączanie importu, rzeczywisty solver i wspólny widok

**Stan końcowy: techniczna część R6 PASS.** Naprawiono retirement importu,
wykonano pilot i zapisano wynik, sprawdzono 10 operacji paneli podczas solvera
oraz wspólny widok wykres/mod/Inspector. Ręczny odbiór użyteczności pozostaje otwarty.

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
  Wykonanie wyłącznie w GitHub Actions: PASS (40769033539).
- Stan początkowy runtime/R6: NOT VERIFIED; nowe dowody opisano poniżej.

## Checkpoint przebudowy

- Backend zbudowany i uruchomiony w tej samej grupie/container ID. Zarządzana
  iteracja `33d3cc0335eb41ebaf7781cdb524779c`: `succeeded`.
- Backend: `54d70f74a671704ec85006efad3b5d3c7675bcf5`, snapshot
  `a3556b7469a6f02e07c13e88f4d5a6c32d98eb323f6d454c66f9bcd58a992355`.
- Po restarcie sesja API była pusta; archiwum wyników pozostało zachowane.
  Ponownie zaimportowano oryginalny plik signed15 (HTTP 200), aby kwalifikować
  odłączanie importu na rzeczywistej sesji, nie omijać problemu pustym stanem.
- Pierwszy browser split został przerwany przez restart: kontrolki wyłączyły się
  przy braku danych API. Ta próba nie jest PASS.
- UI commit `f2900016cce3aba8ff99b6e356bd67de01feadec`,
  [CI](https://github.com/MateuszZelent/fullmag/actions/runs/40769489237): PASS.
  Zachowanie split przy Show/Animate ma osobną regresję.

## Podział widoku i migracja helpera

- `split-restored/probe.json`: PASS. Równocześnie widoczny wykres 15 punktów
  z referencjami, rzeczywisty mod Γ i inspektor. Animate po wyborze Γ nie
  zamyka split. Brak błędów JS i niedozwolonych mutacji. Screenshot:
  `split-restored/dispersion-mode-inspector.png`.
- Pierwsza aktywacja po zmianie helpera: odmowa `Startup helper changed since
  image preparation: docker_startup_script.py`, przed Solve. Konieczna jest
  aktualizacja obrazu, samo przebudowanie API nie aktualizuje helperów obrazu.
- Stop-only po drain: `275cf285220044d5a738e507646964c5`, succeeded.
- Recreate usług: `0491d6f48ec443b98ea1bbfb078fb4f5`, succeeded.
- Nowy obraz backendu: `sha256:ab3348afd0335f854f23e792224d57e72628931bfd643dc39112e0cfdb58ad28`.
- CI Rust `40769033539`: cały workflow PASS. Nie zmieniano operatorów fizycznych ani tolerancji solvera.

## Rzeczywisty wynik i pierwsza próba paneli

- Aktywacja `4f2a5e4ae24f4f67a4828ec5f5e3303e`: succeeded z ponownie
  zaimportowanego signed15; nie obchodzono bramki pustą sesją.
- Run: `run-live-25f6652a4b1f234e63526f7a175b594bc59c9cbfecac21bbfced791bfb44d45c`.
- Etapy relax/eigenmodes: completed/completed; spectrum.v3 ready i ten sam run ID.
- k=(0, 10e6, 0) rad/m; f=11,211886649715792 GHz;
  eps_q=1,6022730082536981e-13, eps_phi=1,896808100574384e-14,
  full_descriptor_certified=true przy niezmienionym progu 1e-8.
  To dowód wykonania i publikacji tego pilota, nie pełna kwalifikacja fizyki,
  zbieżności ani całego widma. `floquet_geometric_bc_certified` pozostaje false.
- `live-panels/report.json`: 8 operacji Inspectora i float Diagnostics przy
  running przed i po operacji. Ten sam run ID, zero błędów JS i prób mutacji.
- Podczas ostatniego dock Diagnostics stan przeszedł running→completed.
  Observer poprawnie NIE nadał pełnego PASS. Zakończenie sukcesem nie jest
  przerwaniem, ale nie dowodzi całej ostatniej operacji przy aktywnym solverze.
- Zachowano niezmieniony raport niezaliczonej próby oraz osobno terminalny status,
  etapy i opublikowane spectrum w `live-panels/`. Przygotowano powtórkę z
  przeglądarką gotową przed aktywacją; Diagnostics sprawdzane jako pierwsze.
- Observer nadal wymaga running przed i po KAŻDEJ operacji i dodatkowo wymaga
  opublikowanego niepustego widma z dokładnie tego run ID po completed.
  Plik z oczekiwanym ID pozwala przygotować przeglądarkę przed aktywacją;
  nie pozwala przyłączyć się do dowolnego obcego obliczenia.

## R6 — potwierdzenie ciągłości solvera: PASS

Powtórka aktywacji `3de6edf81d7f47359688e671698bb949`, bez nowego buildu i bez
zmiany parametrów fizycznych. Run:
`run-live-bf62fc7d346d46ad1cca97c205d6d59a96eeca8f708d37fefacf09dd5cdb5c01`.

Wszystkie 10 operacji (float/dock Diagnostics oraz float/move/resize/maximize/
restore/hide/show/dock Inspector) mają `running` przed i po operacji oraz
niezmieniony run ID. Brak błędów JS i prób niedozwolonych mutacji. Po operacjach
run przeszedł do completed i opublikował spectrum.v3 z jednym modem tego samego
runu. Observer wymaga publikacji, nie zalicza samego completed.

Dowód: `live-panels-confirmation-attached/report.json`, `spectrum.json` oraz
`panels-during-solve.png`. Strukturalne podsumowanie i hashe są w
[pliku evidence](2026-10-28-eigensolve-r6-runtime-and-split.evidence.json).

Pierwsze przygotowanie browsera powtórki (`live-panels-confirmation/`) trafiło
na 409 podczas zmiany sesji i nie wykonało testu. Obserwator ponownie podłączono
do JUŻ uruchomionego runu, bez kolejnego Solve. Obsługa 409 jest dozwolona tylko
przed rozpoczęciem próby; błędy podczas operacji nadal odrzucają wynik.

Techniczna część R6 jest zweryfikowana. Badanie użyteczności z nową osobą nadal
NOT VERIFIED. SwiftShader potwierdza działanie przeglądarki/WebGL, nie GPU ani
pełną kwalifikację naukową. Nie wykonano nowego 15-punktowego sweepa: wcześniejszy
wykres z analityką jest zachowanym/importowanym wynikiem, a nowy pilot to k=10.

## Zapis archiwum i dodatkowa regresja fixed-k

- Zapisano `de-k10-r6-20261028.fms`, profil solved, 19 485 638 bajtów,
  86 wpisów ZIP. Integralność wszystkich wpisów: PASS. SHA-256:
  `b0f448c42bf1dfacdd089e5a0bac021c9ff530c58e66357466e951bb8e0b462b`.
  Receipt `export-receipt.json` wiąże eksport z runem powtórki.
- Próba `new-k10-split/` ujawniła inny błąd UI: rodzina k-resolved wybierała
  podwidok dyspersji także dla manifestu single-k, który publikuje modal-spectrum.
  Mod 3D był poprawnie związany z buforem; wykres był odrzucony przez kontrolę
  zgodności manifestu. Nie był to błąd solvera ani brak danych widma.
- Poprawka `5c41564bb9eea7d650af83e6b70ae97d10598e23`: podwidok modalny używa
  klasyfikacji fixed_k_modal do wyboru widma. Tylko taki wynik dopuszcza widmo
  w rodzinie k-resolved. k-path nadal wymaga dyspersji; branches oraz kontrola
  zgodności manifestu pozostają bez zmian. Nagłówek ogólny: Modal frequencies.
- Dodano regresję fixed-k kontra k-path/driven/branches. Testy tylko GitHub
  Actions. Frontend widzi poprawkę przez read-only bind źródeł i HMR; backend
  oraz operator solvera pozostają na zapisanym wyżej snapshotcie.
- Hook React Doctor przy commicie nie ukończył lint: oxlint zgłosił
  `Unexpected discriminant 7 for TSTypeName`. Commit powstał, lecz tego
  nie oznaczamy jako zielonego review React Doctor; brak suppressions.

- Ponowny browser `new-k10-split-fixed/probe.json`: PASS. Widoczne widmo
  11,21188665 GHz i rzeczywisty mod k=+10 rad/µm obok Inspectora. Show/Animate
  zachowują `analysis-plots` + `viewport-3d`. WebGL: drawing buffer 349×509,
  contextLost=false, canvas widoczny; zero błędów JS i niedozwolonych mutacji.
  Screenshot `new-k10-split-fixed/dispersion-mode-inspector.png` obejrzany.
  Pojedynczy punkt ma oś indeksu modu i opis „Eigenfrequencies at fixed k”;
  nie jest prezentowany jako pełna krzywa f(k).

- CI fixed-k `40774271082`: 1423 PASS / 1 FAIL. Nowy fixture nie zawierał
  run_id/stage_id/equilibrium_identity, więc parser poprawnie odmówił
  klasyfikacji. Uzupełniono wymagane tożsamości; asercje i bramki bez zmian.
  Kontrola pełnych typów frontendu i architektury w tej próbie: PASS.

## Pozostały zakres

- Badanie użyteczności z nową osobą nie zostało zastąpione automatyzacją.
- Nowy pilot nie stanowi nowego pełnego sweepa ani dowodu zbieżności siatki.
- Metadane naukowe nadal ujawniają brak geometry_identity/niepełną kwalifikację;
  nie uzupełniano ich wartościami wymyślonymi na potrzeby wyglądu UI.
- Ogólny manifest capabilities zawiera deklaracje różnych ścieżek solvera;
  jego spójność z artifact-backed modal result wymaga osobnej kontroli.
  Faktyczne wykonanie tego pilota potwierdzają zapisane artefakty i receipty,
  nie ogólny status capabilities.
- PR pozostaje częścią szerszej integracji; 14 cudzych plików WIP zachowano
  bajt w bajt. Nie scalano ani nie aktualizowano lokalnego mastera, nie
  zatrzymywano innych grup Docker, nie usuwano worktree ani wyników.

## Końcowe CI i dostęp do wyniku

[CI 40774703337](https://github.com/MateuszZelent/fullmag/actions/runs/40774703337),
commit `0bfdee7ee76c3b408a446f0c770fb3da62874aa7`: **PASS — 1424 testy,
58 plików**, pełne typy frontendu, kontrola architektury i przypięty React Doctor.
Poprawka fixture'u nie zmienia kodu aplikacji zweryfikowanego w przeglądarce.
Lokalne ograniczenie React Doctor opisane wyżej zachowano jako historyczny dowód.

UI: <http://localhost:3217/workspace>. Bieżąca sesja to świeży k=+10 rad/µm;
przycisk **Chart + mode** pokazuje widmo i mod obok Inspectora. Pełny wcześniejszy
wykres signed15 z analityką został sprawdzony w `split-restored/` i pozostaje
zachowany w oryginalnym archiwum. Nie podmieniono nim wyniku nowego obliczenia.

Usunięto tylko dwa osobno zatwierdzone stare frontend cache —
[lista i receipt](2026-10-28-eigensolve-storage-candidates.md). Wynik nowego pilota
zachowano jako `.fms`, zawierający także binarne/zespolone pola modu, potencjał
oraz pole demagnetyzacyjne. Nie usuwano żadnych wyników naukowych.
