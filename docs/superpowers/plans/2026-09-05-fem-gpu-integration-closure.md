# Domknięcie odbioru agentów 1–3

Cel: usunąć potwierdzone blokady integracji i przekazać agentom 4+ jednoznaczny, sprawdzony punkt startowy. Nie jest to kwalifikacja produkcyjnej fizyki ani dowód przyspieszenia.

Punkt wejścia: `617031df0ad45b25ece6b0015836c71631c4f2d1`, branch `codex/fem-gpu-tasks1-5-remediation`, istniejący worktree `C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation`.

## Ograniczenia

- Zachować WIP `672bf44188052fe1a0ad1f42cd7188a196162906`, `.freebuff/` oraz niezwiązane zmiany. Bez push, master merge i usuwania worktrees/cache.
- Receipt v1 pozostaje niezmieniony. V2 rozróżnia obserwację stationary od zaakceptowanego kroku; obserwacja nie kwalifikuje wydajności. Nie dopisywać niewykonanych operatorów.
- Opcjonalne refinement nie może dopuścić brakujących wymaganych operatorów, nieznanych bitów, fallbacku ani niedozwolonych transferów.
- Istniejący kontrakt fizyki 0580 odrzuca STT/SOT podczas relaksacji. Nie rozszerzać legalności ani dodawać fikcyjnego dowodu wykonania momentów.
- Testy natywne i Rust przez kanoniczny kontenerowy `just`; GPU/buildy szeregowo. Test produkcyjnego NCG nie zastępuje benchmarku A/B.

## Kroki i weryfikacja

1. Receipt native/Rust: regresje stationary, refinement i negatywnych masek; następnie minimalna poprawka zgodna z zatwierdzonym projektem receipt v2/snapshot v3. Weryfikacja: RED/GREEN, istniejące ABI i finalizacja.
2. NCG A10/A14: test rzeczywistego kroku, cache miss→hit i ponownego użycia zaakceptowanej energii, z dowodem refinement jeżeli scenariusz je wykonuje. Weryfikacja: managed test, rzeczywiste liczniki i stan; brak dowodu jawnie niezaliczony.
   Regresja integracyjna ujawniła dodatkowo błędne wymiary prostokątnych operatorów demag przy P1 magnetyzacji/P2 potencjału. Naprawić metadane wymiarów RHS/recovery z istniejących przestrzeni, zachowując walidację CSR i stopień FE; ponowić ten sam test ABI.
3. PG-BB/STT/SOT: prześledzić istniejące odrzucenie planera i rozszerzyć regresję na wszystkie algorytmy relaksacji. Nie naprawiać zgodnego z kontraktem odrzucenia przez promocję GPU.
4. Zintegrować testy z receptą, przejrzeć diff i uruchomić pełne `just verify-fem-gpu-execution-receipt-contract` oraz testy launchera. Zero dopasowanych testów nie jest sukcesem.
5. Zapisać lokalne commity, końcowy wynik i SHA. Zaktualizować prompty 4–6 i harmonogram: 4/loader równolegle z 5/DG0 na osobnych worktrees, sparse A11 dopiero po agent4/preconditioner. Nie uruchamiać agentów kolejnej fali automatycznie.

## Stan

- Kroki 1–3: w toku; osobna własność plików receipt i testu NCG.
- Kroki 4–5: oczekują na poprawki i pełną weryfikację.

## Dowody w trakcie wykonania

- Launcher: 37/37 PASS po dodaniu do recepty regresji planera i nowych testów Rust.
- Receipt RED: `just verify-fem-gpu-execution-receipt-contract`, native 3/4 PASS; receipt FAIL: `stationary current-state evaluation must accept its non-trial operator subset`. Końcowy kod just 1, kontener 8. Produkcja receipt w tym przebiegu odpowiadała punktowi wejścia; dodano testy regresyjne.
- Kontrakt STT/SOT już odrzucał relaksację w `crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation`. Rozszerzono istniejący test na wszystkie cztery algorytmy; nie zmieniono legalności ani publicznego modelu.
- Recepta Rust: dodano `--lib` do dokładnych filtrów testów jednostkowych runnera, bez zmiany wyboru testów. RED regresji launchera: 1 FAIL/37 PASS; po korekcie 38/38 PASS. Pełny managed run nadal jest osobną bramką.
- Review wymaga obsługi rzeczywistego finalizera: `finalize.rs` wybiera CompletedAccepted także po końcowej obserwacji stationary, gdy wcześniejsze kroki zostały zaakceptowane. Nie wolno uznać za wystarczający wyłącznie test CompletedObservation od stanu początkowego.
- Następny managed run (sesja 58819): native 4/5 PASS; receipt GREEN. Produkcyjny test NCG potwierdził zwykły cache miss→hit, następnie odrzucił konstrukcję fixture demag przed refinement (`strict CUDA NCG fixture creation must succeed`). Just 1 / kontener 8; Rust jeszcze niewykonany. Nie kwalifikuje refinement.
- Niezależny review poprawki receipt nie znalazł blokerów. Review testu NCG wymaga poprawnego sprawdzenia kanonicznego proof Armijo (bez utożsamiania z odejmowaniem endpointowych energii), legalnych tolerancji demag oraz fizycznych liczników po invalidation; poprawki w toku.
- Run 24482 zatrzymał się na błędzie kompilacji nowej asercji (przecinek zamiast `&&`); poprawiono. Nie jest zaliczonym buildem ani testem runtime.
- Run 1672 po korekcie asercji: native 4/5 PASS, zwykły NCG miss→hit PASS; create demag odrzucone z `failed to setup demag recovery sparse apply plan: sparse apply CSR column index exceeds the operator dimensions`. Odczyt `operators.cpp::upload_demag_poisson_operators` potwierdził użycie rows także jako cols dla RHS i recovery. Poprawka metadanych w toku; nie usuwamy kontroli bounds. Zmiana solvera CG na GMRES nie usuwała błędu; fixture ponownie używa CG/NONE.
