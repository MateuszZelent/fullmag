# Projekt utwardzenia kontraktu workflow bootstrap w PR #56

**Status:** zatwierdzony do realizacji

**Data:** 2026-08-23

## Cel

PR #56 ma przywrócić wykonywalny i odporny na regresje kontrakt bootstrap bez
cofania zmian obecnego `master`. Zmiana obejmuje wyłącznie bramki CI, dwa
przypadkowe gitlinki narzędziowe, jedną nieaktualną asercję Python, tryb pliku
skryptu CI oraz asercję kontraktu FEM DMI.

## Rozstrzygnięcia

- Odbudowujemy PR jako czysty delta na aktualnym `master`; nie rebase'ujemy
  historycznej gałęzi zawierającej stare zmiany frontendowe.
- Zachowujemy rootowe `next` i `pnpm-lock.yaml` dokładnie z `master`.
- Usuwamy `.impl-racetrack` i `Codex-Usage`. Oba są gitlinkami dodanymi przez
  niepowiązane commity funkcjonalne i nie należą do produktu ani zestawu
  referencyjnych solverów. Usuwamy również wpis `Codex-Usage` z `.gitmodules`.
- Każdy pozostały gitlink musi mieć dokładnie jeden wpis `.gitmodules` z
  niepustymi `path` i `url`.
- Wersje akcji sprawdzamy na podstawie rzeczywistych pól `uses:`, a nie nazw
  kroków workflow.
- Workflow uruchamia własny kontrakt w jobie `python-contracts`.
- `run_frontend3d_required_gate.sh` odzyskuje tryb wykonywalny `100755`.
- Test serializacji tekstury losowej uwzględnia kanoniczne `preset_version: 2`.
- Test FEM DMI sprawdza faktyczną dwustopniową trasę
  `QuantityId -> NativeFemPreviewObservable -> ffi`.

## Poza zakresem

- zmiany zachowania Control Room związane z optymistycznymi ACK;
- usuwanie rootowego `next`;
- refaktoryzacja runtime FDM/FEM;
- zmiany OpenAPI, ProblemIR lub publicznego Python DSL.

## Kryteria powodzenia

1. kontrakt bootstrap ma negatywne testy dla przestarzałego `uses:`, brakującego
   URL i zduplikowanej ścieżki submodułu;
2. indeks nie zawiera dwóch przypadkowych gitlinków, a metadane pozostałych są
   kompletne;
3. test Python i kontrakt Rust DMI przechodzą;
4. pełne wymagane bramki CI przechodzą na aktualnym `master`;
5. diff PR nie zawiera starych zmian ACK/Inspektora ani cofnięć lockfile.
