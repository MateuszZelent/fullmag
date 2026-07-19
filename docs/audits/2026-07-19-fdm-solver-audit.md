# Szczegółowy audyt solvera FDM: fizyka, integratory, Python, ProblemIR i Control Room

| Metadana | Wartość |
|---|---|
| Data audytu | 2026-07-19 |
| Repozytorium | Fullmag |
| Audytowana gałąź i rewizja | `master`, `370f498c280a72b53b74d05f7834e95905511ffc` |
| Zakres | FDM CPU-reference, natywny FDM CUDA FP64/FP32, single-grid i multilayer, oddziaływania, LLG, integratory, relaksacja, Python DSL, ProblemIR, planner, runner, ABI, quantities, API v2, OpenAPI, Control Room, testy i dokumentacja |
| Charakter raportu | audyt statyczny aktualnego kodu i kontraktów uzupełniony świeżymi testami; bez zmian kodu solvera |
| Znaczenie skrótu | prośbę użytkownika o audyt „FMD” zinterpretowano jako audyt metody **FDM** |

---

## 1. Werdykt wykonawczy

Fullmag ma szeroki, rzeczywisty zakres implementacji FDM: referencyjny silnik CPU w Rust, kompilowany backend CUDA, Newell FFT, exchange, Zeeman, anizotropie, DMI, STT/SOT, Oersted, termikę, pięć jawnych integratorów, adaptację RK, trzy algorytmy relaksacji single-grid oraz osobną ścieżkę multilayer. Nie jest to jednak jeszcze solver, który można uczciwie oznaczyć jako całościowo **produkcyjny i zwalidowany**.

Główne rozstrzygnięcia:

1. **Rzeczywista architektura wykonawcza jest rozszczepiona.** `backends/fdm` jest właścicielem produkcyjnej numeryki CUDA, a `crates/fullmag-engine`/`crates/fullmag-runner` zawierają CPU-reference, orkiestrację i binding. W runnerze leżą jednocześnie obszerne drzewa `solvers/`, `solver_runtime/`, `fdm/gpu/cuda/execute.rs` i podzielone `native/*`, które nie należą do aktywnego grafu modułów. Samo istnienie kodu w tych drzewach nie jest dowodem wykonania.
2. **Istnieją blokery poprawności fizycznej klasy P0.** Najważniejsze to podwójne użycie `A` w T0/T1 exchange FP64, brak pola T0/T1 i volume correction w FP32 przy jednocześnie skorygowanej energii, przeciwny znak bulk DMI w CUDA względem energii i CPU-reference, wymiarowo błędny człon SOT dodawany bezpośrednio do `dm/dt`, brak maski aktywności w torque CUDA, niepełna materializacja CPU batch oraz niespójna energia całkowita. Publiczny auto-Newell ABI może ponadto użyć niezainicjalizowanych widm. W ścieżce multilayer występuje dodatkowo błędny czynnik `1/2` dla Zeemana.
3. **Termika nie ma jednego kanonicznego kontraktu.** Python wystawia zarówno `ThermalNoise(temperature, seed)` w `energy`, jak i `Problem.temperature`. Planner odrzuca pierwszy wariant jako semantic-only, a drugi obniża do planu bez publicznego ziarna. CPU batch gubi konfigurację, natomiast native CUDA używa stałego `current_dt=1e-13` zamiast czasu bieżącego kroku i wprowadza dodatkowy czynnik `mu0` względem jednostek gamma z ABI/CPU. Nie ma dowodu kwalifikacji statystycznej.
4. **Python DSL i Rust ProblemIR nie mają pełnego round-trip energii.** Python dopuszcza `UniaxialAnisotropy` i `CubicAnisotropy` jako `EnergyTerm` i emituje ich tagi do `energy_terms`, lecz `EnergyTermIR` w Rust nie posiada takich wariantów. Wykonywalna anizotropia FDM pochodzi obecnie z `MaterialIR`, a nie z tych klas energii.
5. **Planner, runtime selection i capabilities mówią różnymi językami.** Planner publiczny odrzuca `ThermalNoise` i `Magnetoelastic`, podczas gdy profil runtime reklamuje oba jako `supported_terms`. Jawne żądanie CUDA zapisane przez skrypt może przy braku CUDA przejść na CPU, a główne ścieżki wykonawcze wyrzucają przy tym obiekt fallback przed publikacją provenance. Status sesji reklamuje wszystkie cztery algorytmy relaksacji niezależnie od backendu, urządzenia i tego, czy plan jest multilayer; UI może przez to dopuścić wybór, który planner następnie odrzuci.
6. **Integratory istnieją, ale nie są domknięte jako macierz czasu i zdarzeń.** Heun, RK4, RK23, Dormand–Prince 4(5) i ABM3 są obecne. Brakuje pełnej kwalifikacji czasów etapów dla wszystkich źródeł zależnych od czasu, bezpiecznego resetu historii FSAL/ABM po uploadzie i nieciągłościach oraz pełnego dowodu CPU↔CUDA↔FP32↔multilayer.
7. **Multilayer jest wykonywalny tylko w ograniczonym profilu i ma P0 loweringu.** Obsługuje podstawowe oddziaływania i kilka ścieżek stałokrokowych, ale odrzuca PBC, Oerstreda, STT, adaptację oraz relaksację PG-BB/NCG. RegionalFieldDrive nie jest natomiast odrzucany — znika z planu, bo `FdmMultilayerPlanIR` nie ma odpowiedniego pola. Natywny stacked lane i staged lane mają różne zbiory integratorów. Tego nie wolno przedstawiać jako jednego, równoważnego profilu multilayer.
8. **Control Room jest głównie katalogiem i częściowym autorem, a wspólny kontrakt round-trip jest krytycznie rozjechany.** Rust i Python budują dwa różne kształty `SceneDocument` → script-builder overrides, a renderer konsumuje trzeci podzbiór. Python → SceneDocument hardkoduje execution selection jako `auto/auto/double/strict`, SceneDocument → Python ignoruje zmienione backend/device/precision/mode poza CPU threads, a RegionalFieldDrive nie trafia do rewrite overrides. W pełni zapisywalne są podstawowe interakcje study oraz obiektowe iDMI/uniaxial; pozostałe zaawansowane rodziny są jawnie `deferred`.
9. **Testy kontraktowe są szerokie liczbowo, lecz produkcyjna drabina walidacji pozostaje otwarta.** Świeże testy plannera, runnera, Python DSL, wybranych modeli UI, API hygiene, resource/codec/viewport, typecheck i lint przechodzą. Świeżo wygenerowane OpenAPI różni się jednak od checked-in JSON o brakujące `remove_field_drive`, a `just verify-fdm-pbc-production` kończy się błędem z 14 brakującymi artefaktami. Nie uruchomiono CUDA runtime, bo środowisko blokuje dostęp NVML/GPU.
10. **Skrypt µMAG SP4 istnieje, ale nie jest oficjalnym walidatorem.** `tests/stdprob4_dynamics.py` zapisuje trajektorie i stan przy pierwszym próbkowanym przejściu `mx<=0`, lecz nie porównuje pełnych trajektorii z danymi NIST/OOMMF, nie wyznacza interpolowanego pierwszego `mx=0` według jednego kontraktu i nie wykonuje zbieżności siatkowej. Jest workloadem referencyjnym, nie certyfikacją.

### 1.1. Decyzja wydaniowa

| Obszar | Stan bieżący | Decyzja |
|---|---|---|
| FDM CPU-reference | szeroko zaimplementowany i testowany jednostkowo | **orakl rozwojowy; nie produkcyjny backend wysokiej wydajności** |
| FDM CUDA FP64 single-grid | public-reachable przy dostępnym CUDA; brak świeżego runtime proof w tym audycie | **blokada produkcyjna do usunięcia P0 i walidacji fizycznej** |
| FDM CUDA FP32 | zaimplementowany w wielu operatorach | **eksperymentalny/niezakwalifikowany; PBC jest jawnie bramkowane** |
| FDM multilayer | częściowo wykonywalny | **warunkowy; niepełny względem single-grid** |
| Python → ProblemIR → planner | częściowy | **blokada round-trip dla anizotropii i termiki** |
| API v2 / capabilities | `status.capabilities` jest zadeklarowane jako session-gating owner, lecz ma zbyt globalną treść; platform matrix opisuje host | **wymaga jednego plan-scoped źródła legalności, bez duplikacji z host inventory** |
| Control Room | podstawowe authoring działa, rodziny zaawansowane są deferred | **niepełny authoring companion FDM** |
| walidacja produkcyjna | podtesty i kontrakty, brak kompletnej macierzy artefaktów | **otwarta** |

---

## 2. Metoda audytu i język statusów

### 2.1. Śledzony łańcuch

```text
docs/physics i specs
  -> packages/fullmag-py
  -> crates/fullmag-ir
  -> crates/fullmag-plan
  -> crates/fullmag-runner
  -> crates/fullmag-engine (CPU reference)
  -> backends/fdm (native CUDA/ABI)
  -> quantities / artifacts / provenance
  -> OpenAPI i API v2
  -> apps/control-room
```

Audyt obejmował także `CMakeLists.txt`, publiczne nagłówki C ABI, graf modułów Rust, testy natywne i Rust/Python/TypeScript, przykłady, istniejące raporty oraz checklisty dokumentów fizycznych. Historyczne audyty wykorzystano tylko jako mapę hipotez; każde ustalenie przyjęte do tego raportu zostało ponownie sprawdzone w aktualnym drzewie.

### 2.2. Statusy używane w raporcie

| Status | Znaczenie |
|---|---|
| **udokumentowane** | kontrakt opisano, ale nie wynika z tego istnienie kodu |
| **source-visible** | kod istnieje w repozytorium, ale może nie należeć do aktywnego grafu |
| **zintegrowane** | aktywny graf wywołań i publiczny plan potrafią doprowadzić do implementacji |
| **wykonywalne** | istnieje osiągalna ścieżka w obsługiwanej konfiguracji; raport osobno zaznacza, czy uruchomiono ją w tym audycie |
| **przetestowane kontraktowo** | świeży test potwierdza ograniczony kontrakt |
| **zwalidowane fizycznie** | wynik porównano z analitycznym lub zewnętrznym oraklem na zdefiniowanych tolerancjach |
| **produkcyjne** | przeszło pełną drabinę: kontrakt, wykonanie, walidacja fizyczna, parytet, wydajność, provenance i powierzchnie produktu |

### 2.3. Priorytety

| Priorytet | Definicja |
|---|---|
| **P0** | cichy błąd fizyki/wyniku, fałszywa legalność wykonania, utrata kanonicznych danych lub fałszywe provenance; blokuje właściwy lane |
| **P1** | istotna luka kompletności, obserwowalności, cross-backend parity albo kwalifikacji |
| **P2** | dług architektoniczny, testowy lub dokumentacyjny bez wykazanego natychmiastowego błędu wyniku |

### 2.4. Ograniczenia dowodu

- Audyt nie zmienia kodu solvera i nie próbuje naprawiać wykrytych problemów.
- GPU nie było dostępne: `nvidia-smi` zakończył się komunikatem `Failed to initialize NVML: GPU access blocked by the operating system`. Wnioski o CUDA wynikają więc z aktywnego kodu, ABI i testów źródłowych, a nie ze świeżego workloadu na urządzeniu.
- Host nie ma `cmake`; nie wykonywano hostowego substytutu kompilacji natywnej. Repozytoryjny, kontenerowy `just verify-fdm-time-domain-native-contract` pozostaje właściwą bramką.
- Pełny frontend nie był budowany i nie uruchomiono całego `pnpm test` ani browser smoke. Uruchomiono jednak typecheck, lint, API hygiene oraz celowane testy modeli, generated contract, facade, resource hooks, codeców i adaptera viewportu.
- Status „test przechodzi” w tym raporcie odnosi się wyłącznie do komend wymienionych w sekcji 14 i nie jest ekstrapolowany na cały produkt.

---

## 3. Rzeczywista architektura FDM

### 3.1. Właściciele odpowiedzialności

| Warstwa | Rzeczywista odpowiedzialność |
|---|---|
| `packages/fullmag-py` | publiczne authoring API i serializacja ProblemIR |
| `crates/fullmag-ir` | kanoniczne typy semantyczne i plany wykonawcze |
| `crates/fullmag-plan` | walidacja legalności, lowering materiałów/oddziaływań, wybór integratora/lane'u |
| `crates/fullmag-engine` | podwójna precyzja CPU-reference, orakle pól i część przygotowania Newell |
| `crates/fullmag-runner` | dispatch, materializacja ABI, artefakty, quantities, runtime/provenance |
| `backends/fdm` | właściciel natywnego backendu CUDA, ABI C, kontekstów, kerneli i testów; build bez CUDA dostarcza wyłącznie ABI stub „unavailable”, nie solver CPU |
| `crates/fullmag-api` | resource-first API v2 i status sesji |
| `apps/control-room` | authoring/inspekcja przez typed client i zasoby |

### 3.2. Aktywny graf a kod osierocony

`crates/fullmag-runner/src/lib.rs:17-48` ładuje `dispatch` i `fdm`, lecz nie ładuje katalogów `solvers` ani `solver_runtime`. `crates/fullmag-runner/src/fdm/mod.rs:1-5` ładuje `artifacts`, `cpu`, `gpu`, `multilayer`, `schedules`. `crates/fullmag-runner/src/fdm/gpu/cuda/mod.rs:1-5` ładuje `direct_minimizer`, `multilayer` i monolityczny `native.rs`, ale nie `execute.rs` ani podzielonych modułów `native/*`.

Konsekwencje:

1. aktywna ścieżka single-grid nadal przechodzi przez duży `dispatch.rs` i `fdm/gpu/cuda/native.rs`;
2. kod w niepodłączonych drzewach należy oznaczać **source-visible**, nie „zaimplementowany w runtime”;
3. testy layoutu nie dowodzą, że nowa architektura jest używana;
4. przed dalszym rozwojem trzeba albo zakończyć migrację, albo usunąć osieroconą alternatywę, aby jedna funkcja nie miała dwóch pozornych właścicieli.

### 3.3. Publiczne ABI native

`native/include/fullmag_fdm.h` definiuje:

- precyzję FP32/FP64,
- layout single-grid i multilayer,
- integratory Heun, RK4, RK23, DP45 i ABM3,
- deskryptory planu, materiałów, demag kernel spectra i obserwabli,
- upload/download stanu, krok, statystyki i pola.

To jest realny kontrakt wykonawczy, ale nie jest jeszcze wystarczająco fail-closed. Szczególnie niebezpieczny jest fallback automatycznej budowy Newell: bufory widm są alokowane przez `cudaMalloc` bez inicjalizacji, ścieżka GPU wylicza tymczasowe wartości przestrzenne, nie wykonuje brakującego FFT/uploadu, zwalnia tymczasowe tablice, a następnie oznacza kernel jako dostępny. Runner Fullmag zwykle omija ten problem, sam dostarczając widma z `fullmag-engine`, ale publiczny fallback ABI może zakończyć się sukcesem i konwolwować z niezdefiniowaną zawartością pamięci. To jest P0 publicznego ABI, nie tylko nieoptymalny fallback.

---

## 4. Macierz oddziaływań FDM

Legenda: **tak** oznacza aktywną integrację, nie automatycznie walidację produkcyjną; **częściowo** oznacza ograniczony profil; **nie** oznacza brak lub jawne odrzucenie.

| Oddziaływanie / funkcja | Python / IR | Planner publiczny | CPU-reference | CUDA single | Multilayer | UI authoring | Werdykt |
|---|---|---|---|---|---|---|---|
| Exchange standard | tak | tak | uniform tak; spatial batch wadliwy | tak FP64/FP32 | tak | przełącznik study | wykonywalne dla podzbioru; brak pełnej kwalifikacji macierzy |
| Exchange T0/T1 sub-cell | hints w policy | tylko wybrane SDF; PBC odrzucone, FP32 bez PBC przepuszczone | częściowe orakle | FP64 aktywne, lecz `A²`/stale output; **FP32 brak pola T0/T1** | brak pełnego profilu | brak osobnego authoringu | **P0 w FP64 i FP32 z różnych przyczyn** |
| Exchange między regionami | couplings / plan LUT | tak | batch nie materializuje pełnego spatial/LUT contract | tak | częściowo | regiony istnieją, kontrakt niepełny | wymaga naprawy CPU, parity i testów granic |
| Spatial `Ms/A/alpha` | Python material fields / IR | tak | helper snapshot ma, batch pomija | ABI/kod ma | multilayer odrzuca object fields | authoring regionów częściowy | **P0 CPU batch** |
| Demag Newell FFT open | Demag | tak | tak | tak FP64/FP32 | transfer/convolution | demag study | runner path wykonywalny; **auto-Newell ABI P0** |
| Demag PBC truncated images | PBC | tak z bramkami | tak | FP64; FP32 seam bramkowany | nie | brak authoringu; tylko read-only periodic-pair diagnostics | macierz produkcyjna niekompletna |
| Zeeman uniform | Zeeman `B` | tak, konwersja `B/mu0` | tak | tak | tak, ale stacked ma czynnik `1/2` | zapisywalny study | single-grid wykonywalny; **P0 multilayer stacked** |
| Regional field drive | `field_drives` | single-grid CPU tak; CUDA odrzucone; multilayer błędnie nie odrzuca | tak | nie w publicznym lane | **cicho gubione z planu** | osobny authoring częściowy | **P0 multilayer i round-trip UI** |
| Prescribed Zeeman/antenna mask | Antenna/drive | single-grid CPU tak; FDM-CUDA forced reject, auto fallback CPU | tak | **nie w publicznym CUDA lane** | nie | osobne panele | brak publicznego wariantu anteny FDM-CUDA; `mqs_2p5d_az` odrzucone dla FDM |
| Uniaxial anisotropy | MaterialIR oraz błędny Python EnergyTerm | materiał: tak; energy term: nie | tak | tak | parametry warstw | obiekt: zapisywalny | runtime działa z materiału; **round-trip energii P0** |
| Cubic anisotropy | MaterialIR oraz błędny Python EnergyTerm | materiał: tak; energy term: nie | Kc1/Kc2; **brak Kc3** | Kc1/Kc2/Kc3 | parametry warstw | deferred | dodatkowy rozjazd CPU↔CUDA; **round-trip energii P0** |
| Interfacial DMI | EnergyTermIR | tak, lecz gubi `interface_normal` | tak | tak | tak | obiekt: zapisywalny | brak pełnego kontraktu normal/boundary |
| Bulk DMI | EnergyTermIR | tak | tak | tak | tak | deferred | **znak CUDA niezgodny z CPU/energią** |
| Natural DMI boundary | semantyka w docs | brak jawnego wyboru | różne stencil | clamp-to-center | częściowe | brak | niezaimplementowany kanonicznie |
| Thermal Brown field | dwa kontrakty Python | `ThermalNoise` odrzucone; top-level `temperature` trafia do planu | kod jest, ale batch gubi konfigurację | kod jest, ale `dt`/`mu0`/seed są wadliwe | brak kwalifikacji | brak wpisu katalogowego | **P0 kontraktu i obu runtime'ów** |
| Magnetoelastic prescribed strain | EnergyTermIR i rozszerzenia | odrzucone; `mel_* = None` | source-visible | source-visible | brak publicznej integracji | deferred | **nie jest publicznie wykonywalne FDM** |
| Oersted cylinder | EnergyTermIR | tak dla constant/sine/pulse | dispatch odrzuca | tak | odrzucone | deferred | macierz capability mylnie sugeruje CPU; błędna dowolna oś i czasy etapów CUDA |
| Oersted field z current solution | CurrentTransport + term | tylko precomputed/static | tak | tak | odrzucone | deferred | to nie jest sprzężony solver transportu |
| Zhang–Li STT | spin torque IR | tak single-grid | tak | tak | odrzucone | deferred | maska/PBC CUDA i granice wymagają naprawy |
| Slonczewski STT | spin torque IR | tak single-grid | tak | tak | odrzucone | deferred | brak pełnego workloadu fizycznego |
| SOT DL/FL | spin torque IR | tak single-grid | tak | tak | odrzucone | deferred | **P0: amplituda pola dodawana do `dm/dt`; brak maski** |
| Current transport prescribed density | CurrentModuleIR | tak jako źródło | używane przez torque/Oersted | używane przez torque/Oersted | odrzucone | deferred | wykonywalne jako zadane `j`, nie solver transportu |
| Ohmic Poisson / drift-diffusion | semantic types | odrzucone/deferred | brak pełnego solve | brak | brak | widoczne jako deferred | **niezaimplementowany solver transportu** |
| PBC dla lokalnych stencil | FdmPbc | exchange/demag częściowo | część operatorów | exchange/demag; torque/DMI niepełne | odrzucone | brak authoringu; tylko read-only periodic-pair diagnostics | nie jest globalnie spójnym profilem PBC |

### 4.1. Exchange standard i T0/T1

Standardowy operator nearest-neighbour ma ścieżki CPU-reference i CUDA FP64/FP32, obsługuje maskę i część semantyki regionów/PBC. Dla T0/T1 FP64 kod CUDA pobiera jednorodne `A`, mnoży nim wkład sąsiada, a następnie stosuje drugi globalny scale zawierający `A`; jednorodny materiał otrzymuje więc zależność `A²`. Wczesny return dla pustej/zerowej komórki nie zeruje zawsze bufora wyjściowego, co może pozostawić wynik z poprzedniego wywołania.

FP32 ma inny i równie krytyczny defekt: build nie zawiera kerneli T0/T1 FP32, a launcher zawsze uruchamia standard exchange niezależnie od `boundary_tier`. Planner blokuje część FP32+PBC, ale przepuszcza FP32+T0/T1 bez PBC. Redukcja energii nadal używa skorygowanych szablonów T0/T1, więc pole jest standardowe, a energia sub-cell-corrected. Analogicznie demag FP32 nie używa `volume_fraction`/sparse correction obecnych w FP64. Taki profil nie ma spójnej pary pole–energia.

Planner buduje SDF tylko dla cylindra oraz różnicy dwóch cylindrów. Dla innych geometrii loguje warning i pozostawia `boundary_geometry=None`; wrapper przekazuje null/0, C API nie wykonuje uploadu bez poprawnego `volume_fraction`, a `boundary_tier` pozostaje 0. Faktycznie wykonywany jest więc standardowy operator tier-0, mimo że publiczny plan nadal sugeruje T0/T1. To powinno być odrzuceniem fail-closed, nie degradacją bez zgody użytkownika.

### 4.2. Demag

Aktywna ścieżka runnera przygotowuje widma Newell na CPU (`compute_newell_kernel_spectra`, wariant thin-film albo periodic) i przekazuje je przez ABI. To ogranicza wpływ niedokończonego GPU-auto-Newell na standardowy runner Fullmag, lecz nie naprawia publicznego kontraktu ABI.

PBC jest realizowane jako skończona liczba obrazów okresowych. CUDA FP32 seam parity pozostaje jawnie zablokowane w plannerze. Multilayer używa odrębnej konwolucji/transferu między warstwami; nie ma jednego dowodu, że każda kombinacja offsetu, odstępu, grubości i rozdzielczości przechodzi zbieżność oraz parity CPU/CUDA.

### 4.3. DMI

CPU-reference dla bulk DMI stosuje znak zgodny z energią `E = D m·curl(m)`, natomiast kernel CUDA stosuje przeciwny znak pola. Ten problem występuje zarówno w operatorze multilayer, jak i w połączonej ścieżce single-grid. Ponadto stencil CUDA zastępuje brakującego sąsiada wartością komórki centralnej; nie implementuje naturalnego warunku DMI wynikającego z wariacji energii.

`InterfacialDMI.interface_normal` jest przechowywane w Rust IR, ale lowering FDM dopasowuje tylko `d` i ignoruje normalną. Globalny stencil DMI może też sprzęgać przyległe aktywne regiony, nawet jeśli wymiana między nimi została jawnie wyłączona; kontrakt region/interface dla DMI nie jest zdefiniowany i egzekwowany.

### 4.4. Anizotropie

Implementacje uniaxial i cubic istnieją po stronie CPU-reference i CUDA. Kanoniczny plan pobiera stałe z materiału. Problemem nie jest więc ogólny brak kernela, lecz publiczny model: Python dopuszcza te same pojęcia jako osobne `EnergyTerm`, których Rust nie deserializuje. Dodatkowo CPU-reference material config nie ma `Kc3`, podczas gdy CUDA stosuje `Kc3`, więc ten sam materiał nie ma parity. Planner odrzuca przestrzenne pola `ku1/ku2/kc1/kc2/kc3`, mimo że `Ms`, `A` i `alpha` mają pola gridowe. UI pozwala edytować uniaxial na obiekcie, ale cubic pozostawia jako deferred.

### 4.5. Termika

Publiczny model ma dwa wejścia:

```text
energy=[ThermalNoise(temperature=T, seed=S)]
Problem(..., temperature=T)
```

Python sprawdza ich zgodność, ale planner odrzuca wariant `ThermalNoise` w pętli energy terms. Jednocześnie bierze `problem.temperature` bezpośrednio do `FdmPlanIR`. W rezultacie użytkownik może uruchomić szum, ale nie może przenieść przez publiczny plan ziarna `seed`; żądanie quantity `H_therm` zależne od obecności odrzuconego termu jest praktycznie niespójne.

CPU ma dodatkową niespójność materializacji: helper snapshot/interactive ustawia temperaturę, `thermal_dt`, przestrzenne `Ms/A/alpha` oraz resolved periodic workspace, natomiast właściwa konstrukcja problemu batch nie przenosi tych pól. Publiczny CPU batch z temperaturą może więc wykonać deterministyczne `T=0`, a problem z niejednorodnym materiałem może zostać wykonany z parametrami uniform.

W native CUDA `current_dt` ma wartość domyślną `1e-13` i nie jest aktualizowane przy adaptacyjnym/faktycznym kroku. Skala Browna zależy od `1/sqrt(dt)`, więc błąd zmienia statystykę szumu. Drugi błąd amplitudy jest rozstrzygnięty przez ABI: `gyromagnetic_ratio` ma jednostkę `m/(A·s)`, lecz CUDA najpierw liczy `gamma0 = gamma * mu0`, a następnie dzieli jeszcze przez `gamma0 * mu0`. Wprowadza to dodatkowy czynnik `mu0` względem kontraktu i CPU-reference. Ziarno kernela pochodzi z `step_count`, nie z Python `ThermalNoise.seed`.

### 4.6. STT i SOT

Zhang–Li, Slonczewski i fenomenologiczny DL/FL SOT mają aktywne implementacje CPU i CUDA single-grid. Nie oznacza to jednak poprawności produkcyjnej:

- CUDA Zhang–Li nie zawija stencil po PBC i nie ma kompletnej ochrony maski;
- torque CUDA nie ma jednolitej maski active/material dla wszystkich rodzin;
- dla `m=0` człon damping-like SOT może być niezerowy i utworzyć magnetyzację w komórce nieaktywnej po normalizacji;
- amplituda SOT wyliczana jest w `A/m`, lecz dodawana bez czynnika `gamma_mu0` bezpośrednio do RHS `dm/dt [1/s]`; ten sam błąd semantyczny jest obecny w CPU-reference i w dokumencie fizycznym;
- nie ma kwalifikacyjnych workloadów ruchu ściany domenowej, STNO/MTJ ani testu odwrócenia znaku prądu obejmującego pełny plan.

### 4.7. Oersted i źródła zależne od czasu

Planner akceptuje `Constant`, `Sinusoidal` i `Pulse`, a odrzuca `PiecewiseLinear` oraz `SincPulse` dla cylindra Oersteda. Aktywny CPU dispatch jawnie odrzuca `has_oersted_cylinder`, mimo że inne warstwy capability opisują Oersteda CPU jako obsługiwany. CUDA przechowuje oś i środek, ale konstrukcja pola używa w praktyce geometrii osi `z` i płaszczyzny `xy`. Dowolna oś z publicznego IR nie jest realizowana.

Jeszcze ważniejszy jest czas: pole Oersteda i część innych źródeł są oceniane względem `current_time` kroku, nie zawsze w `t_n+c_i dt` danego etapu. To zmienia metodę dla RK4/RK23/DP45 i unieważnia FSAL, jeśli źródło zmienia się między końcem poprzedniego kroku a początkiem kolejnego. Energia zewnętrzna nie obejmuje konsekwentnie pracy Oersteda.

### 4.8. Energia i observables

Telemetry sumuje exchange, demag, external, anisotropy, cubic i DMI, ale pomija magnetoelastic oraz wkład Oersteda jako energię Zeemana. W native-stacked multilayer energia Zeemana ma dodatkowo błędny mnożnik `1/2`; dla energii zewnętrznej nie obowiązuje symetryczny czynnik używany dla samooddziaływań.

Dynamiczne CUDA `StepStats` i snapshot nie publikują tego samego zestawu: ścieżka krokowa mapuje tylko część anizotropii i pozostawia `e_dmi=0`, podczas gdy snapshot ma szersze redukcje. Planner akceptuje `H_dmi`, ale aktywny wrapper/dispatch CUDA nie materializuje tego pola. Zero lub brak nie może być używany zamiennie z jawnym `unsupported`.

To jest szczególnie groźne dla:

- kryteriów relaksacji opartych na energii,
- projected-gradient i nonlinear-CG line search,
- porównania `E_total` z sumą opublikowanych składowych,
- provenance/artefaktów, które sugerują kompletną energię.

---

## 5. Integratory czasu i LLG

### 5.1. Macierz integratorów

| Integrator | CPU-reference single | CUDA single | Adaptive | Multilayer staged | Multilayer native-stacked | Główne ograniczenie |
|---|---:|---:|---:|---:|---:|---|
| Heun / RK2 | tak | tak FP64/FP32 | nie | tak | tak | brak pełnej kwalifikacji źródeł stage-time |
| RK4 | tak | tak FP64/FP32 | nie | tak | tak | jw.; cztery RHS muszą widzieć poprawny czas |
| RK23 Bogacki–Shampine | tak | fixed tak; adaptive kod native, brak publicznego runtime row | CPU publiczne; CUDA rozjazd planner/runtime | tak fixed | tak fixed | FSAL i źródła czasowe/history invalidation |
| RK45 / Dormand–Prince | tak | fixed tak; adaptive kod native, brak publicznego runtime row | CPU publiczne; CUDA rozjazd planner/runtime | nie w staged | tak fixed | brak adaptive multilayer; pełny parity gate otwarty |
| ABM3 | tak | tak FP64/FP32 | nie | nie w staged | tak fixed | historia po zdarzeniach/uploadzie; regional drive odrzucony |

Planner wymaga adaptacji wyłącznie dla RK23/RK45. Dla FDM adaptive wymaga jawnego CPU albo CUDA zamiast `auto`. Runner ma jednak publiczną capability identity wyłącznie dla adaptive FDM CPU double; planner może więc przepuścić adaptive CUDA, które odpadnie dopiero w runtime mimo istniejącego kodu ABI. Multilayer odrzuca każdy plan bez `fixed_timestep`, nawet jeśli wybrany integrator ma embedded error estimate.

### 5.2. Aktualne ryzyka integratorów

1. **Czasy etapów.** Każdy RHS musi dostać własne `t_stage`; dotyczy Zeemana, Oersteda, anten, regional field drive, impulsów i ewentualnej termiki.
2. **FSAL.** RK23/DP45 mogą ponownie użyć ostatniej pochodnej tylko wtedy, gdy problem i źródła nie zmieniły się w sposób unieważniający pochodną.
3. **Historia ABM3.** Upload magnetyzacji, zmiana planu, skok wymuszenia, odrzucenie kroku lub zmiana `dt` musi resetować/odbudować historię.
4. **Normalizacja i maska.** Po każdym zaakceptowanym etapie aktywne komórki muszą być normalizowane, a nieaktywne pozostać dokładnie zerowe; samo końcowe `normalize` nie może ukrywać torque na masce.
5. **Streamy CUDA.** Kernely RHS, FFT, redukcje błędu i kopiowanie statystyk muszą mieć jawnie zgodną własność stream/event; synchronizacja przypadkowa nie jest kontraktem.
6. **Adaptacja.** Wartość błędu musi być znormalizowana względem tolerancji absolutnej i względnej, a zachowanie przy `dt_min` nie może cicho akceptować kroku spoza tolerancji bez jawnej polityki/provenance.
7. **Stochastyka.** Ten sam realizowany szum musi być użyty zgodnie z wybraną metodą/stage policy; zwykłe traktowanie Brown field jak deterministycznego RHS nie ustanawia poprawnego integratora SDE.

### 5.3. Równanie LLG i torque

Podstawowa precesja i tłumienie są obecne w CPU i CUDA. `llg_overdamped` wyłącza precesję i wykorzystuje jawne kroki jako relaksację. Problemem nie jest brak równania, lecz brak jednego zamrożonego kontraktu dla:

- znaczenia `gamma` kontra `gamma_mu0`,
- lokalnego `alpha` i jego wpływu na dodatkowe torque,
- pól `A/m` kontra bezpośrednich torque `1/s`,
- maski aktywności i regionów,
- czasu etapów,
- energii używanej jako kryterium zbieżności.

---

## 6. Relaksacja, histereza i bezpośrednie minimizatory

| Algorytm / workflow | Single-grid CPU | Single-grid CUDA | Multilayer | UI/API | Werdykt |
|---|---:|---:|---:|---:|---|
| `llg_overdamped` | tak | tak | tak | reklamowane | wykonywalne; walidacja pełna otwarta |
| `projected_gradient_bb` | tak | tak | planner odrzuca | reklamowane globalnie | single-grid zaimplementowane; status kłamie dla multilayer |
| `nonlinear_cg` | tak | tak | planner odrzuca | reklamowane globalnie | jw. |
| `tangent_plane_implicit` | nie dla FDM | nie | nie | status reklamuje globalnie, UI lokalnie bramkuje FEM CPU extended | błąd modelu capabilities |
| Hysteresis | orchestration istnieje | runtime istnieje | ograniczone | authoring częściowy | wymaga energy/relaxation qualification |
| Time evolution | tak | tak | fixed subset | tak | szeroko wykonywalne, nie produkcyjnie domknięte |
| Eigenmodes | planner FDM odrzuca | planner FDM odrzuca | nie | Python/IR istnieje; wykonanie FEM-only | **brak backendu FDM frequency-domain** |
| Frequency response | planner FDM odrzuca | planner FDM odrzuca | nie | Python/IR istnieje; wykonanie FEM-only | **brak backendu FDM frequency-domain** |
| Spin-wave time-domain / planar monitors | częściowo przez antenna/field drive | CUDA ma ograniczenia źródeł | niepełne | monitory i Field Map istnieją | funkcja time-domain, nie eigensolver FDM |
| Topological charge | derived quantity/resource | derived quantity/resource | profile warstw częściowe | osobny Inspector extension | osobny gate istnieje, nie uruchomiony w tym audycie |

Planner single-grid wybiera `llg_overdamped`, PG-BB albo NCG. Bezpośrednie minimizatory mają aktywny helper CUDA, ale poprawność celu zależy od kompletnej i zgodnej energii. Dopóki `E_total` pomija oddziaływania albo ma błędny czynnik, zielony test zbieżności minimizatora nie dowodzi znalezienia minimum kanonicznego funkcjonału.

Multilayer jawnie odrzuca PG-BB i NCG. Jest to aktualna luka funkcjonalna, nie tylko brak UI. Status API i frontend nie mogą reklamować tych algorytmów dla aktywnego planu multilayer.

---

## 7. Python DSL, ProblemIR i planner

### 7.1. Co działa

- Publiczny `Problem` potrafi opisać geometrię, regiony, materiały, FDM cell size, PBC, LLG, study, sampling i runtime selection.
- Istnieją klasy dla Exchange, Demag, Zeeman, interfacial/bulk DMI, Oersted, thermal, anizotropii, magnetoelastic, current modules, STT i SOT.
- `Problem.to_ir()` serializuje energię, current modules, field drives, spin torque, PBC oraz top-level temperature.
- Planner rozwiązuje maski, pola `Ms/A/alpha`, materiały, LUT wymiany między regionami, grid/PBC/image budget, integrator i provenance. Widma Newell są budowane później przy materializacji runnera CUDA.
- Testy Python API oraz plannera obejmują szeroki zestaw poprawnych i nielegalnych konfiguracji.

### 7.2. Krytyczne niespójności

#### PYIR-001 — anizotropia jest w złej unii publicznej

`packages/fullmag-py/src/fullmag/model/problem.py:860` zalicza `UniaxialAnisotropy` i `CubicAnisotropy` do `EnergyTerm`, a `Problem.to_ir()` bezwarunkowo emituje `term.to_ir()` do `energy_terms`. `crates/fullmag-ir/src/study.rs:309-377` nie ma odpowiadających wariantów enum. Rust nie może więc zdeserializować publicznie poprawnego obiektu Python. Wykonywalna anizotropia pochodzi niezależnie z pól materiału.

**Wymagane rozstrzygnięcie:** jedna kanoniczna własność, ale decyzji nie wolno podjąć wyłącznie na podstawie obecnego kodu. Notatka `docs/physics/0800-stno-vortex-mtj-physics.md` nazywa uniaxial anisotropy energy termem, podczas gdy runtime bierze ją z materiału, a walidator ProblemIR wymaga co najmniej jednego `energy_term`. Etap 0 musi najpierw rozstrzygnąć i zaktualizować fizykę/API. Wariant material/region wymaga usunięcia klas z unii EnergyTerm i zmiany reguły pustej energii; wariant energy-term wymaga dodania Rust IR i jawnej reguły konfliktu z materiałem.

#### PYIR-002 — termika ma dwa źródła prawdy

`ThermalNoise` przechowuje temperaturę i seed, a `Problem.temperature` przechowuje tylko temperaturę. Planner odrzuca term, lecz konsumuje pole top-level. Trzeba wybrać jeden kanoniczny model i zachować seed w provenance/ABI.

#### PLAN-001 — capability profile przeczy plannerowi

`crates/fullmag-runner/src/capabilities.rs:60-180` jest profilem intrinsic/code-present, a nie prostą listą `EnergyTermIR`: STT/SOT są lowerowane poza energią, a anizotropie pochodzą obecnie z materiałów. Nie należy więc porównywać całej listy z jedną pętlą plannera. Rzeczywiste sprzeczności to reklamowany magnetoelastic bez publicznej materializacji, rozdwojona termika i CPU Oersted deklarowany mimo odrzucenia w dispatch. Profil intrinsic, host/runtime availability i session/plan legality muszą pozostać trzema odrębnymi warstwami, ale używać wspólnego słownika identyfikatorów i reason codes.

#### PLAN-002 — DMI normal i boundary są gubione

Rust IR przechowuje `interface_normal`, ale planner FDM mapuje `InterfacialDmi { d, .. }` wyłącznie do skalarnego `d`. To cicha utrata intencji.

#### PLAN-003 — boundary correction degraduje się bez zgody

Dla geometrii bez obsługiwanego SDF planner tylko ostrzega. Publiczny plan nadal wygląda na włączony T0/T1, mimo że korekcja nie ma danych geometrycznych. Tryb strict powinien odrzucać. Ewentualna degradacja wymaga osobnego, typowanego opt-in i provenance; `extended` nie może być ogólnym koszem na fallback, bo jest zarezerwowane dla jawnych backend-specific features.

#### PLAN-004 — wymagany „bazowy” term jest sztucznym ograniczeniem

Planner wymaga co najmniej jednego z Exchange, Demag lub Zeeman. Problem zawierający wyłącznie DMI jest odrzucany, choć ma legalny energy term i zdefiniowane pole. Material-only anisotropy nie jest dziś poprawnym kontrprzykładem, bo ogólny walidator IR wymaga niepustego `energy_terms`; jego legalność zależy od wcześniejszego rozstrzygnięcia PYIR-001. Jeśli ograniczenie bazowego termu jest świadomą bramką Phase 1, musi być jawne w session legality; docelowo należy je usunąć lub uzasadnić fizycznie.

#### PLAN-005 — adaptive CUDA jest code-present, ale nie public-reachable

Python i IR opisują adaptive RK23/RK45, a planner dopuszcza jawne `device=cuda/gpu`. Natywne ABI również ma parametry adaptacji. Runtime capability identity obejmuje jednak tylko adaptive FDM CPU double. Request CUDA przechodzi więc zbyt daleko i jest odrzucany dopiero przy materializacji runtime. Planner i runtime muszą używać tej samej macierzy.

#### PLAN-006 — `allow_single_grid_fallback` jest martwym kontraktem

Python i IR przechowują `allow_single_grid_fallback`, ale planner go nie konsumuje. Pythonowy docstring obiecuje „silent fallback”, natomiast canonical physics note wymaga jawnego raportowania; dokumentacja sama jest więc niespójna. Flagę należy usunąć albo wdrożyć jako jawny, raportowany wybór; nie może pozostać publicznym no-op.

### 7.3. Luki provenance

Runner ma już wartościowy typowany kontrakt `TimestepPolicyProvenance { requested, resolved, execution_identity }`; nie należy go zastępować kolejnym luźnym schema. Luki leżą w jego zasilaniu i starszych polach równoległych:

- planner rozwiązuje literalne `integrator="auto"` przed provenance i nie zachowuje osobno pierwotnego żądania;
- CPU single-grid i multilayer pozostawiają starsze `requested_integrator`/`resolved_integrator` puste;
- interactive CUDA wpisuje ten sam rozwiązany enum do obu starszych pól i formatuje go Rustowym `Debug` (`Rk45`) zamiast publicznym `rk45`;
- Python i browser używają różnych kluczy metadata (`execution_mode`/`execution_precision` kontra `mode`/`precision`);
- `gpu_count` jest serializowany i walidowany, ale FDM planner/runner/ABI go nie konsumują, więc nie istnieje publiczna semantyka multi-GPU.

Należy uczynić typowany timestep provenance źródłem kanonicznym, zachować literalny requested intent i wygasić lub konsekwentnie zasilać starsze stringi. Sam fakt `resolved_mode == requested_mode` nie jest błędem, dopóki żadna jawna polityka nie rozwiązuje mode inaczej.

### 7.4. Multilayer lowering

Planner multilayer:

- dopuszcza Exchange, Demag, Zeeman, interfacial i bulk DMI;
- odrzuca Oersted i pozostałe energy terms;
- odrzuca STT oraz wszystkie PBC;
- odrzuca adaptację;
- dopuszcza tylko `llg_overdamped` w relaksacji;
- wybiera staged CPU/CUDA dla Heun/RK4/RK23 albo native-stacked CUDA dla kompatybilnych planów, gdzie możliwe są także RK45/ABM3 fixed.

Krytyczny wyjątek: `ProblemIR.field_drives` nie jest odrzucane dla multilayer, lecz `FdmMultilayerPlanIR` nie ma pola na drives. Planner używa jedynie informacji o ich obecności przy walidacji outputs, po czym buduje plan bez treści drive. Jeżeli output nie ujawnia problemu, authored drive może zniknąć cicho. Do czasu pełnej implementacji multilayer planner musi fail-closed dla każdego `field_drive`.

Ten podział musi być widoczny w provenance i UI. Sam napis „multilayer supported” jest za mało precyzyjny.

---

## 8. Quantities, artefakty i provenance

### 8.1. Zadeklarowane quantities

Profil CPU reklamuje `m`, `H_ex`, `H_demag`, `H_ext`, `torque`, `H_ani`, `H_dmi`, `H_eff` oraz gęstości energii. Profil CUDA reklamuje m.in. `H_oe`, ale pomija `H_dmi` i większość gęstości energii mimo obecności części statystyk native. Scalar outputs ograniczają się do `E_ex`, `E_demag`, `E_ext`, `E_total`.

Problemy:

1. supported terms nie pokrywają się z publikowanymi polami i energiami;
2. `E_total` nie jest sumą wszystkich aktywnych oddziaływań;
3. output validation wiąże `H_therm` z odrzuconym `ThermalNoise`, a nie z faktycznie konsumowanym `Problem.temperature`;
4. część torque jest bezpośrednim RHS i nie da się jej poprawnie odtworzyć wyłącznie z `H_eff`;
5. status/capabilities nie jest wyprowadzany z konkretnego planu i lane'u;
6. provenance zawiera nadal język „Phase 1 reference FDM”, który nie opisuje współczesnego rozdziału CPU-reference/CUDA production.

### 8.2. Minimalny kontrakt publikacji

Dla każdego aktywnego oddziaływania powinny istnieć, jeśli fizycznie mają sens:

- pole `H_* [A/m]` albo bezpośredni torque `tau_* [1/s]`, ale nie mieszanka bez metadanych;
- gęstość energii `e_* [J/m^3]` dla oddziaływań konserwatywnych;
- skalar `E_* [J]` z jasno określonym ważeniem częściowych komórek i warstw;
- `E_total` równe sumie wszystkich aktywnych energii konserwatywnych;
- maska/domena, centrum próbkowania, layout, precyzja i revision;
- requested intent oraz resolved backend/device/precision/realization;
- jawne `unsupported`, a nie puste/zerowe pole udające wynik.

---

## 9. API v2, OpenAPI i Control Room

### 9.1. Co jest obecne w aktywnym kodzie

Control Room nie ma osobnej aplikacji FDM i FEM. Oba backendy przechodzą przez ten sam module kernel, typed client, resource hooks, status, Inspector, viewport i Analysis Plots. To jest zgodne z architekturą produktu, ale obecność tych powierzchni nie oznacza ich pełnego domknięcia ani świeżego browser E2E.

Potwierdzone pozytywne elementy:

- frontendowy kod `src` korzysta z centralnej ścieżki API; governance blokuje bezpośrednie `fetch`, ręczne endpointy `/v2` i powrót do publicznego `/v1`;
- OpenAPI v2 jest generowane, a ścieżki są promowane do `apiPaths`;
- stage execution publikuje status, reason, convergence, transitions, checkpoint i `artifact_refs`;
- pola, historie energii i scalars mają facade/resource hooks;
- wykresy korzystają z tabel binarnych i historii solvera, a websocket służy do invalidacji/aktualizacji;
- viewport ma rzeczywisty adapter FDM i pobiera wektory pola przez resource/cache layer;
- wybrane interakcje study i obiektowe są naprawdę zapisywalne, a nie tylko narysowane.

Generator nie gwarantuje jednak bieżącej synchronizacji artefaktów: świeży backend OpenAPI zawiera enum command `remove_field_drive`, którego brakuje w checked-in `apps/control-room/src/kernel/api/generated/openapi-v2.json`. Celowane testy generated contract tego driftu nie wykryły.

### 9.2. Capability gating jest za płaskie

`GET /v2/sessions/current/status` publikuje jedną listę:

```text
llg_overdamped, projected_gradient_bb, nonlinear_cg, tangent_plane_implicit
```

Lista jest identyczna dla FDM/FEM, CPU/GPU, single-grid/multilayer, precision i execution mode. UI ma specjalny warunek tylko dla tangent-plane implicit; pozostałe algorytmy uważa za dostępne, jeśli są na liście. To prowadzi m.in. do reklamowania PG-BB/NCG dla multilayer, choć planner je odrzuca.

Dokładniejsza macierz hosta istnieje pod `/v2/platform/capabilities` i zawiera backend, device, precision, mode, status, reason, public i stability. Jest to jednak **host inventory/discovery**, a nie legalność konkretnego problemu. Frontend ma ścieżkę w `apiPaths`, ale nie ma facade, hooka ani widoku. Status bar pokazuje requested/resolved backend i device, lecz nie wykorzystuje publikowanych `resolved_precision` ani `resolved_mode`.

`LiveStatus.capabilities` jest w schemacie jawnie opisane jako „Canonical UI gating source for the current session”. Bieżąca implementacja nie spełnia tej obietnicy, bo publikuje zbyt globalny zestaw. Nie należy dodawać drugiego, niezależnego źródła prawdy obok niego. Są dwie zgodne architektonicznie drogi:

1. wzbogacić `status.capabilities` do pełnej legalności aktywnego planu, kosztem rozrostu thin status; albo
2. preferowane w resource-first API: najpierw zmienić spec/ADR, przenieść pełną legalność do jednego session-scoped resource i zostawić w statusie wyłącznie cienkie summary/revision pointer.

W obu wariantach `/platform/capabilities` pozostaje inwentarzem hosta, a UI ma dokładnie jednego właściciela gatingu aktywnej sesji.

Wymagany model capability musi zależeć co najmniej od:

```text
backend × layout(single/multilayer) × device × precision × execution mode
× integrator/relaxation × active interactions × PBC × time dependence
```

### 9.3. Macierz authoringu

| Obszar | Kontrolka UI | SceneDocument | Export Python | Runtime/publicacja | Stan |
|---|---:|---:|---:|---:|---|
| Exchange/Demag/Zeeman | tak | tak | tak | tak | funkcjonalny podzbiór |
| Uniaxial/iDMI | tak | tak | częściowo | tak | działa, ale dotyka driftu modelu anizotropii |
| Backend/device/precision/mode | tak | pola istnieją | **round-trip przerwany w obu kierunkach** | runtime selection istnieje | **P0: może zmienić faktyczny lane** |
| Bulk DMI/Cubic | widoczne jako deferred | niepełne | nie | backend częściowo | niegotowe |
| Current transport | deferred/brak aktywnego formularza | `current_modules` istnieje | tak | prescribed source lane-specific | kontrakt Scene/export istnieje, UI niegotowe |
| STT/SOT | deferred | brak canonical `spin_torques` resource | nie | lane-specific | niegotowe |
| Oersted | deferred | źródła częściowo | niepełne | lane-specific | niegotowe |
| Regional field drive/antenna | tak | tak | **round-trip przerwany** | CPU tak, CUDA reject | **P0: utrata canonical data** |
| FDM PBC | brak formularza | brak | Python ma | runtime częściowy | niegotowe |
| Thermal/seed | disabled/brak | brak | Python ma niespójny kontrakt | runtime wadliwy | niegotowe |
| Multilayer | pośrednio przez wiele obiektów | tak | częściowo | ograniczony | brak prezentacji restrykcji |
| Integratory | tylko podzbiór | solver policy | tak dla wartości zapisanej w modelu | pięć metod | brak RK4/ABM3 w selectach i lane-aware gatingu |
| Relaksacja/stops | stage: tak; global: pola ukryte | tak | schema-dependent | tak | stage stops działają; global policy nie jest renderowane i może zginąć w override |
| Fields/scalars/energies | nie dotyczy | quantity contract | nie dotyczy | tak | odczyt działa; kompletność fizyczna pól otwarta |
| Artifacts | tylko refs/bytes po ID | refs | nie dotyczy | list/download API istnieje | brak browsera zasobu |

### 9.4. Nadrzędna przyczyna: trzy niezgodne kontrakty overrides

Nie istnieje jeden typowany kontrakt `SceneDocument` → script-builder overrides:

- adapter Rust w `crates/fullmag-authoring/src/adapters.rs:230-381` emituje pełne `runtime_selection`, ale pola relaksacji płasko w `solver` i nie emituje `field_drives`;
- adapter Python w `packages/fullmag-py/src/fullmag/runtime/scene_document.py:450-603` emituje w runtime tylko `cpu_threads`, relaksację pod `solver.relax` i również pomija `field_drives`;
- renderer w `packages/fullmag-py/src/fullmag/runtime/script_builder.py:867-903`, `packages/fullmag-py/src/fullmag/runtime/script_builder.py:3664-3707` używa z runtime override tylko `cpu_threads`, natomiast dla globalnej relaksacji oczekuje właśnie zagnieżdżonego `solver.relax`.

To nie są trzy izolowane błędy kontrolek, lecz jeden drift schematu na granicy Rust/Python. Każda nowa właściwość może być poprawnie zapisana w SceneDocument, a mimo to cicho zniknąć podczas sync/export. Naprawa musi ustanowić jeden wersjonowany schema, generowane lub współdzielone typy oraz test: Rust adapter output → Python renderer consumption → parse → równoważny ProblemIR.

### 9.5. Przerwany round-trip execution selection

Pythonowa projekcja do SceneDocument hardkoduje `requested_backend="auto"`, `requested_device="auto"`, `requested_precision="double"` i `requested_mode="strict"`, zamiast zachować `Problem.runtime`. Study Inspector czyta właśnie te pola i renderuje na ich podstawie kontrolki, więc załadowany skrypt z jawnym FDM/CUDA/single/extended może zostać pokazany jako auto/double/strict.

W kierunku odwrotnym Rust przygotowuje rewrite override z backend/device/precision/mode, ale Python `_render_runtime()` używa z override wyłącznie `cpu_threads`; engine/device/precision pobiera ze starego `problem.runtime`, a mode nie renderuje. Zmiana wykonana w UI może więc cicho zniknąć z eksportowanego skryptu i późniejszego ProblemIR.

To jest P0, ponieważ traci kanoniczne dane oraz może zmienić faktyczny backend, urządzenie, precyzję i execution mode.

### 9.6. Przerwany round-trip RegionalFieldDrive

Inspector anteny zapisuje canonical drive do SceneDocument. Polecenie eksportu wykonuje `model/syncs`, a następnie pobiera `model/script`. Jednak projekcja SceneDocument do script-builder overrides nie przenosi `field_drives`, a renderer Python czyta je wyłącznie z pierwotnego `Problem`.

Skutek: drive dodany albo zmieniony w Control Room może zniknąć z wyeksportowanego skryptu lub zachować starą wartość ze źródła. Jest to bezpośrednie naruszenie reguły canonical round-trip i P0 według definicji utraty kanonicznych danych.

### 9.7. Brakujące powierzchnie authoringu

SceneDocument ma field drives i current modules, lecz Control Room nie ma aktywnego formularza current transport i nie ma kanonicznych pól dla:

- FDM PBC wraz z image policy,
- temperatury, integratora stochastycznego i seed,
- canonical spin torque modules,
- pełnej legalności single-grid/multilayer,
- T0/T1 boundary correction i certyfikatu geometrii.

PBC Inspector jest routerem do read-only `periodic_pairs` FEM/meshing diagnostics, nie formularzem FDM PBC. Thermal oraz Spin Torque są disabled w ribbonie. Katalog interakcji uczciwie oznacza current transport, spin torque, bulk DMI, cubic, Oersted i magnetoelastic jako `deferred`; to poprawna komunikacja bieżącego stanu, ale nie realizacja product promise.

### 9.8. Integratory i globalna relaksacja w UI

IR i Python wspierają `heun`, `rk4`, `rk23`, `rk45`, `abm3`, a renderer potrafi wyeksportować string integratora zapisany w modelu. Globalny i stage editor oferują jednak tylko Heun, RK23 i RK45. Import planu z RK4/ABM3 pozostawia select bez odpowiadającej opcji; luka dotyczy kontrolek i capability gatingu, nie samego renderera Python.

Globalny model przechowuje i zapisuje `relaxAlgorithm`, `torqueTolerance`, `energyTolerance` oraz `maxRelaxSteps`, lecz `StudySolverPolicyFields` nie renderuje tych pól. Dodatkowo Rust emituje je płasko, a renderer oczekuje `solver.relax`, więc sync może je zignorować. Stage-level relaxation/stops przechodzą osobną, działającą ścieżką i nie naprawiają globalnego kontraktu.

### 9.9. Artefakty i dowód browser E2E

Backend ma listę oraz pobieranie artefaktu, ale frontendowa facade wystawia tylko bytes po znanym ID. Nie ma resource hooka i modułu Results pozwalającego listować, filtrować, pobierać i powiązać artefakty z etapem/provenance.

Przed dodaniem browsera trzeba naprawić invalidację. `ResourceRevisionMap` publikuje równolegle `artifact_revision` i `artifacts_revision`. Pierwsze pole hashuje tylko długości `path`/`kind`, drugie jest wyłącznie liczbą wpisów; realtime `Artifacts` używa właśnie count. Podmiana artefaktu przy tej samej liczbie wpisów może więc nie wygenerować invalidacji. ETag listy używa dokładnych `path`/`kind`, ale pomija `region_owned_provenance`, zatem zmiana provenance może zwrócić klientowi błędne `304`.

Obecny smoke authoringu przechwytuje `/v2/**`, mutuje fixture i tworzy ręcznie stały string „Python round-trip”, zamiast wykonać rzeczywiste `model/syncs` → `model/script` → parse → ProblemIR. Część selektorów jest nieaktualna względem strukturalnego editora study. Viewport smoke prawidłowo sprawdza canvas/WebGL/drawing buffer, ale nie uruchamia kontrolowanego problemu FDM i nie dowodzi pełnego runtime → binary field → adapter → piksele.

`StudyAuthoringSmokeScript.test.ts` nie wykonuje browser smoke: czyta plik skryptu i sprawdza obecność stringów. Sam `smoke-study-authoring-ui.mjs` nadal szuka nieistniejącego textboxa `Solver`, a funkcja nazwana Python round-trip buduje stały string zamiast pobrać wynik `model/syncs` → `model/script`. Taki test może przejść mimo cichej utraty canonical data.

### 9.10. Dług API/UI niższego priorytetu

- run-level `status_reason` jest zerowane, nawet gdy stage ma poprawny reason;
- `ControlRoomApi` osłabia typowanie generowanego OpenAPI przez `as never`;
- `/data/fields` nadal używa wewnętrznego `preview_cache` jako fallback payloadu bez jawnego kryterium usunięcia;
- menu zawiera disabled placeholdery FDM CPU/GPU mimo istniejącego editora execution policy;
- komentarz modułu scalarów nadal wspomina usunięty endpoint `/v1/live/current/scalars`.
- komenda `Export Python DSL` najpierw wywołuje mutujące `model.syncs`, a backend zawsze uruchamia helper z `--write`; eksport nadpisuje aktywny `session.script_path`, mimo że osobne `Save / Sync` jest disabled. Semantyka save kontra export wymaga jawnej decyzji i testu.

---

## 10. Rejestr ustaleń

### 10.1. P0 — blokery właściwych lane'ów

| ID | Obszar | Ustalenie | Główny dowód |
|---|---|---|---|
| FDM-EXEC-001 | execution/provenance | Jawne `runtime_selection.device=gpu/cuda` może przy braku CUDA przejść na CPU; główne run paths wywołują resolver zwracający tylko engine i gubią opis fallback. Jest to sprzeczne z zasadą forced-GPU fail-closed. | `crates/fullmag-runner/src/dispatch.rs:657-753`; `crates/fullmag-runner/src/lib.rs:1467-1489`, `1733-1766`, `2048-2080` |
| FDM-XCH-001 | T0/T1 exchange | Jednorodny `A` jest mnożony w stencil i ponownie w prefactorze, dając `A²`. | `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu:75-163`; `backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu:83-203` |
| FDM-SUBCELL-FP32-001 | T0/T1 FP32 | Launcher FP32 ignoruje `boundary_tier` i liczy standard exchange, demag FP32 ignoruje volume correction, lecz redukcje energii stosują T0/T1; pole i energia są niespójne. | `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu:140-180`; `backends/fdm/gpu/cuda/interactions/demag_fp32.cu`; `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu:946-1010` |
| FDM-DEMAG-ABI-001 | auto-Newell ABI | Przy braku dostarczonych spectra bufory CUDA pozostają niezainicjalizowane, auto-builder nie wykonuje FFT/uploadu, a kontekst oznacza kernel jako gotowy. | `backends/fdm/gpu/cuda/runtime/context.cu:83-105`, `backends/fdm/gpu/cuda/runtime/context.cu:1338-1355`; `backends/fdm/gpu/cuda/demag/newell_gpu_fp64.cu:449-525`; `backends/fdm/gpu/cuda/demag/newell_gpu_fp32.cu:197-260` |
| FDM-DMI-001 | bulk DMI | CUDA używa znaku przeciwnego do CPU-reference i wariacji energii `D m·curl(m)`. | `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu:84-115`; `crates/fullmag-engine/src/fdm/cpu/fields.rs:1063-1074` |
| FDM-SOT-001 | SOT units | Amplituda o jednostce pola `A/m` jest dodawana bez `gamma_mu0` do `dm/dt [1/s]`; błąd jest wspólny dla CPU, CUDA i notatki fizycznej. | `backends/fdm/include/context.hpp`; `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`; `crates/fullmag-engine/src/fdm/cpu/fields.rs` |
| FDM-MASK-001 | torque/maska | CUDA RHS Zhang–Li/SOT nie respektuje pełnej active mask; SOT może utworzyć magnetyzację w pustej komórce. | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu` i wariant FP32 |
| FDM-CPU-001 | CPU materialization | Konstrukcja CPU batch nie przenosi temperatury/thermal `dt`, spatial `Ms/A/alpha` ani planned resolved periodic workspace, więc wykonanie może różnić się od planu i snapshotu. | `crates/fullmag-runner/src/fdm/cpu/reference.rs:562-601`, `695-764` |
| FDM-THERM-002 | CUDA thermal | Amplituda Browna używa stałego `current_dt=1e-13`, nie faktycznego kroku, oraz dodatkowego czynnika `mu0` względem jednostek gamma w ABI/CPU; seed publiczny nie dociera do ABI. | `native/include/fullmag_fdm.h:134`; `backends/fdm/include/context.hpp:176-179`; `backends/fdm/gpu/cuda/interactions/demag_fp64.cu:674-680`; `backends/fdm/gpu/cuda/interactions/demag_fp32.cu:635-641`; `crates/fullmag-engine/src/fdm/cpu/fields.rs:1128-1142` |
| FDM-ML-001 | multilayer energy | Native-stacked liczy Zeemana z czynnikiem `-0.5 mu0 Ms` zamiast `-mu0 Ms`. | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs:2358-2434`, `2600-2614` |
| FDM-ML-DRIVE-001 | multilayer lowering | Planner nie odrzuca `field_drives`, ale `FdmMultilayerPlanIR` nie ma na nie pola; authored drive może zniknąć bez błędu. | `crates/fullmag-ir/src/mesh_hints.rs:69-110`; `crates/fullmag-plan/src/fdm.rs:1697-1716`, `2215-2240` |
| FDM-ENERGY-001 | direct minimizer | RegionalFieldDrive wpływa na pole/gradient CPU, lecz jego energia jest pominięta w line-search; minimum nie odpowiada użytemu RHS. | `crates/fullmag-engine/src/fdm/cpu/fields.rs:1337-1358`, `2040-2053`, `3156-3217` |
| PYIR-001 | Python/IR | Pythonowe EnergyTerm dla uniaxial/cubic emituje tagi bez wariantów Rust `EnergyTermIR`; publiczny round-trip kończy się na deserializacji. | `packages/fullmag-py/src/fullmag/model/problem.py:860`, `1432`; `crates/fullmag-ir/src/study.rs:309-377` |
| UI-OVERRIDE-001 | UI/Python round-trip | Rust adapter, Python adapter i Python renderer używają trzech niezgodnych kształtów overrides; canonical data może zostać utracone dla każdej nowej właściwości, nie tylko jednego panelu. | `crates/fullmag-authoring/src/adapters.rs:230-381`; `packages/fullmag-py/src/fullmag/runtime/scene_document.py:450-603`; `packages/fullmag-py/src/fullmag/runtime/script_builder.py:867-903`, `packages/fullmag-py/src/fullmag/runtime/script_builder.py:3664-3707` |
| UI-EXEC-001 | UI/Python round-trip | Python → Scene hardkoduje auto/double/strict, a Scene → Python ignoruje zmiany backend/device/precision/mode; może zostać wykonany inny lane. | `packages/fullmag-py/src/fullmag/runtime/scene_document.py:303-310`; `packages/fullmag-py/src/fullmag/runtime/script_builder.py:867-903` |
| UI-FIELD-001 | UI/Python round-trip | Zmieniony RegionalFieldDrive nie trafia do rewrite overrides i może zniknąć albo pozostać stary w eksporcie. | `crates/fullmag-authoring/src/adapters.rs:230-338`; `packages/fullmag-py/src/fullmag/runtime/script_builder.py` |

### 10.2. P1 — kompletność i zgodność

| ID | Obszar | Ustalenie |
|---|---|---|
| FDM-THERM-003 | thermal IR | `ThermalNoise` jest odrzucane, top-level temperature trafia do planu, seed ginie; `H_therm` validation patrzy na niewykonywalny term. |
| FDM-T0-002 | boundary correction | Nieobsługiwana geometria degraduje T0/T1 do braku efektu bez błędu. |
| FDM-T0-003 | partial cells | Exchange/demag i pozostałe energie nie używają jednej reguły udziału objętości. |
| FDM-PBC-001 | Python/IR | Pythonowy `FdmPbc` akceptuje FEM-only `periodic_airbox_k0`; odrzucenie następuje dopiero później w IR/plannerze. |
| FDM-DMI-002 | boundary | Brak naturalnego DMI boundary condition; stencil clamp-to-center nie jest pełnym kontraktem wariacyjnym. |
| FDM-DMI-003 | interface/regions | `interface_normal` jest gubione; DMI może sprzęgać stykające się obiekty mimo wyłączenia exchange. |
| FDM-ANI-001 | cubic parity | CPU-reference nie uwzględnia publicznego `Kc3`, CUDA uwzględnia. |
| FDM-OE-001 | CPU capability | CPU dispatch odrzuca cylinder Oersteda mimo deklaracji wsparcia w capability. |
| FDM-OE-002 | CUDA geometry/time | Cylinder CUDA ignoruje dowolną oś i nie ma kompletnego stage-time dla metod RK. |
| FDM-STT-001 | Zhang–Li | CUDA stencil nie zawija PBC i nie ma pełnej maski. |
| FDM-OBS-001 | StepStats | Dynamiczne CUDA stats mapują tylko część anizotropii i pozostawiają `e_dmi=0`; snapshot ma inny zestaw. |
| FDM-OBS-002 | H_dmi | Planner akceptuje `H_dmi`, ale aktywny wrapper/dispatch CUDA go nie materializuje. |
| FDM-OBS-003 | external/Oersted | Generalized external/Oersted wpływa na RHS, lecz energia/total nie obejmuje go kompletnie. |
| FDM-INT-001 | integrator state | Upload stanu i nieciągłości nie mają jednego, sprawdzonego resetu FSAL/ABM history. |
| FDM-INT-002 | adaptive/stochastic | Brak kwalifikacji accepted-step counter i szumu dla odrzuconych prób adaptive. |
| FDM-INT-003 | adaptive CUDA | Planner dopuszcza adaptive CUDA, lecz runtime nie ma odpowiadającego capability identity; request odpada zbyt późno. |
| FDM-ML-002 | scope | Multilayer nie obsługuje PBC, thermal, torque, Oersted, adaptive ani PG-BB/NCG; native i assisted mają inne integratory. |
| FDM-ML-003 | residency | CUDA-assisted multilayer wykonuje integrację hostowo i wielokrotnie transferuje dane; nie jest lane'em device-resident. |
| CAP-001 | capabilities | Host availability, intrinsic engine support i session/plan legality są mieszane w komunikacji; globalny status nie opisuje planu, ale platform matrix nie powinien być z niego wyprowadzany. Warstwy wymagają wspólnych ID/reason codes i osobnych właścicieli. |
| CAP-002 | SOT/Oersted/thermal | Capability JSON oznacza SOT jako semantic-only mimo aktywnego kodu, a równocześnie nadmiernie reklamuje CPU Oersted i `ThermalNoise`. |
| IR-001 | provenance | Requested/resolved integrator/device/precision/mode nie są kompletnie i typowanie zachowane; CPU pozostawia integratory puste, CUDA duplikuje resolved jako requested. |
| IR-002 | fallback flag/docs | Publiczne `allow_single_grid_fallback` nie ma konsumenta; Python docstring obiecuje „silent fallback”, a physics note wymaga raportowania. |
| IR-003 | anisotropy semantics | Standalone uniaxial dopuszcza easy-plane przez `Ku1<0`, lecz wykonywalna ścieżka materiałowa wymaga `Ku1>=0`. |
| UI-002 | authoring | Brak canonical authoringu PBC, thermal/seed i spin torques. |
| UI-003 | integratory | UI pomija RK4/ABM3 i nie bramkuje macierzy multilayer/field-drive. |
| UI-004 | artifacts | API list/download istnieje, lecz brak resource hooka i przeglądarki artefaktów; najpierw trzeba naprawić revision/ETag contract. |
| UI-RELAX-001 | global solver policy | Model zapisuje globalny algorytm/tolerancje/limit kroków relaksacji, ale pola nie są renderowane, a drift `solver` kontra `solver.relax` może je zgubić przy sync. |
| API-ART-001 | artifact invalidation | Realtime revision opiera się na liczbie artefaktów, drugi hash tylko na długościach path/kind, a ETag pomija provenance; replacement lub zmiana provenance może nie unieważnić klienta. |
| API-OAS-001 | generated OpenAPI | Świeżo wygenerowany backend schema różni się od checked-in JSON: frontendowy enum command nie zawiera `remove_field_drive`; istniejący generated-contract test nie wykrywa driftu. |
| API-004 | execution authoring | Runtime selection używa dowolnych `String`, PATCH zapisuje je bez walidacji enumów, a Scene validator ich nie sprawdza; nielegalny intent wchodzi do canonical scene i odpada dopiero później. |
| TEST-001 | canonical round-trip | Smoke authoringu mockuje backend i ręcznie tworzy wynik „Python round-trip”, więc nie wykrywa utraty danych Scene → script → IR. |
| TEST-002 | stale browser smoke | Test źródłowy tylko wyszukuje stringi, a właściwy smoke ma nieaktualny selektor `Solver`; deklarowany browser proof nie jest wiarygodną bramką. |
| TEST-GPU-001 | native CTest | Wiele testów GPU zwraca sukces przy braku urządzenia, a CMake nie rejestruje tego jako skip; zielony CTest nie dowodzi wykonania GPU. |
| VALID-001 | qualification | Brak zarządzanych gate'ów dla każdego publicznie deklarowanego profilu CPU double/CUDA double/CUDA single oraz celowanej coverage jego interakcji i integratorów. |
| VALID-002 | SP4 | Skrypt SP4 generuje wyniki, lecz nie ma oficjalnego orakla trajektorii, pierwszego `mx=0` i zbieżności siatkowej. |

### 10.3. P2 — architektura i utrzymanie

| ID | Obszar | Ustalenie |
|---|---|---|
| ARCH-001 | module graph | Obszerne drzewa split-source nie należą do aktywnego grafu; istnieją dwie pozorne architektury runnera. |
| ABI-001 | error contract | Multilayer v2 używa `last_error` także dla komunikatów sukcesu, a Rust allowlistuje tekst. |
| ABI-002 | input validation | Nieznany execution policy może spaść do `auto`; błędny GPU index może zostać zignorowany. |
| ABI-003 | build | Architektury CUDA są hardkodowane; build bez CUDA tworzy stub, którego obecność nie dowodzi GPU. |
| API-001 | run reason | Run-level `status_reason` ginie mimo dostępnego stage reason. |
| API-002 | type safety | `as never` osłabia generated OpenAPI contract. |
| API-003 | field cache | `preview_cache` pozostaje fallbackiem canonical fields bez ownera/removal gate. |
| API-005 | export side effect | `Export Python DSL` wykonuje mutujące sync i `--write`, nadpisując aktywny skrypt przed downloadem bez osobnego kontraktu save/export. |
| DOC-001 | docs drift | Wiele checklist fizycznych nie odzwierciedla ani istniejącego kodu, ani aktualnych luk. |
| IR-004 | stop reasons | `MaxPseudotime` pozostał w IR/OpenAPI, choć canonical stop scala czasy, a runner go nie emituje. |

---

## 11. Co jest już zrobione

### 11.1. Fizyczny i numeryczny rdzeń

- structured-grid single-grid z maską, regionami i planem pól materiałowych `Ms/A/alpha`; CPU batch materialization tych pól jest otwartym P0;
- CPU-reference double oraz natywny CUDA FP64/FP32;
- exchange standard, demag Newell FFT, uniform/per-cell external field;
- uniaxial/cubic anisotropy, interfacial/bulk DMI w kodzie CPU/CUDA;
- PBC dla części exchange/demag i truncated periodic images;
- T0/T1 boundary correction source dla CUDA;
- current-density-driven Zhang–Li, Slonczewski oraz fenomenologiczny SOT;
- Oersted generalized map i cylinder CUDA;
- Brown thermal source w kodzie CPU/CUDA;
- Heun, RK4, RK23, DP45/RK45 i ABM3;
- fixed single-grid CPU/CUDA oraz adaptive CPU; kod adaptive CUDA istnieje, ale publiczny runtime contract jest niespójny;
- relaksacja LLG overdamped, projected-gradient BB i nonlinear-CG single-grid;
- orchestration hysteresis i time evolution;
- dwa lane'y multilayer: native-stacked i CUDA-assisted;
- C ABI, statystyki, snapshoty i część obserwabli.

### 11.2. Publiczny stos

- rozbudowany Python DSL oraz walidacja podstawowych parametrów;
- kanoniczne ProblemIR/plany dla większości bazowych funkcji;
- planner z wieloma fail-closed ograniczeniami urządzenia, precision, PBC i multilayer;
- runtime registry i platform capability matrix;
- resource-first API v2 z polami binarnymi, scalars, stage status i artefaktami;
- typed client/resource hooks w Control Room;
- wspólny viewport FDM/FEM, Analysis Plots i Inspector;
- zapisywalne podstawowe interakcje study oraz część interakcji obiektowych;
- testy jednostkowe Rust/Python/TypeScript i natywne kontrakty źródłowe/runtime.

---

## 12. Co nadal wymaga wykonania

### 12.1. Warunki konieczne przed jakąkolwiek deklaracją produkcyjną

1. Usunąć wszystkie P0 z sekcji 10.1 i dodać testy regresyjne, które przed poprawką zawodzą.
2. Uczynić forced GPU fail-closed i zachować requested/resolved/fallback na każdej ścieżce run/live/interactive/hysteresis.
3. Ustanowić jeden kanoniczny kontrakt termiki i jeden kontrakt anizotropii.
4. Ujednolicić energię, pola i torque z jednostkami oraz kompletnym `E_total`.
5. Zdefiniować i zaimplementować stage-time/history policy dla wszystkich integratorów i źródeł.
6. Rozdzielić capability single-grid/multilayer, CPU/CUDA, FP64/FP32, fixed/adaptive i active interactions.
7. Domknąć authoring oraz round-trip albo jawnie usunąć/deferować niebezpieczne kontrolki.
8. Zbudować zarządzaną walidację fizyczną oraz macierz artefaktów produkcyjnych.

### 12.2. Funkcje niezaimplementowane lub niepubliczne

- pełny solver prądu Ohmic Poisson i spin drift-diffusion/SHE;
- magnetoelastic FDM osiągalne przez publiczny planner;
- naturalne DMI boundary i jawny interface-region contract;
- adaptive multilayer;
- PG-BB/NCG multilayer;
- PBC multilayer;
- STT/SOT/Oersted/thermal multilayer;
- pełny device-resident CUDA-assisted multilayer;
- stiff/implicit time-domain solver FDM;
- produkcyjny FDM eigensolver i frequency-response backend;
- integrator SDE o zamrożonym kontrakcie dla termiki;
- pełny browser authoring PBC/thermal/torques;
- browser artefact explorer;
- rzeczywisty browser E2E uruchamiający FDM CPU i CUDA.

### 12.3. Dług dokumentacyjny

Dokumenty fizyczne nie mogą być używane jako aktualna lista gotowości bez ponownej synchronizacji:

- `0200-llg-exchange-reference-engine.md` nadal opisuje CUDA jako deferred;
- `0400-fdm-exchange-demag-zeeman.md` deklaruje szerokie domknięcie, ale jednocześnie odkłada periodic/multilayer/single precision;
- checklisty `0420`, `0440`, `0460`, `0480` są w dużej części puste mimo istniejącego kodu;
- `0500-fdm-relaxation-algorithms.md` poprawnie pozostawia multilayer PG-BB/NCG otwarte;
- `0550-fdm-sub-cell-staircase-correction.md` nie odzwierciedla istniejącego, ale wadliwego T0/T1;
- `0710-fdm-magnetoelastic-small-strain.md` sugeruje wykonanie CPU, którego publiczny planner nie osiąga;
- `0800-fdm-sot.md` opisuje CPU-only mimo źródła CUDA, a równanie zachowuje błąd wymiarowy;
- `0920-regional-time-domain-field-drive.md` pozostaje w toku;
- `0960-canonical-llg-time-domain-solver-and-qualification-contract.md` ma otwarte checkboxy FDM/Python/IR/UI.

Po naprawach checklisty muszą wskazywać dokładny poziom: source, executable, validated albo production. Nie należy po prostu zaznaczyć wszystkiego na podstawie obecności kernela.

---

## 13. Ocena walidacji i testów

### 13.1. Istniejące testy natywne

`backends/fdm/CMakeLists.txt` rejestruje m.in. source-layout, multilayer ABI, region-owned ABI, periodic exchange FP32, LLG time policy, smoke context, exchange/Heun parity, tier A CPU↔GPU, tier B FP64↔FP32, adaptive error, stats, batched FFT, async snapshot i multilayer create.

Najmocniejsze testy numeryczne są nadal wąskie:

- tier A: ręcznie napisany, lokalny oracle exchange/Heun kontra surowe ABI GPU na `8×8×4` przez 100 kroków; nie jest to parity z aktywnym `crates/fullmag-engine`;
- tier B: ograniczony exchange FP64 kontra FP32;
- time-policy: kontrakt API i złote skalary, nie pełne trajektorie wielofizyczne;
- wiele testów źródłowych sprawdza nazwy/układ, nie wynik aktywnego grafu.

Istnieje dodatkowe ryzyko fałszywie zielonego CTest: szereg testów GPU zwraca kod `0`, gdy urządzenie jest niedostępne, a CMake nie oznacza tego jako skip przez `SKIP_RETURN_CODE`/`SKIP_REGULAR_EXPRESSION`. Zielony wynik może więc oznaczać brak wykonania GPU. Każdy gate musi publikować licznik rzeczywiście wykonanych device cases i failować, gdy wymagany lane został pominięty.

Nie istnieje zestaw gate'ów udowadniający każdy legalny, deklarowany profil capability. Nie należy wymagać pełnego iloczynu kartezjańskiego: kombinacje nielegalne lub fizycznie bezsensowne powinny mieć test odrzucenia, a kombinacje legalne — celowane workloady numeryczne.

### 13.2. PBC production gate

`just verify-fdm-pbc-production` uruchamia testy Rust oraz walidator manifestu artefaktów. W tym audycie:

- 14 testów periodic engine przeszło;
- 2 testy plan FDM PBC przeszły;
- 1 test runner stale workspace przeszło;
- końcowy walidator **nie przeszedł**, ponieważ brakowało 14 wymaganych wyników przypadków.

Brakujące wyniki obejmowały FDM CPU double standard/T0/T1, CUDA double standard i T0/T1 seam, CUDA single FP32 seam, **CPU double multilayer oraz CUDA double/single multilayer**, a także image-budget overflow; manifest zawierał również brakujące przypadki FEM. Zielone podtesty nie zamykają więc gate'u produkcyjnego.

### 13.3. µMAG Standard Problem 4

`tests/stdprob4_dynamics.py` odtwarza geometrię `500×125×3 nm`, materiały, relaksację, dwa pola i zapisuje `m_avg(t)` oraz pierwszy próbkowany stan po `mx<=0`. Brakuje jednak:

1. lokalnych, wersjonowanych danych referencyjnych NIST/OOMMF z checksumami;
2. porównania podpisanych pełnych trajektorii `mx,my,mz` dla obu przypadków;
3. wspólnego wyznaczenia pierwszego przejścia `mx=0` i odpowiadającej mapy;
4. zbieżności siatkowej i czasowej;
5. parity CPU double → CUDA double → CUDA single;
6. tolerancji akceptacyjnych wynikających z zespołu referencyjnego, a nie jednego endpointu.

Skrypt jest wartościowym workloadem startowym, ale nie jest certyfikacją NIST.

### 13.4. Wymagana drabina dowodu

Każda rodzina powinna przejść kolejno:

1. kontrakt równań, znaków, jednostek i boundary conditions;
2. test operatora względem analitycznego/manufactured oracle;
3. energy–field finite-difference derivative check dla składników konserwatywnych;
4. test mask/region/PBC/partial-cell;
5. test integratora rzędu i stage-time;
6. CPU-reference double oracle;
7. CUDA FP64 parity;
8. CUDA FP32 kwalifikację z osobnymi tolerancjami;
9. single-grid i multilayer, native i assisted;
10. publiczny Python/IR/planner/runtime round-trip;
11. API quantities/provenance;
12. UI authoring i browser E2E;
13. wydajność, pamięć, rezydencję i długie przebiegi;
14. workloady oficjalne: co najmniej µMAG SP1/SP2/SP3/SP4 odpowiednio do zakresu.

---

## 14. Świeże dowody wykonane podczas audytu

| Komenda | Wynik | Co dowodzi / czego nie dowodzi |
|---|---|---|
| `env CARGO_TARGET_DIR=/tmp/fullmag-codex-fdm-audit-target cargo test -p fullmag-plan --lib fdm --no-fail-fast` | **48 passed** | wybrane kontrakty plannera FDM; nie runtime native |
| `env CARGO_TARGET_DIR=/tmp/fullmag-codex-fdm-audit-target cargo test -p fullmag-runner --lib fdm:: --no-fail-fast` | **75 passed**, 487 filtered | moduły/testy FDM runnera w tej konfiguracji; nie dowód GPU execution |
| `env PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_api.py` | **254 passed**, 39 warnings | publiczne API Python objęte tym plikiem; nie wykrywa braku wariantów Rust IR dla anizotropii |
| `env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/shared/domain/physics/interactions.test.ts src/modules/inspector/panels/PhysicsInteractionPanelModel.test.ts src/modules/inspector/panels/StudyStageAuthoringModel.test.ts src/modules/inspector/panels/StudyInspectorPanel.test.tsx` | **4 files, 98 tests passed** | bieżące modele UI; nie rzeczywisty browser/runtime round-trip |
| `env TMPDIR=/tmp corepack pnpm --dir apps/control-room check:api-hygiene` | **passed** | brak zakazanych bezpośrednich ścieżek/fetch według bieżącej reguły governance; nie dowód semantyki endpointów |
| celowane Vitest: generated OpenAPI contract, `ControlRoomApi`, study resources, 8 codec suites i FDM viewport adapter | **12 files, 170 tests passed** | transport/resource/codec/adapter contract; nie browser ani solver runtime |
| `env TMPDIR=/tmp corepack pnpm --dir apps/control-room typecheck` | **passed** | bieżący TypeScript; nie build produkcyjny |
| `env TMPDIR=/tmp corepack pnpm --dir apps/control-room lint` | **passed, zero warnings** | statyczna jakość frontend; nie runtime behavior |
| backend `--print-openapi-v2` do `/tmp` + `cmp` z checked-in `openapi-v2.json` | **failed: drift** | świeży schema ma `remove_field_drive`, checked-in JSON go nie ma; generated-contract test nie jest pełnym drift gate |
| `env CARGO_TARGET_DIR=/tmp/fullmag-codex-fdm-audit-target just verify-fdm-pbc-production` | podtesty Rust przeszły, final **failed: 14 missing case results** | gate produkcyjny PBC pozostaje otwarty |
| `nvidia-smi` | **failed: GPU access blocked** | brak świeżego dowodu CUDA runtime w tym środowisku |

Pierwsza próba UI przez surowe `pnpm` nie wystartowała, ponieważ binarka nie była w PATH. Powtórzenie przez repozytoryjny Corepack zakończyło się powodzeniem. Hostowe `cmake` nie jest dostępne; nie przedstawiono hostowego substytutu jako dowodu native.

---

## 15. Plan wdrożenia — 19 etapów

Kolejność jest celowa. Etapy 0–4 stabilizują kontrakt i legalność; 5–14 naprawiają numerykę; 15–17 domykają ABI/API/UI; etap 18 kwalifikuje wydanie. Każdy etap kończy się dowodem, nie samą obecnością kodu.

### Etap 0 — zamrożenie kontraktu i ledger ustaleń

**Cel:** zdefiniować jedną prawdę dla równań, znaków, jednostek, energii, boundary conditions, maski, czasu etapów i statusów.

**Prace:**

- zaktualizować odpowiednie `docs/physics/*` przed kodem;
- utworzyć ledger interaction/integrator z właścicielem CPU-reference, CUDA, multilayer i public surfaces;
- rozstrzygnąć `gamma`/`gamma_mu0`, SOT jako field albo direct torque, bulk DMI sign, energy weighting, thermal SDE i accepted-step RNG;
- przypisać każde ustalenie z sekcji 10 do testu akceptacyjnego.

**Wyjście:** review fizyki i kompletna tabela bez „TBD” dla P0.

### Etap 1 — jeden aktywny graf i jedno źródło własności

**Cel:** usunąć dwie pozorne architektury runnera.

**Prace:**

- zinwentaryzować `solvers/*`, `solver_runtime/*`, `execute.rs`, split `native/*` względem aktywnego grafu;
- przenieść użyte fragmenty po stabilnych granicach albo usunąć osierocone kopie;
- powiązać source-layout tests z faktycznie kompilowanymi translation units;
- ograniczyć `dispatch.rs` do orkiestracji, nie duplikacji numeryki.

**Wyjście:** automatyczny test grafu modułów/CMake i brak zdublowanego właściciela funkcji.

### Etap 2 — forced execution i provenance fail-closed

**Cel:** jawny GPU nigdy nie przechodzi cicho na CPU.

**Prace:**

- połączyć resolver registry i resolver wykonawczy w jeden wynik z engine oraz fallback trail;
- wyprowadzać forced-device intent z typowanego `requested_device != auto`; nie używać zbiorczego `explicit_selection`, które może stać się true po samej zmianie `cpu_threads`;
- odrzucać nieznane execution values i błędny GPU index;
- propagować requested/resolved backend, device, precision, mode, worker, engine i fallback do każdej ścieżki batch/live/interactive/hysteresis.

**Testy:** GPU unavailable: `auto` → CPU z provenance; forced GPU → błąd; żadna ścieżka nie gubi trail.

### Etap 3 — kanoniczny Python/IR dla energii i termiki

**Cel:** bezstratny Python → JSON → Rust IR → Python.

**Prace:**

- najpierw ujednolicić physics note i publiczny model anizotropii, następnie utrzymać ją jako własność materiału/regionu albo formalnie dodać warianty energii wraz z regułą konfliktu;
- zastąpić `ThermalNoise` + `Problem.temperature` jednym thermal config z `temperature`, `seed/RNG policy` i konwencją stochastyczną; integrator pozostaje w `DynamicsIR` i jest cross-validowany;
- dodać migracje i jasne błędy dla starych skryptów;
- usunąć martwe `allow_single_grid_fallback` albo nadać mu realnego konsumenta.

**Testy:** Python serialize, Rust deserialize/validate/serialize, script export/import i conflict cases.

### Etap 4 — lane-aware planner i capability model

**Cel:** trzy jawne warstwy capability ze wspólnym słownikiem: host/runtime availability, intrinsic engine support oraz session/plan legality.

**Prace:**

- modelować w session resolverze layout/device/precision/mode/integrator/interactions/PBC/time dependence;
- usunąć ręczne, przeterminowane `supported_terms` i globalną listę relaksacji;
- poprawić CPU Oersted capability, thermal/magnetoelastic status oraz multilayer scopes;
- uczynić strict fail-closed; każda degradacja wymaga własnego typowanego opt-in i provenance, a nie ogólnego trybu `extended`.

**Wyjście:** ten sam reason code z jednego resolvera w planner error, session-scoped legality owner i UI; `/platform/capabilities` pozostaje inwentarzem hosta, nie drugim źródłem legalności planu.

### Etap 5 — exchange standard, regiony i T0/T1

**Cel:** poprawny operator i energia dla standard/T0/T1.

**Prace:**

- naprawić `A²`, zerowanie output i wspólny prefactor;
- zaimplementować rzeczywiste T0/T1 FP32 wraz ze spójną energią albo zablokować ten profil w plannerze/ABI;
- wprowadzić jedną regułę harmonic/explicit/disabled inter-region exchange;
- uczynić unsupported SDF fail-closed;
- rozstrzygnąć PBC seam dla T0/T1;
- ujednolicić volume/face weighting wszystkich energii partial-cell.

**Testy:** manufactured Laplacian, energy derivative, cylinder/ring, unsupported shape, region interface, PBC seam, FP64/FP32 parity.

### Etap 6 — demag Newell i PBC

**Cel:** jeden poprawny operator demag dla wszystkich legalnych lane'ów.

**Prace:**

- albo zakończyć GPU auto-Newell FFT/upload, albo usunąć fallback ABI i wymagać widm;
- walidować rozmiary/symetrię widm i nie oznaczać pustego kernela jako gotowy;
- zamknąć thin-film 2D, 3D, odd/even grid i self-term;
- dodać volume-fraction/sparse correction do demag FP32 albo jawnie odrzucać sub-cell FP32;
- ukończyć FP32 PBC seam i image-budget behavior.

**Testy:** analytic prism/self-term, direct-sum small grid, CPU↔CUDA, mesh convergence i cały manifest PBC.

### Etap 7 — DMI: znak, granice, normalna i regiony

**Cel:** jeden wariacyjny kontrakt iDMI/bulk DMI.

**Prace:**

- naprawić znak bulk CUDA;
- implementować natural boundary condition;
- przenieść `interface_normal` do planu/kernela albo odrzucić nieobsługiwaną normalną;
- zdefiniować DMI na granicy obiektów/regionów i wykluczyć przypadkowe sprzężenie;
- opublikować `H_dmi`, `e_dmi`, `E_dmi` w każdym legalnym lane.

**Testy:** helisa/chiral texture, energy derivative, normal reversal, boundary manufactured case, region isolation, PBC.

### Etap 8 — anizotropie i pola materiałowe

**Cel:** parity CPU/CUDA i jawny zakres spatial materials.

**Prace:**

- dodać `Kc3` do CPU-reference albo bramkować go;
- zdecydować, które `Ku/Kc/axis` fields są publiczne i zaimplementować je end-to-end;
- walidować osie zerowe/nieortogonalne oraz normalizację;
- ujednolicić energy densities/scalars i partial-cell weighting.

**Testy:** easy/hard axis, cubic minima, Kc3-specific oracle, spatial step, energy derivative.

### Etap 9 — termika i poprawny kontrakt SDE

**Cel:** reprodukowalny Brown field na CPU/CUDA.

**Prace:**

- naprawić wspólną CPU materialization dla temperatury, thermal `dt`, spatial `Ms/A/alpha` i resolved periodic workspace;
- przekazywać faktyczny `dt` do CUDA na każdej próbie;
- zamrozić konwencję `gamma_mu0`/`mu0`;
- przenieść 64-bit seed/counter przez IR i ABI;
- określić, czy odrzucona próba adaptive zużywa licznik i jak współdzielony jest szum między etapami;
- określić dozwolone integratory stochastyczne.

**Testy:** deterministyczny replay, variance vs `T`, `Ms`, volume i `dt`, equilibrium distribution, CPU↔CUDA statistics, rejected-step replay.

### Etap 10 — STT, SOT, current transport i Oersted

**Cel:** poprawne jednostki, maska, PBC, geometria i stage-time.

**Prace:**

- naprawić SOT field-to-torque scaling i postać Gilberta;
- dodać active mask/region/PBC do wszystkich torque stencil;
- ustalić znak prądu i polarisation conventions;
- zaimplementować dowolną oś cylindra albo ograniczyć IR do `z`;
- wykonać źródła w `t_n+c_i dt`;
- nazwać prescribed current jako źródło, nie pełny transport;
- pozostawić Ohmic/SHE jako unsupported do osobnego physics note i solvera.

**Testy:** inactive cells, current reversal, macrospin analytic torque, domain-wall motion, rotated cylinder, RK time-convergence.

### Etap 11 — kompletna energia, fields, torque i telemetry

**Cel:** `E_total` i opublikowane quantities odpowiadają rzeczywistemu RHS.

**Prace:**

- poprawić Zeeman multilayer factor;
- dodać generalized external/Oersted i regional drive do energii;
- ujednolicić StepStats oraz snapshot;
- rozdzielić `H_* [A/m]` od `tau_* [1/s]`;
- dodać brakujące `H_dmi`, `H_therm`, `H_mel` albo jawny unsupported;
- zdefiniować per-object/per-region scalars.

**Testy:** `E_total == sum(E_i)`, finite-difference derivative, dynamic-vs-snapshot identity, CPU/CUDA/multilayer parity.

### Etap 12 — integrator lifecycle i adaptacja

**Cel:** poprawna metoda dla autonomicznych i nieautonomicznych problemów.

**Prace:**

- centralny stage-time context dla Heun/RK4/RK23/DP45;
- jawna invalidacja FSAL/ABM po uploadzie, zmianie źródła, odrzuconym kroku i zmianie `dt`;
- stream/event ownership dla FFT, RHS, error reduction i snapshot;
- jedna polityka abs/rel tolerances, `dt_min`, rejected step i guard intent;
- zakaz/obsługa discontinuous sources z ABM3.

**Testy:** manufactured non-autonomous ODE order, event boundary, upload/restart equivalence, adaptive rejection, stream race sanitizer.

### Etap 13 — relaksacja, direct minimizers i histereza

**Cel:** każdy algorytm minimalizuje ten sam kanoniczny funkcjonał.

**Prace:**

- po naprawie energii sprawdzić PG-BB/NCG line search;
- ujednolicić torque/energy stopping criteria i jednostki;
- zabezpieczyć batch-only vs interactive capability;
- dodać restart/checkpoint i deterministyczne historie;
- walidować histerezę względem Stoner–Wohlfarth i znanych przypadków.

**Testy:** monotonic energy where required, gradient check, convergence basin, CPU/CUDA parity, hysteresis loop metrics.

### Etap 14 — multilayer jako jawne profile

**Cel:** poprawny, mierzalny native-stacked oraz assisted, bez udawanej równoważności.

**Prace:**

- naprawić Zeeman i międzyobiektowe DMI;
- zdefiniować transfer demag dla offsetów/grubości/niezgodnych gridów;
- dodać regiony obiektowe i per-layer observables;
- etapowo dodać adaptive, PG-BB/NCG, PBC, thermal i torque tylko po osobnych kwalifikacjach;
- publikować transfer count, residency i realization ID.

**Testy:** dwa makrospiny, ferro/antiferro coupling, separated films demag, offsets, layer permutation, native-vs-assisted parity.

### Etap 15 — ABI, rezydencja i wydajność

**Cel:** stabilny kontrakt C i rzeczywista wydajność GPU.

**Prace:**

- oddzielić status success/warning/error od `last_error`;
- walidować wszystkie wskaźniki, długości, indeksy i enum;
- usunąć magiczne allowlisty tekstów;
- konfigurować CUDA architectures przez toolchain/just;
- dodać profiler faz, transferów, FFT i pamięci;
- ograniczyć host round-trips w assisted lane bez zmiany fizyki.

**Wyjście:** ABI versioning test, ASan/UBSan dla host wrappera i buildowego ABI stubu, cuda-memcheck/sanitizer, długie przebiegi bez wzrostu pamięci.

### Etap 16 — resource-first API i OpenAPI

**Cel:** legality/quantities/artifacts jako session-scoped resources, przy zachowaniu `/platform/capabilities` jako host inventory.

**Prace:**

- najpierw zmienić spec/ADR i wybrać jednego ownera session gating: wzbogacone `status.capabilities` albo preferowany osobny plan-legality resource z cienkim revision pointerem w statusie;
- podłączyć `/platform/capabilities` do facade wyłącznie jako host inventory/discovery;
- publikować requested/resolved wszystkie wymiary i reason codes;
- naprawić run-level status reason;
- usunąć `as never` przez typowane operacje;
- ustalić owner/removal gate dla `preview_cache`;
- scalić `artifact_revision`/`artifacts_revision` do jednej semantyki content/provenance revision, użyć jej w realtime i ETag;
- promować artifact list, metadata i download do facade/hooks dopiero po naprawie invalidacji;
- generować OpenAPI do katalogu tymczasowego i porównywać z checked-in JSON/types/client w CI.

**Testy:** OpenAPI generated contract, facade coverage, revision/invalidation, binary codec, unsupported states.

### Etap 17 — pełny Control Room authoring i round-trip

**Cel:** UI jest pierwszoklasowym autorem tego samego ProblemIR.

**Prace:**

- naprawić field drive rewrite;
- ustanowić jeden wersjonowany i typowany schema overrides współdzielony przez Rust adapter, Python adapter oraz renderer;
- naprawić round-trip backend/device/precision/mode oraz globalnego `solver.relax`;
- dodać pierwszoklasowe zasoby PBC, thermal/seed i torque albo usunąć kontrolki do czasu wsparcia;
- dodać RK4/ABM3 i lane-aware gating/reasons;
- pokazać single/multilayer oraz native/assisted restrictions;
- wyświetlać resolved precision/mode/realization/fallback;
- dodać Results artifact browser;
- każdy semantic Explorer node musi mieć własny Inspector.

**Testy:** equivalence Rust/Python adapterów; każda właściwość override rzeczywiście konsumowana przez renderer; UI transaction → model sync → Python export → parse → ProblemIR equality; naprawiony realny browser smoke bez stałych „round-trip”; hydration i browser a11y; FDM viewport WebGL smoke.

### Etap 18 — kwalifikacja produkcyjna i release gate

**Cel:** przejść od „wykonywalne” do „produkcyjne”.

**Prace:**

- zbudować repo-owned managed `just` gate dla CPU double, CUDA double i CUDA single;
- zbudować osobne gate'y dla każdej deklarowanej capability row/lane; w każdym objąć jego legalne interakcje, integratory, fixed/adaptive, mask/regions/PBC/T0/T1, thermal/torques albo multilayer, a kombinacje nielegalne pokryć testami odrzucenia;
- uruchomić pełne frontend typecheck/lint/test, API hygiene, generated OpenAPI drift check, resource/codec tests i browser smoke na rzeczywistym runtime;
- zmienić brak GPU w wymaganym native teście na jawny skip/fail i publikować liczbę faktycznie wykonanych device cases;
- dodać pełny NIST µMAG SP4: trajektorie, pierwsze `mx=0`, mapy i zbieżność;
- dodać pozostałe standard problems/manufactured oracles;
- uruchomić browser E2E dla CPU i CUDA;
- ustalić tolerancje, performance budgets i długie soak runs;
- dopiero po przejściu gate zaktualizować capability status i checklisty docs.

**Wyjście:** kompletne, wersjonowane artefakty z checksumami dla każdej promowanej capability row; zero missing cases w jej manifeście; odpowiedni CPU↔GPU parity; jawny status `validated/production` tylko dla dokładnie zakwalifikowanych lane'ów, bez blokowania gotowego profilu przez niezależną funkcję deferred.

---

## 16. Kryteria zamknięcia całego programu

Program można uznać za zakończony dopiero, gdy jednocześnie:

1. żadne P0/P1 z rejestru nie pozostaje otwarte dla lane'u oznaczonego publicznym;
2. Python i UI round-tripują do identycznego ProblemIR;
3. planner, runtime, API i UI zwracają ten sam legality status/reason;
4. forced GPU failuje bez GPU, a auto fallback jest widoczny;
5. `E_total`, fields i torque mają kompletne jednostki i testy pochodnej;
6. wszystkie pięć integratorów przechodzi test rzędu i lifecycle w swoim zadeklarowanym profilu;
7. thermal przechodzi testy statystyczne i reprodukowalności;
8. single-grid i każdy osobno reklamowany profil multilayer mają własny gate;
9. CPU double → CUDA double → CUDA single ma jawne tolerancje;
10. `just verify-fdm-pbc-production` kończy się zero missing cases;
11. pełny kontrakt NIST SP4 przechodzi dla zakwalifikowanych lane'ów;
12. browser E2E dowodzi authoring → run → fields/scalars/artifacts → viewport/chart;
13. dokumentacja i capability matrix są generowane lub sprawdzane względem tego samego rejestru;
14. nie ma niepodłączonego kodu przedstawianego jako aktywna funkcja;
15. raport wydaniowy rozróżnia `implemented`, `executable`, `validated` i `production`.

---

## 17. Ostateczna ocena

FDM Fullmag nie jest atrapą: ma duży aktywny rdzeń CPU/CUDA, realne ABI, integratory, multilayer, resource-first publikację i działające powierzchnie analizy. Jednocześnie szerokość implementacji wyprzedziła spójność kontraktu. Największe ryzyko nie polega na pojedynczym brakującym kernelu, lecz na rozjechaniu pięciu źródeł prawdy: Python/IR, planner/capabilities, CPU/CUDA, energia/telemetria oraz UI/export.

Prawidłowy bieżący komunikat produktowy brzmi:

> **FDM CPU-reference i CUDA są zaimplementowane oraz częściowo wykonywalne; wybrane kontrakty są przetestowane. Cały solver FDM, szczególnie CUDA FP32, termika, torque, T0/T1 i multilayer, nie jest jeszcze produkcyjnie zakwalifikowany.**

Najkrótsza bezpieczna droga nie polega na dodawaniu kolejnych funkcji. Najpierw trzeba zamrozić fizykę, usunąć P0, ujednolicić legalność i quantities, a dopiero potem wypełnić macierz multilayer/UI i uruchomić pełną kwalifikację.
