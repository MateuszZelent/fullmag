# Integracja K0 i nonzero-k — konkretna propozycja rozwiązania konfliktów

Stan: użytkownik jawnie zatwierdził konkretną propozycję po review. Zastosowano rozwiązanie siedmiu konfliktów; historyczny merge K0 jest przygotowany do commita i push. Integracja niezacommitowanych pakietów solvera K0 nadal WIP. Automatyczna kontrola odrzuciła wcześniejsze rozwiązanie, a po konkretnej zgodzie dopuściła zapis.

## Tożsamość

- Worktree integracji: `C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- HEAD przed merge: `25d6f3ac6e274df0e3ecd2c095de67eae348834d`, czysty index i katalog przed rozpoczęciem.
- K0: `C:\git\fullmag\worktrees\eigensolve-k0-finalization`, branch `codex/eigensolve-k0-finalization-20260829`, HEAD `072758129e169377df274e4e732f81d87570a243`.
- Wspólna baza: `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`.
- Wątek Eigensolve K0 potwierdził zamrożenie zapisów. Jego 100 dirty/untracked pozycji pozostaje nietkniętych; tylko jedna ma identyczną znormalizowaną treść jak w nonzero-k. To nie jest dowód semantycznej unikalności pozostałych 99.

## Zakres zatwierdzanego kroku

Rozwiązać siedem konfliktów w istniejącym merge, używając dokładnych propozycji z podkatalogu `proposed/`, a następnie wykonać scoped merge commit i push po review staged diffu. Bez wdrożenia runnera, restartu obliczeń i usuwania worktree.

| Plik | Rozwiązanie |
|---|---|
| scripts/local_runner/build_entrypoint.py | Aktualny kontrakt nonzero-k plus poprawka K0: copy2 zastąpione copy dla prywatnej kopii kapsuły. Zachować bytes/mode źródeł, odświeżyć mtime kopii, nie zmieniać kapsuły. |
| scripts/test_local_runner_build_entrypoint.py | Aktualne testy plus test K0 dla starego czasu źródeł i nowszego czasu cache; obejmuje plik główny oraz zagnieżdżony. |
| scripts/local_runner/build_executor.py | Zachować aktualną bardziej rygorystyczną walidację receiptów/source identity/runtime-v2. |
| scripts/local_runner/container_client.py | Zachować aktualny katalog profili oraz runtime-v1/v2 i ochronę konfiguracji przed utratą profili. |
| scripts/run_current_gpu_contracts.sh | Zachować aktualną implementację; różnica komentarza nie zmienia wykonania. |
| scripts/test_local_runner_build_executor.py | Zachować aktualne testy odpowiadające nowszej walidacji. |
| scripts/test_local_runner_container_client.py | Zachować aktualne testy dla aktualnego katalogu, zamiast historycznych oczekiwań odrzucenia runtime-v2. |

Do merge dołącza automatycznie scalona historia raportu K0. Cztery commity K0 dotyczą historii napraw runnera, a nie całego jego obecnego niezacommitowanego solvera. Ten krok nie zamyka integracji 100 lokalnych pozycji K0.

## Dowody i ograniczenia

- Przed rozpoczęciem merge status nonzero-k i staged paths były puste.
- Zachowano wariant conflict/nonzero/k0 wszystkich siedmiu plików wraz z manifestem SHA-256.
- Po normalizacji wyłącznie etykiety `<<<<<<< HEAD` potwierdzono zgodność konfliktów z wynikiem merge-tree: brak dodatkowych zapisów po rozpoczęciu merge.
- `proposed-vs-nonzero.patch` pokazuje zmiany wyłącznie w dwóch plikach; pozostałe pięć zachowuje nowszy kontrakt.
- 72 testy Pythona dla konkretnych proponowanych implementacji: PASS, zero failures/errors. Zależności/fixture naukowe czytane z oryginalnego nonzero-k; nie kompilowano ani nie uruchamiano natywnych testów.
- React Doctor dla ostatniego przyrostu modal envelope: 3 pliki, brak nowych problemów. Nie jest to dowód browser/WebGL.
- Rejestr worktree istnieje; jego aktualizacja jest blokowana przez lease scientific job #188. Nie obchodzono lease; brak nowego buildu i wdrożenia runnera.
- Gamma #188 i kapsuła źródeł pozostają zachowane; żaden wynik naukowy nie jest podnoszony do PASS przez merge.

## Dalsza integracja

1. Rozliczyć własność 100 dirty/untracked pozycji K0 na podstawie checkpointu i historii jego wątku.
2. Porównać wspólny Schur/SLEPc, dispatch, equilibrium identity, raw/canonical Ku, artefakty i walidatory; przenosić spójne poprawki, nie całe stare pliki.
3. Rozstrzygnąć różnice CPU/GPU przykładów K0: exact-layer kontra starsza recepta nie jest porównywalnym peer benchmarkiem.
4. Oddzielić niedokończony terminal receipt/ACL/native Windows od wspólnego solvera; nie deklarować jego wdrożenia.
5. Wymagane osobno runtime-only build z nowego pełnego SHA oraz bramki K0/nonzero-k, konwergencja siatki/airboxu i GPU. K0 3/5/8 nadal ma convergence FAILED; nie obniżać progów.
6. Dopiero po integracji i wymaganych kontrolach: PR/master, lokalna weryfikacja i cleanup dokładnych worktree z potwierdzoną własnością i bez aktywnych zasobów.

## Review zatwierdzonej propozycji

Niezależny review read-only potwierdził brak nowego P1/P2 w proponowanej implementacji. Profile i receipts nonzero-k zachowują nadzbiór K0; dawny runtime-v1 jest przyjmowany przez rozszerzony katalog. Pozostaje nieblokująca uwaga o osobnym regression check dokładnej migracji historycznej listy runtime-v1. 72 kontrole Pythona dotyczą konkretnych zastosowanych plików; nie są dowodem wykonania FEM.

## Rozliczenie pochodzenia zmian K0 przez właściciela wątku

Rozliczenie zmian K0 do integracji jest gotowe. **Nie należy przenosić całego dirty diffu ani zastępować nim plików nonzero-k.** K0 zawiera wartościowe, unikalne poprawki, ale nonzero-k ma już rozszerzenia wspólnego silnika, które taka operacja usunęłaby.

Porównałem bieżący K0 (`HEAD 072758129e169377df274e4e732f81d87570a243` + zmiany robocze) z dokładnym commitem nonzero-k `25d6f3ac6e274df0e3ecd2c095de67eae348834d`, nie z jego zmiennym working tree. Odczytałem historię tego wątku, aktualne hunki i audyt. Kolejka SQLite była pusta. Bez edycji, testów, buildów, commitów i zmian runnera.

### Rozliczenie zmienionych plików

W poniższej tabeli „moje” oznacza hunki odnalezione w zapisanych wywołaniach edycji tego wątku i nadal odpowiadające bieżącemu diffowi — nie wyłączne autorstwo całego pliku.

| Plik | Cel i hunki tego wątku | Weryfikacja i zależności |
|---|---|---|
| `poisson_airbox_schur_matshell.cpp` | 23–26 IX: ograniczone `nev/ncv`, raportowanie `ncv`; liczniki nieudanego EPS; rekonstrukcja częściowych Ritz wyłącznie diagnostycznie; dodatni nearest-target `2×`, window nadal `4×`; lokalne `kPetscSuccess`; poprawienie etykiety GMRES. | Nowy nearest-target przeszedł zachowaną natywną serię 3/5/8 z pełnym `2/2` i residualami. Nie dowodzi pełnego frequency-window. Wymaga zachowania rotated-pencil, deduplikacji i fail-closed odrzucenia niepełnego EPS. |
| `eigen_equilibrium.rs` | 25 IX: publikacja accepted-fields, modal identity i linków V2; przekazanie planu do bindingu. | Część R4. Zależna od handoffu, typów identity, sygnatur i niezależnego walidatora. Nie przenosić samodzielnie. |
| `eigen_equilibrium_contract.rs` | 25 IX: verified constructor, zachowanie accepted/recomputed fields i certyfikatu; source snapshot; preimage’y sygnatur; kontrola source identity i target-plan; schematy V2. | Pierwszy slice miał build CLI bez FEM; późniejszy snapshot miał managed build #162. Pełna kwalifikacja R4 pozostaje otwarta. |
| `eigen_execution.rs` | 24–25 IX: odczyt accepted-fields, verified handoff, przekazanie planu do bindingu; zachowanie `demag_solver_policy` w relaksacji próbki. | Zależny również od orkiestratora CLI i finalizacji relaksacji. Nonzero-k ma dodatkowe routingi Floquet oraz zmienione interfejsy — potrzebny port hunków. |
| `eigen_native_artifacts.rs` | 24 IX: kanoniczny fingerprint V6 publikowanej siatki dla K0; obsługa próbki Kittel przed nadaniem adapter label; korekta nested diagnostics. | Powstało po rzeczywistych odrzuceniach niespójnych artefaktów. Zachować rozdzielenie publikowanej siatki od niezmiennego, zahashowanego handoffu. |
| `eigen_native_window.rs` | 25 IX: dodatkowy argument `plan` przy bindingu continuation artifacts. | Mechaniczna zależność zmiany R4; nie zastępować pliku — nonzero-k ma rozbudowaną obsługę Floquet/window. |
| `eigen_path_manifest.rs` | 24 IX: rozmiar airboxu z rzeczywistej otwartej osi siatki, pominięcie osi okresowych; usunięcie ponownego mnożenia przez faktor. | Istotne dla poprawnej interpretacji Robina. Powiązane z geometrią shared-domain, metrykami sweep i walidatorem. |
| `eigen_sweep.rs` | 24–26 IX: kanonizacja publikowanej topologii i revisions; through-thickness evidence; rzeczywisty open-axis extent; certyfikat finalnej siatki mixed albo exact-layer tet4; wpisy manifestu. | Kontrakty źródłowe exact-layer/mixed przeszły. Aktualna macierz runtime 1/4/8 i coarse/medium/fine przy ×34 nie jest zaliczona. |
| `eigen_tests.rs` | 24–25 IX: regresje open-axis metric, modal/source identity, accepted-fields i continuation provenance; dostosowanie fixture’ów. | Nowe przypadki źródłowe nie były uruchamiane jako testy jednostkowe. Ich obecność nie jest PASS. |
| `fem_eigen.rs` | 25 IX: niezależne przeliczenie digestów accepted/recomputed fields, kształtów, wartości skończonych i maksymalnych różnic; stała polityka tolerancji; wspólny helper walidacji evidence. | Integralny element R4. Zależny od nowych typów i wszystkich wywołań walidacji. |
| Przykład Kittel CPU | 24–26 IX: warstwy; korekta komentarza o przyczynie deficytu; przejście na tetrahedral `exact_layers=True`; usunięcie niezgodnych opcji starszej recepty. | Zachowana seria 3/5/8 poprzedza najnowszą receptę exact-layer. #162 dowodzi builda, nie naukowego działania nowej macierzy. |
| Przykład Kittel GPU | 24 IX: parametr `MAG_LAYERS`, kontrola dodatniej liczby warstw i użycie go w meshingu. | Brak nowego dowodu GPU/parity. Pozostała starsza recepta i inne domyślne wymiary niż CPU. **Obecnie nie jest identycznym peerem CPU.** |
| `verify_fem_eigen_k0_periodic_airbox_convergence.py` | 24–26 IX: wspólna source identity i exact coverage; model finite-Robin; evidence warstw; osie mesh/thickness; osobna charakterystyka 3/5/8 i production anchor ×34; cross-axis binding; receipt V4. | Na zachowanych danych formalny convergence 3/5/8 pozostaje FAILED: 2,750378% częstotliwości i 5,454545% `M_eff`. Późniejsze bramki ×34/macierzy mają sprawdzony kontrakt źródłowy, nie runtime PASS. |
| `verify_fem_frequency_domain_eigen_artifacts.py` | 24–26 IX: tolerowanie prawdziwie FAILED punktu pośredniego bez jego promocji; replay digestów, pól, różnic, handoffu i preimage’ów; closed schemas; accepted-fields binding; wybór właściwego handoffu przy continuation. | Niezależny walidator R4/K0. Musi zostać połączony z nowszymi walidatorami nonzero-k, nie je zastąpić. |

### Co jest duplikatem, a co trzeba zachować

W bieżących **niezatwierdzonych przyrostach K0** nie znalazłem dużych, identycznych bloków już obecnych we wskazanym commicie nonzero-k. Trafienia były pojedynczymi wspólnymi liniami. Duplikacja dotyczy przede wszystkim rozwijania tych samych granic silnika, nie gotowych identycznych patchy.

Bez zmian roboczych względem K0 HEAD są pozostałe `eigen_*.rs`, niewymienione w tabeli. Nie są jednak automatycznie zgodne z nonzero-k. Spośród porównanych plików tylko `eigen_anisotropy.rs`, `eigen_digest.rs` i `eigen_operator.rs` były identyczne po pominięciu końców linii. Pozostałe trzeba zachować według funkcji, a nie kopiować zbiorczo.

Unikalne przyrosty K0 to przede wszystkim:

- kontrakt dodatniego nearest-target `2×` oraz bounded Krylov;
- odtwarzalna tożsamość relax→eigen i niezależny replay;
- poprawna metryka otwartej osi airboxu;
- final-mesh layer evidence i osobne bramki Robin/production/convergence.

### Konflikty semantyczne przy scalaniu

1. **Preconditioner i cancellation.** Nonzero-k ma cached window preconditioner, dodatkowe sprawdzenia anulowania i obsługę bounded window, których K0 nie ma. Zastąpienie całego `poisson_airbox_schur_matshell.cpp` wersją K0 byłoby regresją.

2. **Wersje certyfikowanych pól.** K0 wymaga `CertifiedFemEquilibriumFields.v1`; nonzero-k ma rozszerzoną obsługę schematów i dobór nazw artefaktów. Trzeba dołożyć replay K0 do wersjonowanego kontraktu nonzero-k.

3. **Artefakty równowagi/linearizacji.** Nonzero-k zawiera walidację equilibrium V8, linearization V7 oraz kanonicznej tożsamości materiałowej. K0 ma dodatkowy modal/source identity V2. Te zabezpieczenia są komplementarne.

4. **Routing Floquet i publikacja modów.** Nonzero-k ma certyfikaty seam/gauge/descriptor, stabilne mode IDs, kontrolę dostępności pól i inne rozszerzenia walidacji. Nie wolno utracić ich podczas portowania R4.

5. **CPU/GPU fixtures.** Przed parity trzeba ujednolicić jawne wejścia fizyczne i siatkowe. Nie wystarczy zachować nazwę i komentarz przykładu.

Wniosek integracyjny: **nonzero-k powinien zachować swoje rozszerzenia wspólnego rdzenia, a K0 dostarczyć wybrane przyrosty jako spójne pakiety: EPS, R4, mesh/Robin i kwalifikacja.** Dowody zachowane dla dawnych snapshotów nie przechodzą automatycznie na wynik integracji. Freeze edycji pozostaje zachowany.
