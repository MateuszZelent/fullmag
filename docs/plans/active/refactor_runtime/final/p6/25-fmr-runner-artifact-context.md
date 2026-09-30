# P6-A — kontekst tożsamości artefaktów FMR w runnerze

Data: 30.09.2026

Status: **BUILD PASS / SYNTAX CHECK PASS / TESTS NOT RUN / RUNTIME NOT VERIFIED**.

## Zakres

Odtworzono utracony przyrost w bezpieczniejszej postaci. Runner udostępnia
`run_planned_problem_with_artifact_identity`,
`run_planned_problem_with_callback_and_artifact_identity` oraz
`run_planned_problem_with_live_preview_and_artifact_identity`.
Przyjmują jawny `FrequencyDomainArtifactIdentity` poza `ProblemIR`.
Identyfikatory sesji, wykonania, etapu i runtime trafiają do writera FMR,
również przy zakończeniu przez przerwanie sweepu.

Walidacja odbywa się przed uruchomieniem pipeline artefaktów. Nowe wejścia
obsługują wyłącznie plan FEM frequency response z jawnym `dense_reference`.
Pozostałe plany i nieobsługiwana tożsamość writera natywnego powodują odmowę,
bez podmiany solvera. Dotychczasowe wejścia zachowują zachowanie legacy.
Brak osobno przekazanej tożsamości siatki w nowych wejściach jest uzupełniany
kontekstem siatki z zatwierdzonego planu.

Nie zastosowano dopisywania ID do manifestu natywnego po wykonaniu solvera:
taka operacja pozostawiałaby wcześniej opublikowany manifest z błędną
tożsamością. Natywny writer wymaga osobnej migracji przed publikacją.

## Dowody i zasoby

- Parser Rust przez `rustfmt --emit stdout`: **PASS**, oba zmienione pliki;
  kontrola nie kompiluje testów ani nie modyfikuje źródeł.
- `git diff --check` w zakresie przyrostu: **PASS**.
- Dodano testy zakończonego i przerwanego sweepu oraz odmowy dla aliasu
  `current` i nieobsługiwanej ścieżki natywnej. **NOT RUN**, zgodnie
  z aktualnym tymczasowym zakazem kompilacji testów w `AGENTS.md`.
- Hostowy `cargo check` przez resolver został odrzucony przez ochronę
  kolejki; kompilacja tego przyrostu nie jest na tej podstawie potwierdzona.
- Zdrowy koordynator przyjął snapshot z głównego checkoutu na `master`:
  job `bdd65936cfcc45b58a07879dd2e7ae3a`, profil `fem-cpu-release`,
  digest `c85581ae8b5037b5b7e8f254c888333ece5029862c67dbf55a114a6bc7dc1d7f`.
  Capture `e1a6bcdb379849fab3275573a61451cf`.
  Terminalny stan API: **succeeded**, exit code **0**.
  Odczytano `fullmag.local-runner.build-receipt.v1` z dokładnie tym job ID,
  profilem i digestem; etapy `native-build`, `frontend-dependencies` oraz
  `frontend-build` mają exit code **0**. Receipt zawiera **112** wpisów
  artefaktów z rozmiarami i SHA-256. Koordynator przed sukcesem stosuje
  `validate_build_receipt`, obejmujące provenance, wymagane etapy i hashe.
  Diagnostyczny odczyt wersji stable Cargo/rustc w receipt zgłosił problem
  uprawnień rustup; właściwe etapy buildu zakończyły się sukcesem.
- Rejestr zadania: `p6-fmr-runner-identity`, owner `codex`, profil
  `windows-source-check`. Źródła pozostają w głównym checkoutcie na jawne
  wcześniejsze polecenie użytkownika. Nie usuwano storage ani cudzych zmian.

## Pozostałe kroki

Terminalny build i receipt zostały sprawdzone. Dwie zastane linie
`rotated_interfacial_dmi: None` w fixture'ach są zmianami odtworzonymi przez
użytkownika i nie należą do stagingu tego przyrostu.

Migracja callerów API/CLI, native FEM writer, referencje zasobów bez aliasu
`current`, migracja historycznych plików, managed runtime i kwalifikacja
naukowa nadal pozostają otwarte. P6 zachowuje ostatnią opublikowaną ocenę
**52%**; brak wykonanych testów i migracji produkcyjnych callerów nie pozwala
jeszcze zamknąć bramki ani zwiększyć deklarowanego postępu.
