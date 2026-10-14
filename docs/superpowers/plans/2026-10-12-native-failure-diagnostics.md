# Diagnostyka pozostalych native CTest failures

Stan dowodow: GHA38233264045, source ad12a2a200e4bab7d41053955e8ad9283bc6a3f2, PETSc3.24.6. Wynik9/12PASS, trzyFAIL. Nie jest to kwalifikacja naukowa.

## Pattern fixture69

Pierwszy guard presence borrowed_pmat_copy nie przechodzi; pozniejsze predykaty counts/cleanup nie zostaly ocenione. Nowy failure-only log poprzedza guard: status, error512, diagnostic length/truncation flag i JSON131072. Guard i max_linear_iterations=1 bez zmian. Potrzebny nowy hosted run; brak pomiaru nie uzasadnia PASS ani zmiany budzetu.

## Mixed dense73

Poprzedni failure JSON byl uciety do2048 znakow. Nowy failure-only komunikat zachowuje do131072 znakow diagnostyki, jawne length/truncation i error512. Certification guard bez zmian. Nie przenosic pomiarow45 na73; pelny last_true_probe pozostaje NOT VERIFIED.

## Full modal45

Pelny last_true_probe wykazuje recursive residual0, default reason3, true residual3.303550706404569e-10 wobec threshold2.4125808521746334e-14. Actual ratio13693.015524958842; true-residual gate poprawnie odrzuca konwergencje. LivePC residual7.542700548525e-8, exact Pmat entries matched i Frobenius defect0. FreshLU NONZERO i NONE oba okolo5.150782251730459e-16. To lokalizuje roznice zachowania live/fresh solve, lecz nie dowodzi jej przyczyny ani perturbacji faktorow.

Nie zmieniono production operators, fizyki, tolerancji, preconditionera ani kryteriow. KSPGMRESSetBreakdownTolerance nie jest HapTol. Nowy CPP compile/runtime i kwalifikacja naukowa pozostaja NOT VERIFIED. Dalsza naprawa musi wynikac z nowych logow i niezaleznej kontroli live factorization lifecycle.


## Nowy dowod pattern i mixed - GHA38237149103

Source01f2112b nadal9/12PASS. Pattern completeJSON8581:statusOK accepted1,4truecriterion pomiary0violations,maxratio0.0019653927028332276. Serializer observer publikuje tylko dla floquet_slepc_solve_failed, mimo cached capture dla innych wynikow. Brak borrowed_pmat_copy przy sukcesie nie dowodzi braku hooka.

Fixture pattern teraz nie stosuje specjalnego FIELD-only override z fault-quarantine cases; zachowuje bazowy historycznyCSR carrier oraz maxlinear1/rtol/target/privatehook i wszystkie mismatch/cleanupguards. To warunek istniejącego hard-nearest testu, a nie pełny model fizyczny. Nowy runtime NOT VERIFIED. Nie zmieniono production solvera ani tolerancji.

Mixed73 kompletneJSON:subwindow1 shift0.6537857698010644Hz, true residual1.8635310157807875e-10/threshold2.4343592418709787e-14, ratio7655.1191941109355, recursive0/defaultreason3/gate0. LivePC relative residual7.838566796905665e-8, fresh NONZERO/NONE1.201422675269101e-16, exactPmat defect0 i cleanup/phi invariants true. Jest to rzeczywisty fail true-residual gate. Sama zgodność wpisów Pmat nie dowodzi zgodności faktorów; numerical rootcause nadal otwarty.


## Korekta wniosków po GHA 38241463969

Próba pozostawienia pattern na historycznym CSR carrier była błędna: bieżący R4 odrzucił descriptor przed EPS. Przywrócono prawidłowy FIELD-only carrier, a przyczynę braku danych usunięto w serializerze. Po udanym opt-in solve neutralne `candidate_operator_observation` publikuje wyłącznie cached pomiar. Failure-only eksport pozostaje bez zmian. Nie wprowadzono dodatkowych PETSc queries ani zmiany fizyki, tolerancji czy acceptance.

Cztery rzeczywiste wywołania C ABI w prywatnym teście obejmują opt-out success bez diagnostyki, opt-in success z pomiarem, successful pattern probe z rozróżnieniem prywatnej struktury 3/4 względem zgodnej rzeczywistej Pmat i successful solve z niedostępnym fresh-LU probe. Kontrole porównują lambda oraz residual przy istniejącej tolerancji, zachowanie phi RHS/solution, cleanup, niezerowy kod błędu unavailable setup i null residuals. Nowy hosted native compile/runtime: pending.

Pełne modal45 i mixed73 pozostają prawdziwymi porażkami true-residual gate. Ta korekta nie rozwiązuje ich przyczyny i nie zamyka kwalifikacji numerycznej lub naukowej.


## Regresja budżetów K0 GPU — GHA 38248502096

Native compilation przeszła; 2/4 CTest fail w nowej fixture admission. Produkcyjny helper sentinel policy działa, lecz test dla strict GPU używał legacy return-by-value C ABI, który prawidłowo zatrzymuje GPU na wymaganiu caller-sized result v20 attestation. Fixture teraz korzysta z istniejącego v20 envelope dla wszystkich trzech targetów i zachowuje dokładny powód odrzucenia negative budgets. Nie osłabiono wymogu attestation, availability ani GPU fallback; dodano failure-only bounded log. Kolejne hosted CTest pending; urządzeniowy GPU solve nadal NOT VERIFIED.


## Potwierdzenie eksportu sukcesu — GHA 38246943509

Artefakty dowodzą kompilacji i 10/12 CTest PASS na6265812be7b146f0f70102f1db79414765329490. Pattern sukcesu, opt-out, unavailable fresh-LU i guardy prywatnego mismatch przeszły. Pozostają wyłącznie fem_modal_eigen_contract oraz fem_modal_eigen_mixed_dense_contract (true-residual failures). Poprzedni wynik9/12 zastąpiono nowym dowodem; nie nazwać całego native suite zielonym. Receipt SHA256e6ca02ed415d1da23c71a51777e71d412e348dca8e21ed5c5da3098079b88a22; logSHA256b9af77228f89f7d33af8ab56b15003334a96885f9b4cc0c58eed399307d0549a.

GHA38288433960 na554d3a49bfbd03b143d373644d92675a18a2661e:4/4dependency-free C ABI CTest PASS, w tym policy admission z v20 dlaGPU. Receipt SHA2565f575404974019060c3dac4da5faa611d4a60d62fddc17a1ea6d279723c63236. To nie jest GPU urządzeniowy solve.


## Następny falsyfikowalny pomiar faktorów — 12.10.2026

Dwa aktualne JSON-y na6265812 potwierdzają Pmat4x4/16entries: exact structure/value match i Frobenius defect0. LivePC relative residual: full45=7.5427005485e-8, mixed73=7.8385667969e-8; freshLU odpowiednio3.2583845792e-16 i2.3115593840e-16. Zadawany `MAT_SHIFT_NONZERO` około1.4901161194e-8 nie dowodzi rzeczywiście zastosowanego przesunięcia.

Hipoteza, nie potwierdzona przyczyna: liveLU uruchamia conditional shift po małym pivocie symbolic/numeric ordering, freshLU na późniejszym duplikacie nie. W pinned PETSc3.24.6 `MatPivotCheck_nz` (`include/petsc/private/matimpl.h`) uruchamia actual shift zależnie od pivotu i row sum. Numeric LU (`src/mat/impls/aij/seq/aijfact.c`, inode.c) ma istniejące PetscInfo z liczbą shift_nz tries i actual shift_amount. Getter konfiguracji nie mierzy tej decyzji.

Następny bounded hosted experiment: potwierdzić logging Mat, znaczniki fazy liveEPSSetUp/freshKSPSetUp, odczyt metadata/ordering i actual shift log. Nie resetować livePC, nie zmieniać faktorów, tolerance ani acceptance. MatDuplicate kopiuje również inode/diagonal/compressed-row metadata; nie zakładać, że fresh wyłącza inode. Brak logu nie oznacza zerowego shift, dopóki logging nie zostanie zweryfikowany. Różnica actual shift/ordering wspiera hipotezę; równość ją falsyfikuje. Wówczas kolejny pomiar to prywatne cztery jednostkowe RHS i rekonstrukcja efektywnego inverse action. Pomiary niezaimplementowane; rootcause/science nadal NOT VERIFIED.


### Wdrożony pierwszy krok pomiaru — runtime pending

Hosted floquet-modal-slepc profil żąda `PETSC_OPTIONS=-info :mat:self` i prywatnych znaczników live_setup/fresh_setup. Istniejące EPSSetUp/KSPSetUp pozostają wywołane dokładnie raz z tymi samymi argumentami/guardami. Znaczniki używają wyłącznie fprintf/fflush, nie PETSc query; end oznacza powrót call, nie poprawność solve. Konfigurację loggingu zapisuje receipt jako requested, nie observed. Następny actual CTest/log potwierdzi dostępność Mat logging oraz shift_nz tries/amount. Brak logu nie może być uznany za zero shift.

Składnię i filtr potwierdzono w pinned [PETSc3.24.6 verboseinfo.c](https://raw.githubusercontent.com/petsc/petsc/v3.24.6/src/sys/info/verboseinfo.c). Mechanizm nie zmienia fizyki ani tolerancji i nie stanowi kwalifikacji. Odczyt dodatkowych matrix metadata/PCView pozostaje dalszym krokiem zależnym od wyniku tego logu.


## Obserwowany actual shift — GHA 38290669920

Na ebda5536f95993d86b76ba29f7bf172c3a248cf2 logging jest aktywne: 8130 MatInfo lines, 1468 phase lines (failure replay duplikuje część logu). Pełna bramka nadal10/12. W live_setup scope full case45 i mixed case74 (poprzednio73) `MatLUFactorNumeric_SeqAIJ_Inode` raportuje1shift_nz try i actualamount1.49012e-08. Bezpośrednio przed nim FactorLU wykrywa1inode obejmujący4wiersze. Jest9shift events w całym logu, żaden we fresh_setup scope; część pozostałych pochodzi z innego testu64.

To wspiera hipotezę różnicy actual factorization, ale nie dowodzi jeszcze zero shift fresh ani przyczyny różnicy metadata/ordering. Potrzebne potwierdzenie numeric fresh logging i właściwej pary faktorów; nie zmieniono acceptance, tolerancji czy PC. Raw receipt/log hashes i bounded phase events zapisano w evidence `floquet-factor-shift-observation-38290669920.json`. Scientific/rootcause nadal NOT VERIFIED.


## G5: kontrolowane odzyskiwanie GMRES — 13.10.2026

GHA38369881646: 12/14 native cases PASS; full/mixed nadal FAIL. First B/C action binding i pomiar verified: live LU residual około 7.5e-8 i 7.8e-8, fresh LU około machine epsilon. Nie zmieniono tolerancji, shiftu ani ordering.

Implementacja dodaje publiczny owner PREONLY/PCSHELL zachowujący STSINVERT i wewnętrzny GMRES/PCLU. Ponowna próba wymaga rzeczywistego residualu, cached rejection tego samego cyklu, BREAKDOWN, postępu i pozostałego wspólnego budżetu iteracji. Finalne b-Ax musi spełnić oryginalny próg. Negative inner reason pozostaje odrębny od certyfikatu ownera.

Profil CI obejmuje 14 dotychczasowych przypadków i 3 nowe regresje: mixed recovery, wyczerpany budżet oraz dokładną granicę progu/zero RHS. Stan: SOURCE IMPLEMENTED, NATIVE VERIFICATION PENDING. Nie kwalifikuje managed sweep, COMSOL A1, browser ani GPU.

G0: GHA38372200187 PASS, sześć regresji receiptów nieudanego wykonania; nie zmienia głównego błędu ani statusu kwalifikacji. C03 zachowuje fail-closed publication bez immutable history.

### Native19/21 — poprawka fixture bez utraty coverage

Poprawiono wyłącznie modal_eigen_contract_test.cpp. Hard nearest oczekuje serialized stop_reason, dodatnich callbacków, zerowych true-probe attempts oraz requested/no-sample/awaiting state i nullowych niedostępnych pomiarów. Zachowuje scalar failure probe, raw spectrum, actual EPS argumenty i scope. Pełne dotychczasowe checks Pmat, obu LU policy setup/solve, wspólnego RHS, residual ratios, normalizacji, stabilności i workspace przeniesiono do dodatniego control przed fresh_solve fault; nie zniknęły z wykonywalnego coverage.

Fresh-solve fault używa zachowanego początkowego compact_observer_request, tak jak istniejący pozytywny pattern fixture, i wymaga osiągniętego injection, unavailable/null measurement, cleanup/unchanged state oraz solvera zgodnego z control. Root review wykryło i wyeliminowało odziedziczenie późniejszego request.residual_tolerance=0.0, bez nowej stałej tolerancji. Selektory/profil21/CMake niezmienione, production solver/admission bez zmian. Source hashD8FA8981CB7556CBC513C2B63F0DDFCE6E5F08CAF2F8DE196C15AE9EC5CEC052. Source diff review i check bez kompilacji; nowa native bramka pending hosted execution.

### Native raw spectrum — potwierdzony brak cached serializacji

Native38465241928:20/21PASS, świeży LUfault i przeniesione dodatnie pomiaryPASS. Jedyna awaria#69 była przy raw spectrum: cached dense oracle jest liczony przed głównym EPSSolve, lecz direct nearest success/failure nie dopisywały istniejącego floquet_dense_oracle_json_field do result_json. Nie potwierdzono z tego braku zerowego widma; wcześniejszy test szukał danych również w niewłaściwym diagnostics JSON.

Poprawka dopisuje istniejący cached serializer do result_json w obu direct paths tylko gdy requested. Bez nowych PETSc/query/solve po quarantine, bez zmian statusów, wyboru modów i tolerancji. Test#69 sprawdza schema/count/entries/truncation i available/null consistency, dopuszczając tylko jawne prawidłowe unavailable. Dodatni control#70 wymaga rzeczywistych finite rotated entries; opt-out nie publikuje private oracle field. Nie znika pozytywne coverage ani no-clipping contract. Root exact-remote diff review; native execution nowego fragmentu pending.

### Native Floquet21/21 i zamknięty drift PoliciesView — 14.10.2026

[Native38471424499](https://github.com/MateuszZelent/fullmag/actions/runs/38471424499), exact46aa800dcddc5ed31903191f92606390930a29b4: SUCCESS. Pobrany receipt expected_test_count21/statuspassed; pełny native-build-and-ctest.log potwierdza21/21PASS,0FAIL,7.15s test execution. Hard nearest69 i fresh-setup-fault70 PASS wraz z pełnym sparse recovery, mixed dense/full residual, gamma admission, process quarantine/concurrency oraz cleanup/backing-byte guards. To zamyka konkretną awarię serializacji cached oracle; nie dowodzi jeszcze DE/BV benchmarku, mixed-cell execution, GPU ani COMSOL A1.

[Retention38473725580](https://github.com/MateuszZelent/fullmag/actions/runs/38473725580), exact15fcd7c9dbae24b1333428e6ce626ad238034683: SUCCESS Windows/Ubuntu. Nowa named PoliciesView follows advertised automatic/runtime retention capabilities PASS, pełna asset inventory/byte parity PASS oraz oba source-preference/packaged fallback testy PASS. [Browser38473721734](https://github.com/MateuszZelent/fullmag/actions/runs/38473721734), exact15fcd7c9: SUCCESS ControlRoom contracts i browser-fixture-smoke, w tym dotąd blokujący końcowy source identity gate. Fixture browser nie jest rzeczywistym solver->UI handoff dla nowego immutable producenta.

Source drift console naprawiony bez cofnięcia automatic/runtime feature i bez ignorowania dirty gate. Raw source/package zgodne z backend capability response. PR97 nadal wymaga rozliczenia pozostałych uwag, bramek naukowych i integracji; nie zamknięto PR ani nie wykonano lokalnych testów.
Receipt38471424499 SHA256 D1B2E5114B29EE1D6D4CC1DBB83D42B6AB992BFA1C0A02BB182C1C8343A18C7D; native-build-and-ctest.log SHA2564744A53078980038AFE8C5D2D01660E8FFEFF8052625D5BAA5A5130915252494. Artifact11852462909, ZIPsha436445bc312d65cd9d644d244a900501615fa4dfb7a541cc7b15b9bcb15864bd. Receipt/log retained read-only; downloaded binaries were not executed.
