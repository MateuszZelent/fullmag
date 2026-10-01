# Anteny mikrofalowe — stan i przekazanie do dalszej pracy

Data bazowego przekazania: 2026-09-20; aktualizacja: 2026-10-01. Status całości:
**częściowa implementacja, odbiór produkcyjny otwarty**.

## 1. Punkt wznowienia i zakres tego dokumentu

### Najnowszy checkpoint — pełny authoring stage-first, 2026-10-01

Commit `25c05e363700663da6d5b1032b11b1ab838b7007` dodaje test przejścia
od obiektu anteny i `CurrentTransport` przez port, solve, widmo, projekcję,
drive i run do eksportu skryptu oraz ponownego importu. Symboliczne
`stage_id/output_id`, siedem kolekcji IR i kolejność etapów są zachowane;
44 testy Python w grupach stage-workflow, composition-contract i current-transport
przeszły. Przypięte w fixture ID widoku prądu są syntetyczne: to dowód
round-trip authoringu T03, **nie** wykonalnego pola ani kwalifikacji T05/T06.
Nadal brakuje testu rzeczywistej transakcji API → GET → export → loader → IR.

Korekta notatki 0950 i mapy źródeł została osobno zatwierdzona commitem
`af52f1aeae4861e7bd29118f23a5f4bb0fb491e6`; walidator source-map,
32 testy dokumentacji i `git diff --check` przeszły. Przykład fizyczny
end-to-end oraz pełna tabela parametrów T18 pozostają otwarte.

### Wcześniejszy checkpoint — zgodność składowej widma Python–IR, 2026-10-01

Commit `a96054d28ffb7020087cfc80abca13dffc9b1eda` odrzuca w publicznym
`AntennaSpectrumRequest` nazwy `component`, których nie akceptują kanoniczny
IR i obliczenia widma. Test obejmuje poprawną składową osi płaszczyzny `u`
oraz literówkę `amplitude`; 24 testy Python w grupach stage-workflow i
composition-contract przeszły, podobnie `git diff --check`. Jest to bramka
authoringu, nie dowód numerycznej poprawności FFT ani runtime FEM/FDM.

Pozostały niezatwierdzony WIP obejmuje m.in. kontrolę aktualności manifestu
przed wczytaniem pola i atomowe rozwiązywanie referencji T08. Testów
jednostkowych Rust nie kompilowano zgodnie z obowiązującym zakazem.
`just runner-container-status` z poprawnie rozpoznanym
`D:\git\fullmag\storage` zwrócił
`Container configuration is missing`; konfiguracji runnera nie odtwarzano.

### Wcześniejszy checkpoint — algebraiczna para PBC, 2026-09-30

`just verify-fem-antenna-mixed-pbc-cpu` przeszła dla czterech explicit RK
na mieszanej siatce CPU FP64. Węzły magnetyczne pary $(1,2)$ zachowały
identyczne pole i magnetyzację; preprojected basis z różnicą
$1\,\mathrm{A/m}$ w parze została odrzucona przed wykonaniem.
Raport `.fullmag/reports/fem-antenna-mixed-pbc/qualification.json` ma
snapshot `8db6de990e936ce7e221766ba39dfc25f5c97fd99dd75861b987e2bf8c4e101e`.
Po zmianie przeszła również poprzednia recepta bez PBC. Szczegóły i
ograniczenia są w T13; to test algebraicznego wiązania na małej siatce,
bez demag i bez fizycznego benchmarku periodycznego falowodu.

### Wcześniejszy checkpoint — wspólna siatka magnetyk–airbox, 2026-09-30

`just verify-fem-antenna-mixed-cpu` przeszła z kodem 0: cztery integratory
FEM CPU FP64, po 2000 kroków na konforemnej parze tet4 z markerami $1/0$.
Raport `.fullmag/reports/fem-antenna-mixed/qualification.json` ma snapshot
`ae80b1598b99f195e82d31b4ea54735686fccd2e545fe5ea47836316df5f1300`.
Niezależny wzorzec potwierdził pełnodomenowe `H_drive` w magnetyku i
airboxie, nieruchomy węzeł wyłącznie powietrzny, poprawną trajektorię
magnetycznych węzłów i metrykę torque bez wkładu powietrza. Szczegóły
oraz ograniczenia są w T13 planu T00–T18. Pozostają PBC, projekcja
rzeczywiście rozwiązanej anteny, publiczny pipeline i GPU.

### Wcześniejszy checkpoint — frozen spin pod anteną FEM CPU, 2026-09-30

`just verify-fem-antenna-frozen-cpu` przeszła z kodem 0: sześć natywnych
trajektorii CPU FP64, 126 próbek, integratory Heun/RK4/RK23/RK45 przy
stałym kroku oraz RK23/RK45 adaptive. Raport:
`.fullmag/reports/fem-antenna-frozen/qualification.json`, snapshot źródeł
`b3617dc960fc17b57f8b80747c365c8959b2ffa497a4a97b65f120ca98c00eb3`.
Spin zamrożony pozostał dokładnie nieruchomy mimo niezerowego pola anteny;
trzy swobodne spiny i metryka torque zgodziły się z niezależnym wzorcem.
Zakres, tolerancje i ograniczenia zapisano w T13 planu T00–T18.
Najbliższa pozostała luka T13 to węzły niemagnetyczne i ograniczenia PBC
na mieszanej siatce, a następnie publiczny solve/projection → runner → LLG.

### Wcześniejszy checkpoint — kwalifikacja antenowego CPU, 2026-09-22

Ten checkpoint aktualizuje historyczny opis poniżej. Ostatni commit przed
rozszerzeniem obserwabli: `0a631d305b61fd426c9381063268faaac9f117b2`.
Recepta `just verify-fem-antenna-cpu-trajectories` przeszła z kodem 0:
90 przypadków, 1890 próbek magnetyzacji, 1800 punktów kontroli `H_eff`,
`H_drive`, torque i energii. Macierz obejmuje Heun/RK4/RK23/RK45,
pięć przebiegów, zegar absolutny i lokalny etapu oraz adaptive/retry
dla RK23/RK45. Niezależny walidator odrzucił siedem mutacji obserwabli
podstawionych z poprzedniej chwili.

Raport: `.fullmag/reports/fem-antenna-trajectories/qualification.json`,
schemat `fem_antenna_trajectory.v4`, source snapshot
`14355474149aba5b74c56fd75a5e8c8e020cd1fdd65f5998dc8e152af3f5052b`.
Tożsamość źródeł przed/po wykonaniu zgodna. Szczegółowe warunki, progi,
kotwice źródeł i ograniczenia dowodu zawiera T13 w planie T00–T18.

Następna praca: kwalifikacja publicznego solve/projection → runner → LLG
i artefaktów `H_ant`, pipeline z relaksacją, niejednorodnych domen oraz
pełnych oddziaływań. Osobno pozostają GPU/T16 i odbiór całego modułu.
Obecny `H_drive` jest sumą regionalnych pól; fixture z jedną anteną nie
dowodzi separacji per źródło ani wizualizacji w airboxie. Zakaz kompilowania
testów jednostkowych pozostaje w mocy; wykonano odrębną bramkę naukową.

### Historyczny punkt przekazania

- Worktree: `D:/git/fullmag/worktrees/microwave-antenna-latest-20260909`.
- Rewizja worktree przy ostatniej aktualizacji: `780680003b6b21e706dfcbd49959009c10493664`;
  kod anteny: `38febcef2`.
- Przed aktualizacją dokumentacji lokalną zmianą był `justfile`; należy zachować ją i ustalić jej właściciela przed integracją.
- Duże dane, buildy i wyniki: `D:/git/fullmag/storage`, z osobnym podkatalogiem zadania. Ścieżki linuksowe wewnątrz kontenera nie są Windowsowym rootem storage.
- W tej aktualizacji sprawdzono dokumenty, historię Git, obecność wskazanych symboli i recepty oraz wykonano kontenerową kwalifikację bazowego FEM LLG CPU FP64. Pozostałe pozytywne wyniki są historycznymi zapisami z 9–12 września; nowy wynik jest opisany osobno niżej.
- Nie pobierano zdalnego mastera. Aktualność integracji należy ustalić przed kolejną zmianą kodu.

To wewnętrzny dokument wykonawczy. Właścicielem równań, jednostek, założeń i publicznej semantyki pozostaje [notatka 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md). Nie ustanawia się tutaj nowych modeli fizycznych ani API.

### Aktualizacja wykonawcza 2026-09-21

Po audycie natywnego RHS zapisano dwa commity:

- `38febcef2` dodaje do natywnego FEM CPU pełnodomenowy carrier
  `PREPROJECTED_NODAL` dla legacy `mqs_2p5d_az` oraz resolved
  `antenna_zeeman_masks`; geometrię pola wylicza hostowy
  `compute_per_unit_antenna_fields`, skala `current_a` jest stosowana raz,
  a native ocenia tylko waveform na każdym rzeczywistym podetapie RK;
- `eb2559d2a` ujednolica opis capability `H_ant` w planie. Katalog quantity
  reklamuje `H_ant` dla CPU także przy kompletnym legacy źródle (`antenna` i
  `drive`), natomiast GPU nadal pozostaje fail-closed.

Zarządzany `just windows-build backend=fem device=cpu frontend=dev` przeszedł
po zmianie kodu w trybie `fem-cpu` i skompilował `fullmag-runner`, CLI, API oraz
`fullmag-py-core`. To jest dowód kompilacji kontenerowej, nie odbiór
numeryczny: nie uruchamiano testów jednostkowych Rust, pełnej trajektorii LLG,
niezależnego orakla RHS/energii/torque ani kwalifikacji GPU. T13 pozostaje
otwarte.

Po commitach `38febcef2`, `eb2559d2a` i `780680003` build powtórzono na
czystym HEAD `780680003b6b21e706dfcbd49959009c10493664`; zakończył się kodem 0,
`Build mode: fem-cpu` i komunikatem `Windows FEM cpu container build is ready`.
Artefakty runtime pozostały pod `D:/git/fullmag/storage`; nie utworzono
nowych wyników na `C:`.

### Kwalifikacja bazowego FEM LLG CPU FP64 — 2026-09-21

Recepta `just verify-fem-llg-time-domain-qualification` została wykonana
w obrazie managed `fullmag/fem-gpu:local`, z lane `cpu`, i zakończyła się
kodem 0. CMake zbudował target `fem_llg_time_domain_qualification`, executable
wykonał wszystkie przypadki, a `validate_fem_llg_time_domain_qualification.py`
potwierdził artefakt `status: pass`.

Raport lokalny:
`.fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json`.
Jego tożsamość to `device=cpu`, `precision=fp64`, `integrator=rk45`, polityki
`adaptive` i `fixed`, source snapshot
`8bc150aef9007662d1ff29103f9896feb760ceff51b38f3b6d35bb398670fb21`.
Wynik obejmuje trzy wartości `alpha` macrospinu, tryb wymiany, fast-mode z
odrzuconymi próbami adaptive, bilans energii oraz `relax_to_run` z dokładnym
handoffem i replayem stanu.

Obraz zawiera PETSc 3.12.4/SLEPc 3.12.2. Dodano wersjonowane adaptery dla
ST oraz lokalną deklarację eksportowanego
`PetscObjectGetId`; GMRES zachowuje domyślną tolerancję w starszym PETSc.
`MatShellSetVecType`, dostępne od PETSc 3.13, kończy na starszej wersji
stary GPU modalny lane jawnie `PETSC_ERR_SUP`. Dzięki temu wspólny target
buduje się bez udawania kwalifikacji GPU.

Kontrola wariantu bez SLEPc z 2026-09-22 użyła recepty
`just verify-fem-mixed-p1-local-interactions-native-contract` z
`FULLMAG_FEM_WITH_SLEPC=OFF`. W zarządzanym obrazie ponownie zbudowano
`fullmag_fem`, `fem_mixed_p1_contract` i `fem_mesh_contract`, po czym
uruchomiono kontrakty bez błędu widocznego w logu. Kod zakończenia recepty
nie został zachowany przez odczyt narzędzia, więc pełny PASS wykonania
pozostaje niepotwierdzony. Ten
wynik potwierdza guard kompilacyjny adaptera w konfiguracji bez SLEPc; nie
rozszerza zakresu odbioru o modalne GPU ani antenowy RHS.

To jest bazowa bramka czasowego LLG CPU FP64, a nie odbiór modułu antenowego.
T13 pozostaje otwarte dla antenowego RHS/oracla, wszystkich wspieranych RK i
waveformów, snapshotów `H_ant`/energii/torque oraz wykonania GPU.

Kolejność lektury: ten dokument → [plan T00–T18](../../superpowers/plans/2026-09-08-microwave-antenna-refactoring-plan.md) → [audyt F01–F13](../../audits/2026-09-08-microwave-antenna-worktree-audit.md) → [punkt bazowy integracji](integration-baseline.md) → [ADR 0017](../../adr/0017-staged-antenna-field-basis-workflow.md) i notatka 0950.

## 2. Znaczenie statusów i korekta poprzedniego podsumowania

**Implementacja częściowa** oznacza obecny fragment kodu bez pełnej ścieżki odbioru. **Test historyczny zaliczony** oznacza zapisane wykonanie konkretnego testu, nie nowy pomiar. **Niezweryfikowane** oznacza brak wystarczającego dowodu. **Nieobsługiwane** oznacza jawne odrzucenie konkretnego wejścia lub ścieżki.

Liczby 147 nieodhaczonych i 5 odhaczonych pozycji opisują dawną checklistę, nie procent implementacji. Niektóre nieodhaczone zadania zawierają już wykonane części. Nie należy ani zaczynać ich od zera, ani odhaczać całych pakietów na podstawie jednego testu.

Historyczne opisy backendów w source-map 0950 są bardziej zachowawcze i częściowo starsze od dopisków runtime. W szczególności zdanie o braku implementacji konsumenta FDM CPU nie uwzględnia obecnych testów referencyjnych. Nie wynika z tego gotowość publicznego pipeline FDM CPU. Przed publikacją trzeba uzgodnić opisy source-map, notatki, capability matrix i rzeczywiste odrzucenia planera. Docelowe słowo „production” w tabeli architektury 0950 nie jest raportem zaliczenia bramki.

## 3. Co zachować i czego nie implementować ponownie

| Zakres | Stan udokumentowany | Pozostały warunek odbioru |
|---|---|---|
| Integracja T00 i kontrakt portu | Punkt bazowy z 9 września opisuje integrację snapshotu, port v2 i test ABI | Ponowny przegląd względem aktualnego mastera; pełny odbiór terminalowego solve T05/T06 |
| Projekcja T09 | Maska przed lookupem, carrier tet4, P1/BVH, niezależność od skali i deterministyczna wspólna ściana; zapisano 13 testów ładowania/projekcji | Direct RT0, natywny transfer MFEM, pełne stany API, duże i mieszane siatki |
| Widmo T10 | Preflight, konwencje fazy/normalizacji, okna i zapis realizacji; zapisano 18/18 testów | Zweryfikowana równowaga dla transverse, cache analizy, dalsza kwalifikacja próbkowania |
| Budżet T11 | `antenna_direct_oersted_budget.v1`, kontrola par i częściowa agregacja; wersjonowane pasmo waveformów | Agregacja bloków/retries, pamięć, anulowanie, diagnostyka ważności i benchmark |
| Artefakty T12 | Atomowa publikacja widma, kontrola konfliktów; cache-hit bez fikcyjnego solve | Anulowanie batcha, fault injection, równoległe solve i pełny resolver stage/output |
| FEM T13 | Kontenerowy kontrakt solved-antenna → regional-Zeeman, FFI, materializacja bazy oraz CPU carrier dla legacy/maski | Pełne trajektorie LLG, wszystkie wspierane RK, przebiegi i snapshoty |
| API T14 | Typowane zasoby, ETag/304, binarne payloady widma, rozróżnienie missing/unsupported | Generated OpenAPI, aktualność zależności, reconnect i pełny E2E |
| UI T15 | Węzły Explorer, routing Inspectorów, metadane i heatmapa widma | Cały workflow w przeglądarce, stabilność edycji, Object/Airbox i eksport |
| FDM T16 | CPU/reference ma test czasu waveformu, skali prądu i braku domyślnego RF w Relax | Publiczny CLI, rzeczywiste centra komórek, CUDA i osobne dowody GPU |
| Frequency response T17 | Docelowy kontrakt jest opisany; `mode_basis_ref` oraz niekwalifikowane transverse są odrzucane | Rzeczywiste harmoniczne RHS/rozwiązanie, równowaga, faza i analityczny oracle |

Test samego FFT pola anteny nie dowodzi amplitudy wzbudzonych fal spinowych. Widmo źródła i odpowiedź magnetyzacji pozostają osobnymi wynikami; kwalifikację odpowiedzi prowadzi T17 i benchmark T18.

### Macierz kwalifikacji wykonania

| Realizacja | Co wiadomo | Status pełnego workflow |
|---|---|---|
| FEM CPU | Istnieją części solve, projekcji i konsumpcji; native RHS obejmuje teraz preprojected legacy/maski, a `H_ant` ma hostowy preview/artifact | Rozwojowa, bez pełnego odbioru LLG i zbieżności |
| FEM GPU | Wspólne pakowanie nie stanowi dowodu wykonania na GPU | Niezakwalifikowana; nie promować obsługi bez pomiaru urządzenia |
| FDM CPU | Referencyjne testy bazy i waveformu | Publiczny workflow i projekcja na siatkę wymagają domknięcia |
| FDM GPU | Brak udokumentowanej pełnej kwalifikacji antenowej CUDA | Niezakwalifikowana; wymuszony GPU wymaga jawnego odrzucenia do czasu wsparcia |

## 4. Kolejka dalszej pracy i mierzalne wyniki

Numery T pozostają identyfikatorami istniejącego planu. Najpierw zweryfikować zależności już opisane jako wykonane; dopiero potem uzupełniać brakującą część.

| Kolejność | Zadania i właściciel | Wynik potrzebny do zamknięcia |
|---|---|---|
| 1 | T00/T01/T18: integracja i dowody | Zapis HEAD, statusu, bazy mastera i różnic; dostępne kontenerowe recepty; raport każdego uruchomienia z liczbą testów |
| 2 | T02–T08: Python, IR, authoring, native current i artefakty | Porty z podpisanym bilansem, pełna geometria 3D taperu, aktualne signatures, aktywacja etapów i zgodny round-trip; zamknąć pozostałe F01–F06 |
| 3 | T08/T12: CLI i runtime | Publiczny stage-first skrypt startuje bez ręcznie przygotowanych digestów, sam rozwiązuje stage/output, zapisuje wynik i ponownie używa bazy |
| 4 | T09/T11: projekcja i native field | Fizyczny błąd projekcji/kwadratury i zbieżność trzech siatek; diagnostyka ważności; koszty i anulowanie z zachowaniem poprawnego starego artefaktu |
| 5 | T07/T13: FEM CPU LLG | Oba porządki relax/solve/run, wszystkie wspierane explicit RK i przebiegi; macrospin oraz mała próbka, poprawne pola/energia/torque/czas snapshotów |
| 6 | T14/T15: API i Control Room | Utworzenie anteny, solve, pole obiektu i Airbox, przebieg, Relax/Run, odczyt m, export/reload, zmiana waveformu/reuse i geometrii/stale w prawdziwej przeglądarce |
| 7 | T16: FDM CPU → FDM GPU → FEM GPU | Rzeczywiste targety, publiczny skrypt, statyczne pole i trajektoria; double parity i tożsamość urządzenia; brak transferu całej bazy per RHS |
| 8 | T10/T17: widmo i odpowiedź | Zweryfikowane equilibrium, składowa transverse, zespolona faza odpowiedzi i porównanie z małosygnałową trajektorią; jawne granice analizy modalnej |
| 9 | T18: odbiór | CPW wide/constricted, macierz backend/precyzja/integrator, F01–F13 z dowodami, dokumentacja zgodna z kodem i końcowy review |

### Pierwszy konkretny pakiet wykonawczy

Po odtworzeniu środowiska rozpocząć od T08/T12/T13: wykonać najmniejszy publiczny scenariusz jednego portu i jednej próbki, z samodzielnym etapem solve anteny, następującym Relax/Run i zapisanym polem. Przed zmianą kodu sprawdzić istniejące buildery w `packages/fullmag-py/src/fullmag/world.py` oraz orchestration w `crates/fullmag-cli/src/orchestrator.rs`. Nie zakładać, że wszystkie metody proponowane w T03 już istnieją.

Warunek odbioru pakietu: start od pustego katalogu wyników, brak ręcznie wpisanego hasha, brak RF w domyślnym Relax, prawidłowa sinusoida w Run, ponowne użycie bazy po zmianie waveformu oraz odrzucenie stale po zmianie geometrii. Przy braku któregoś ogniwa najpierw utrwalić test błędu na publicznej granicy, potem poprawić właściwego właściciela. Sam test helpera nie zamyka tego pakietu.

## 5. Kryteria zachowania wymagane przez użytkownika

- Osobny solve anteny bez LLG i relaksacji publikuje bazę oraz diagnostykę. Późniejsze etapy rozwiązują jej referencję i aktualność.
- Zmienny prąd korzysta z zapisanej bazy w zakresie modelu Tier 1; waveform jest oceniany w rzeczywistym czasie podetapów integratora. Zmiana częstotliwości odświeża ocenę ważności modelu.
- Użycie pola stałego w Relax jest jawne. Domyślna aktywacja RF dla TimeEvolution nie obejmuje Relax.
- Widok pola konkretnej anteny na obiekcie i w Airbox musi przejść przez kanoniczny katalog quantities i field-store. `b_zeeman_antena_1` pozostaje intencją nazewniczą użytkownika; nie zakładać, że taki identyfikator już istnieje. Uzgodnić wybór portu/źródła oraz prezentację H i B z 0950 i katalogiem, bez osobnego obejścia w UI.
- Każdy węzeł antenowy ma własną tożsamość wyboru i Inspector: przewodnik, port, rozwiązanie, projekcja, drive, widmo. Edycja zachowuje draft, focus i scroll.
- Wykres k opisuje widmo pola źródła z jednostkami i normalizacją. Informacja o wzbudzeniu modów konkretnej próbki wymaga dodatkowej, zweryfikowanej odpowiedzi magnetycznej.

## 6. Mapa źródeł i historycznych dowodów

Poniższe symbole sprawdzono w drzewie roboczym 2026-09-20. Ich obecność nie jest nowym wynikiem runtime.

| Ścieżka | Symbol | Odpowiedzialność / historyczny dowód |
|---|---|---|
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `load_solved_antenna_drive_basis_projected` | Projekcja bazy i maskowanie, T09 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_antenna_source_spectrum_artifact` | Transformata i artefakt widma, T10; zapis 18/18 w planie |
| `crates/fullmag-ir/src/field_drive_validation.rs` | `classify_antenna_waveform_bandwidth` | Znane/nieznane pasmo, T11 |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `solved_antenna_basis_uses_peak_current_stage_clock_and_exact_term_time` | Referencyjny test skali i czasu, T13/T16 |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `solved_antenna_all_time_evolution_is_inactive_during_relaxation` | Referencyjny test nieaktywnego RF w Relax, T13/T16 |
| `justfile` | `verify-fem-solved-antenna-drive-contract` | Recepta kontenerowego testu Zeemana/FFI/materializacji; historyczny PASS opisany w T13 |

## 7. Procedura weryfikacji i zapis dowodów

1. Odczytać `AGENTS.md`, aktywny worktree, `git status --short`, staged paths i pełny HEAD. Nie resetować zmian innych zadań.
2. Sprawdzić `justfile` oraz konfigurację Windows/Docker. Istnieje recepta `verify-fem-solved-antenna-drive-contract`; ogólne `verify-antenna-contracts` jest w planie propozycją i trzeba sprawdzić jego dostępność przed użyciem. Ustawienia storage dobrać do rzeczywistej recepty.
3. Uruchamiać właściwą bramkę kontenerową dla zmienionego zakresu. Hostowe sprawdzenie Rust nie kwalifikuje natywnego FEM. Zero testów albo skipped GPU to brak kwalifikacji.
4. W raporcie zapisać polecenie, exit code, datę, pełny SHA i hash dirty diffu, wersję runtime, liczbę testów, ścieżkę logu i artefaktów, urządzenie/precyzję/integrator oraz zakres porównania i tolerancje.
5. Po UI wykonać rzeczywisty browser smoke: stabilny Inspector, czytelne jednostki, widoczny canvas, nieutracony WebGL i niezerowy drawing buffer. Dla wyników pól uwzględnić Object i Airbox.
6. Przy zmianie dokumentacji naukowej stosować `scientific-documentation-contract`, walidację source-map i testy kontraktu. Publikacja dodatkowo wymaga aktualnych przykładów, strict Sphinx i kontroli HTML.
7. Dopiero po dowodach aktualizować konkretną pozycję planu. Pełny odbiór następuje po zamknięciu wszystkich obowiązujących bramek; opcjonalnie odłożony T17 nadal pozostaje jawnie otwarty w pełnym zakresie projektu.

## 8. Dokumenty wymagające uzgodnienia przed wydaniem

- Plan T00–T18: rozbić częściowo wykonane checkboxy przy pracy nad danym zadaniem, zachowując historię wyników.
- 0950 i jej source-map: uzgodnić rozwój FDM/reference z produkcyjnym statusem konsumpcji, kompletnym Python → IR i wykonanym przykładem stage-first.
- OpenAPI i capability matrix: odzwierciedlić rzeczywiste statusy oraz odrzucenia; nie promować GPU na podstawie wspólnego ABI.
- Raport końcowy: pokazać zweryfikowane zachowanie użytkowe i numeryczne, nie samą liczbę commitów lub testów jednostkowych.

## 9. Weryfikacja tej aktualizacji dokumentacji

Wykonano 2026-09-20, na roboczej zmianie dokumentów względem SHA podanego w sekcji 1:

- `validate_scientific_docs.py` dla source-map planu T00–T18: exit code 0.
- Testy `unittest discover` skryptów `scientific-documentation-contract`: 32 testy, OK.
- Kontrola 13 lokalnych odsyłaczy Markdown w planie i tym przekazaniu: wszystkie cele istnieją.
- `git diff --check -- docs`: exit code 0.

Użyto istniejącego bundlowanego Pythona z opcją `-B`. Zmieniono wyłącznie plan, jego mapę statusów i ten dokument. Nie publikowano stron Sphinx i nie zmieniano terminalnej notatki fizycznej. Powyższe wyniki potwierdzają kontrolę dokumentacji, nie kwalifikację solvera ani gotowość UI.
