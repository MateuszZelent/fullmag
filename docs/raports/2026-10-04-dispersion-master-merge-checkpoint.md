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
