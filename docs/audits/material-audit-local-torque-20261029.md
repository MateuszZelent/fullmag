# Lokalne tłumienie w odczycie torque FEM

Baza: `e8ea6720e4aa0d848286d0d52ab6695b86e1acb9`. Zakres: istniejący observable `torque`, bez zmiany integratora i capability.

## Kontrakt i usterka

Katalog opisuje `torque` jako całkowity moment Landaua–Lifshitza podzielony przez `gamma0`, z jednostką T. Zakres tej poprawki stanowi istniejący Tesla-style payload native: dla `B=mu0 H_eff` odczyt jest równy `-(m×B + alpha m×(m×B))/(1+alpha²)`, z lokalnym tłumieniem `alpha` (bezwymiarowym). Zależność od lokalnego tłumienia wynika z [równań LLG](../physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md); ta poprawka nie rozstrzyga dodatkowo nomenklatury normalizacji przez gamma ani nie zmienia jednostki w `QuantityId::Torque`.

Planner i native LLG RHS zachowują `alpha_field`. `copy_torque_observable_f64` w `backends/fem/cpu/mfem/runtime/state_io.cpp` używa jednak wyłącznie skalarnego `material.damping`, więc wynik odczytu może być niespójny z lokalnymi współczynnikami RHS. GPU przechodzi przez tę samą funkcję po pobraniu pola efektywnego; nie stanowi to dowodu wykonanego testu urządzenia.

## Regresja i granice dowodów

Native `fem_state_io_contract` zachowuje kontrolę skalarnego fallbacku i dodaje dwa aktywne węzły z `m=(1,0,0)`, `B=(0,1,0) T`, `alpha_field={0,1}` oraz bazowym `alpha=0.5`. Oczekiwane wyniki to `(0,0,-1)` i `(0,0.5,-0.5) T`; dotychczas oba wyniki były `(0,0.4,-0.8) T`. Dodatkowy nieaktywny węzeł z zerowym `m` ma zerowy wynik. Filtr `--torque-only` uruchamia tę część jako osobny CTest `fem_torque_observable_contract`; pełny dotychczasowy test pozostaje dostępny bez argumentu.

Test wykonywany jest w stałym backendzie grupy `fullmag-worktree-fullmag-46bcd04587391dba`, z bezpośrednich źródeł `/opt/fullmag/source`, jako kontrakt native bez MFEM/CUDA. Taki wynik nie kwalifikuje naukowo integratora ani urządzenia GPU. Build aplikacji i runtime mają osobne receipty. Python → IR, jednostki oraz publiczny format observable pozostają bez zmian.

RED potwierdzony: CTest zakończył się kodem 8 na `alpha=0 torque y component`. Wcześniejsza próba pełnego testu bez MFEM zatrzymała się przed nową regresją na istniejącym kontrakcie wymagającym MFEM (`H_eff seeded and periodic-projected from external field`); nie jest zaliczana jako RED tej poprawki.

GREEN: `fem_torque_observable_contract` i `fem_llg_rhs_contract` przeszły (2/2, kod 0). Logi pozostają w wolumenie grupy: `/build/material-next-fem-torque-red.log` i `/build/material-next-fem-green.log`. Checkpoint FEM: `104c71e5be602bb0afdb4e54e1707ff336689870`. CI jawnie buduje ten sam test executable i uruchamia scoped CTest torque obok istniejących kontraktów ABI.

## FDM CPU: zapis i podgląd torque

Odrębny błąd dotyczy single-grid CPU: `alpha_field` trafia do RHS, lecz cztery ścieżki materializacji torque w runnerze przekazują do wspólnego helpera globalne `problem.material.damping`. Dotyczy to obserwacji, lazy preview, direct snapshot i due outputs. Przy włączonej precesji lokalne `alpha` musi występować także w raportowanym torque. Przy wyłączonej precesji istniejący Tesla-style payload jest niezależny od `alpha`; jego kontrakt pozostaje zachowany. Zob. [algorytmy FDM](../physics/0500-fdm-relaxation-algorithms.md).

RED FDM: dwa testy nie przeszły (due output i lazy preview), dwa przeszły (kontrola scalar/damping-only oraz istniejący test cache). Dla drugiej komórki oczekiwano `2.16661562316537446e-6 T` w składowej y, otrzymano `2.48839022066518288e-6 T`. Log: `/build/material-next-fdm-red-with-regression.log`. Nowe testy weszły również do wcześniejszego startu Cargo, ponieważ plik został dodany przed kompilacją runnera; miarodajny wynik przypięto do logu z jawną nową regresją.

W toku analizy uściślono mapę źródeł: aktualne observe/output/cache materializacje znajdują się w aktywnym `reference.rs`; niepodłączone kopie `reference/direct_snapshot.rs` i `reference/outputs.rs` nie są dowodem dodatkowej wykonywanej ścieżki i pozostają poza poprawką.

GREEN FDM: 96 testów `fdm::cpu::reference::tests` przeszło. Po dodaniu asercji bezpośredniego `observe_state` ponowiono focused filtr `torque_`: 4/4 PASS. Wspólny helper przyjmuje lokalny damping jako callback; aktywny runner CPU wybiera `problem.alpha_at(cell)`. Skalarny wrapper pozostaje dla dotychczasowych pozostałych konsumentów. Gałąź bez precesji nie wywołuje callbacku damping i zachowuje dotychczasowy payload. Logi: `/build/material-next-fdm-green.log` i `/build/material-next-fdm-focused-green.log`. Checkpoint FDM: `7e0c0c3adc91bbd1ae4d1874a90866e5634d1c2e`.

Bootstrap uruchamia nowe testy runnera jawnie w kroku regresji lokalnych współczynników. Kontrola kontraktów `--strict`, składnia skryptu native CI, YAML i lokalne linki raportu przeszły. Zakończony pierwszy build aplikacji dotyczył wcześniejszego spójnego cienia źródeł; managed restart ma objąć końcowy kod. Wymagane są jeszcze wynik tego restartu oraz CI końcowego PR. Testy native są kontraktami implementacji, a nie kwalifikacją naukową urządzenia GPU.

Nie ma tu twierdzenia o błędnym kroku integracji ani o wykonaniu przestrzennego alpha na CUDA — ta kombinacja pozostaje jawnie blokowana przez planner.

## Weryfikacja integracji z masterem

Pierwszy CI wykonał nowe regresje torque poprawnie, ale ujawnił nieaktualną asercję API membership po równoległym PR #346. Master zintegrowano do brancha zadania w `f4185b5c65ead371ee755abdcb371d1e137bc6c2`. Brak jeszcze nieopublikowanej kopii membership jest według tego kontraktu odpowiedzią 200 z danych planu; istniejąca, sprzeczna kopia nadal powoduje 409. Test uzupełniono o identyfikatory warstwy i obiektu, legendę, liczbę komórek, rewizję, fingerprint oraz binarną maskę `[1,2]`.

Pełny lokalny `router_v2` po integracji: **1181 PASS, 3 ignored**, kod 0. Proces testowy użył stosu 16 MiB i usunął wyłącznie dziedziczone `FULLMAG_RUNTIME_SERVICE_CONFIG` oraz `FULLMAG_WORKSPACE_STATE_DIR`, aby fixture korzystał z własnej konfiguracji i tymczasowej bazy. Środowisko grupy pozostało bez zmian. Log: `/build/material-next-api-router-green.log`.

## Odrębna niejednoznaczność do dalszego audytu

FDM przy wyłączonej precesji raportuje istniejący znormalizowany tangent residual `-m×(m×B)`, niezależny od alpha. Katalog nazywa torque ilorazem LL torque i gamma0, natomiast [równanie damping-only](../physics/0580-canonical-relaxation-equilibrium-contract.md) zawiera czynnik `alpha/(1+alpha²)`. Test kontrolny utrwala bieżący payload i nie jest dowodem równości z fizycznym RHS/gamma0 w tym trybie. Normalizacja i znaczenie historycznych wyników wymagają osobnego uzgodnienia kontraktu; zmiana ich skali nie należy do naprawy lokalnego tłumienia przy włączonej precesji.
