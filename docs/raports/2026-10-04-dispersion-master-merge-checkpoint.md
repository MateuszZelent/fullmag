# Scalenie implementacji dyspersji z masterem — checkpoint

Data: 2026-10-04. Worktree: `eigensolve-dispersion-plan-20260912`.
Branch: `codex/eigensolve-dispersion-plan-20260912`.

## Zakres

Checkpoint brancha przed integracją: `33647d62ff08f55e6873167056b7d7ebdaa6a00a`.
Pierwszy merge obejmuje master `6d658d58cca4e4885caa1a2dc69cd95889c656df`.
W trakcie rozwiązywania 40 konfliktów remote przesunął się do
`1010f5d94cb13a9aae2e5644992c0fc26c93f33e`; wymagany jest również drugi merge.

Zachowano kontrakty mastera dotyczące tożsamości artefaktów, sesji i request epoch,
publicznego SceneDocument oraz materializacji wyników. Dołączono adaptacyjną politykę
wykonania niezależnych próbek k, provenance i właściwy względny residual brancha.
CSV COMSOL obu stron zawiera te same 1464 rekordy; zachowano oryginalne bajty brancha.

Review ujawniło poprawki konieczne do spójnej integracji:

- Opcjonalny względny residual pozostaje nieznany, gdy solver go nie raportuje;
  nie zastępuje się go wartością bezwzględną.
- Jawne `mode_field_available=false` blokuje publikację referencji pola.
- Adapter frequency-domain czyta payload i digest z jednego ograniczonego snapshotu.
- SceneDocument dopuszcza `parallel_execution`, a istniejący adapter waliduje jego
  pola i ograniczenia backendu; dodano 14 regresji round-trip i odrzucania błędów.
- CPU runtime-v2 wymaga zgodnych aliasów CUDA oraz `FULLMAG_ENABLE_FEM_GPU=OFF`.
- Niekompletność nieznanego dokumentu sesji pozostaje blokująca również obok
  dwóch znanych, nieprzezroczystych dokumentów projektu.
- Poprawiono źródłowe mapowanie interakcji po podziale plików FDM na masterze.

## Dowody źródłowe

Przed zapisem merge uzyskano 503 przechodzące testy interpretowane Pythona
oraz 42 subtesty: 228 verifier/dokumentacja, 43 material/replay, 86 wykresy/raporty,
63 SceneDocument, 58 entrypoint i 25 executor. Produkcyjny TypeScript:
985 plików, bez wejść testów jednostkowych, zero błędów. Kontrola API hygiene
i parserowe kontrole edytowanych plików Rust/TypeScript przeszły.
Mapy źródeł 0104 i 0830 przeszły walidację.

Testów jednostkowych Rust, C++ ani React nie kompilowano. Dodane regresje Rust
są przygotowane w kodzie, ale niewykonane. Te dowody nie zastępują managed builda,
eksportu OpenAPI, przeglądarki ani kwalifikacji naukowej. Commit z `[skip ci]`
zapobiega zakazanej kompilacji testów; pominięte CI nie oznacza zaliczonego CI.

## Pozostałe bramki

1. Zapisać i wysłać oba merge; potwierdzić brak konfliktów i zgodność z remote.
2. Zaktualizować zaufany koordynator pustej kolejki, zachowując konfigurację,
   profile i dane; stary koordynator deklaruje FEM_GPU=ON dla CPU runtime-v2.
3. Zbudować pełny SHA przez `fem-cpu-slepc-runtime-v2` bez kompilowania unit tests.
4. Wyeksportować OpenAPI z potwierdzonego artefaktu runnera i zweryfikować generatory.
5. Sprawdzić wymagane review i bramki PR #97 przed integracją do mastera.
6. Zweryfikować lokalną integrację bez naruszenia cudzych zmian głównego checkoutu.

Istniejący specjalizowany manifest FEM nadal ma historyczne aliasy `current`;
sam ten merge nie jest dowodem pełnego cutoveru wszystkich producentów.
15 punktów DE i dwa punkty diagnostyki airboxu pozostają wynikiem częściowym.
Konwergencja, pełne okno Gamma, native grouped/adaptive parity, GUI, COMSOL,
GPU i waveguide pozostają otwarte. Cały plan S00–S12 nie jest zakończony.

## Zamknięcie konfliktów i poprawka capture

Oba merge zapisano i wypchnięto: `9085b6a0242b3cde9737bfd87c854e278c537616`
oraz `cfc3fc3d28f461543048b4bfac8c6a5e36b03878`.
GitHub potwierdził PR #97 jako `MERGEABLE / CLEAN`; brak konfliktów.
Drugi merge obejmuje tylko trzy pliki testowe z mastera; kontrola parserów przeszła.
Pełny staged whitespace check pierwszego merge zgłasza jedynie niezmieniony patch
`docs/validation/external-solver-patches/mumax3-sp4-local.diff` z mastera
(blob `d8e11e7c67748b95dcdc73b3a68e8076ebcdb4b5`).
Hook React Doctor zgłosił 60 ostrzeżeń, wynik 73/100; to nie jest potwierdzenie
browser gate ani pełne zamknięcie diagnostyki frontendu.

Koordynator zaktualizowano przy pustym aktywnym slocie przez graceful stop/replace/resume.
Obraz: `sha256:17792f5bcba0515336bddd0f91073135cff75815bf6bb6b373b7fd170fa304aa`.
Profile, sekret i konfiguracja buildów pozostały bez zmian.
Trusted entrypoint ma hash `b049deb6ca0a74c225de176695442d688e3f57abec89c5b9f01a88943173325e`;
CPU runtime-v2 jawnie deklaruje CUDA OFF, FEM_GPU OFF i brak unit test targets.

Pierwsze zgłoszenie exact-SHA zostało odrzucone przed utworzeniem joba:
`start-screen.tokens.css` błędnie sklasyfikowano jako plik z credential tokens.
Rozszerzono istniejący wyjątek tylko o dwa przejrzane arkusze design tokens:
`apps/control-room/src/design/styles/start-screen.tokens.css` i
`docs/design/start-screen/tokens/start-screen.tokens.css`.
Nie zastosowano wildcardów ani osłabienia reguł dla innych plików z sekretami.
Regresje sprawdzają capture commit/snapshot oraz odrzucanie podobnych ścieżek.
Build wymaga nowego, pełnego SHA poprawki; master merge i kwalifikacja pozostają otwarte.

Weryfikacja poprawki capture: scripts/test_local_runner_source.py — 15 testów OK, exit 0 (60,4 s); bez kompilacji testów jednostkowych.
