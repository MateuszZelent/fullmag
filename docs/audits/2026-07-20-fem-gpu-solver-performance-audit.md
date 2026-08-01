# Audyt wydajności FEM GPU: solver, host, API i telemetria

- Data audytu: 2026-07-20
- Repozytorium: Fullmag
- Gałąź: <code>master</code>
- Rewizja: <code>bb46eac50415096d1805b30bab836f1260308863</code>
- Stan rewizji względem zdalnego repozytorium: <code>HEAD == origin/master</code>

## 1. Cel i zakres

Celem audytu było ustalenie:

1. czy obecny solver FEM GPU daje rzeczywisty zysk względem poprzedniej implementacji i CPU,
2. dlaczego wykorzystanie RTX 4080 pozostaje niskie,
3. czy czas widoczny jako <code>Gap</code> jest sztucznie doliczany,
4. czy API, Control Room, publikowanie postępu, preview lub zapis artefaktów blokują solver,
5. czy w natywnym solverze NCG, demagnetyzacji HYPRE, konfiguracji CUDA i warstwie Rust pozostały istotne możliwości optymalizacji,
6. czy istniejące testy i bramki wydajności utrwalają nieoptymalne rozwiązania albo pozwalają na fałszywie dodatni wynik.

Audyt obejmuje pełną ścieżkę:

<code>Control Room → API/runtime → callback kroku → StepUpdate → Rust FFI → FEM CUDA NCG → demag Poisson → MFEM/HYPRE → GPU → artefakty i live publisher</code>.

Audyt jest diagnostyczny. Nie zmienia fizyki, kodu solvera ani ustawień produkcyjnych. Wnioski oznaczono jako:

- **potwierdzone pomiarem** – wynik pochodzi z kontrolowanego uruchomienia lub z podanego śladu,
- **potwierdzone kodem** – zachowanie wynika bezpośrednio z aktualnego źródła,
- **silna hipoteza** – kod wskazuje wiarygodne źródło kosztu, ale nie ma jeszcze profilu CPU/Nsight rozdzielającego ten koszt,
- **do kwalifikacji** – możliwa optymalizacja, której nie wolno promować bez testów poprawności i stabilnego benchmarku.

## 2. Werdykt wykonawczy

### 2.1 Odpowiedź krótka

Tak, obecna wersja jest rzeczywiście szybsza, ale nadal pozostawia duży potencjał:

- wcześniejsza optymalizacja zmniejszyła medianę raportowanego czasu kroku z **711,6 ms do 231,5 ms**, czyli **3,07×** dla próbek profilera,
- rzeczywista przepustowość zaakceptowanych kroków wzrosła z około **1,25 do 3,06 kroku/s**, czyli **2,44×** w całym obserwowanym przedziale,
- w kontrolowanym benchmarku 64-krokowym GPU było **1,777×** szybsze od CPU end-to-end, a samo demag HYPRE **2,557×** szybsze,
- GPU nie jest obecnie fałszywie zgłaszane jako używane: demagnetyzacja działa przez HYPRE na urządzeniu, dane stanu pozostają na GPU, a profil wykazuje transfery sterujące zamiast pełnych kopii pola na hosta.

Jednocześnie niskie użycie GPU jest realne. W świeżym śladzie <code>nvidia-smi dmon</code> aktywne próbki miały średnio **35,6% SM**, maksimum **42%**, kontroler pamięci **0%**, średnią moc **56,2 W** i maksimum **66 W** przy limicie 320 W. Ten pomiar nie jest miarą occupancy, ale pokazuje, że obciążenie nie nasyca ani czasu GPU, ani przepustowości pamięci.

### 2.2 Najważniejsze przyczyny

W kolejności priorytetu:

1. **P0 – bundle produkcyjny Fullmag zawiera kod CUDA skompilowany dla <code>sm_52</code>, nie dla RTX 4080 / <code>sm_89</code>.** Normalny build CMake w tym samym repo tworzy <code>sm_89</code>, lecz ścieżka eksportu przez <code>fullmag-fem-sys/build.rs</code> gubi <code>CMAKE_CUDA_ARCHITECTURES</code>. Walidator bundle tego nie sprawdza.
2. **P0 – około 115–127 ms/krok w typowych przedziałach jest prawdziwym czasem hosta poza zakresem aktualnych faz <code>StepStats</code>.** <code>Gap</code> nie jest wymyślony, ale interfejs prezentuje sumę dla kilkunastu kroków przy jednym wierszu, przez co metryka jest myląca.
3. **P0 – pełny payload siatki FEM jest normalizowany, haszowany i klonowany przy każdym callbacku kroku.** Potem cały <code>StepUpdate</code> jest kopiowany kolejne razy przez offset, heartbeat i live workspace. To jest najsilniejsze, źródłowo potwierdzone wyjaśnienie stałego kosztu CPU poza solverem.
4. **P0 – przepustowość w API jest liczona błędnie.** Średnia używa tylko próbkowanych <code>total_ns</code>, ignoruje <code>Gap</code> i długość przedziału. Fallback dzieli całkowitą liczbę kroków przez czas jednego ostatniego kroku.
5. **P1 – domyślny profil BoomerAMG <code>relax_type=18</code> nie jest najlepszy dla zmierzonej siatki.** W kontrolowanym teście <code>relax_type=6</code> zmniejszył liczbę iteracji 40→20 i koszt GPU demag 61,76→46,93 ms.
6. **P1 – NCG nadal synchronizuje cztery skalary sterujące na krok.** Jeden readback energii jest źródłowo redundantny z następującą po nim oceną Armijo; realistycznym celem jest zejście do trzech synchronizacji na akceptowany krok bez zmiany fizyki.
7. **P1 – GPU NCG jest niepreconditioned, podczas gdy CPU używa preconditionera exchange-mass.** To może zmniejszyć liczbę kroków i prób Armijo, ale wymaga urządzeniowej realizacji oraz oceny czasu do tolerancji, a nie tylko czasu pojedynczego kroku.
8. **P1 – preview/cache okresowo kosztuje około 79 ms.** To koszt jawnie ujęty w kroku, nie w <code>Gap</code>. Kadencja FEM co 10 kroków może tworzyć piki i powinna być odseparowana od krytycznej ścieżki solvera.
9. **P2 – sam problem Poissona jest mały: około 1210 węzłów i 22–76 iteracji.** PCG/AMG składa się z sekwencji krótkich jąder, redukcji i małych poziomów coarse-grid. RTX 4080 nie ma tutaj dość równoległej pracy, aby osiągnąć wysokie occupancy.

### 2.3 Czy CPU/API jest błędem architektonicznym?

Częściowo tak.

Nie jest błędem, że CPU steruje uruchomieniem, propaguje stan sesji i obsługuje artefakty. Błędem jest umieszczenie kosztownych, niezmiennych operacji danych w callbacku każdego kroku:

- ponowne tworzenie i haszowanie siatki,
- wielokrotne głębokie klonowanie <code>StepUpdate</code>,
- kopiowanie pełnego compatibility payload mimo że top-level mesh jest później tłumiony,
- synchroniczne przygotowanie snapshotu pod blokadą.

Sieć i HTTP są wykonywane w tle, więc sama przeglądarka nie jest głównym synchronicznym bottleneckiem. Krytyczną ścieżkę obciąża jednak przygotowanie danych dla API, zamiana snapshotu i kontencja na mutexach jeszcze przed wysłaniem.

## 3. Stan repozytorium i ograniczenia dowodu

### 3.1 Stan źródła

Audyt wykonano na:

- <code>bb46eac5 perf(fem): keep GPU demag relaxation device-resident</code>,
- poprzedzonym przez <code>d400b6bb build: qualify upgraded FEM GPU solver stack</code>.

W drzewie roboczym były istniejące, niezwiązane zmiany użytkownika:

- <code>external_solvers/3</code>,
- <code>tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py</code>.

Audyt ich nie zmienia.

### 3.2 Co zostało zweryfikowane

- ślad przed i po optymalizacji dostarczony przez użytkownika,
- dwa zarządzane benchmarki FEM CPU/GPU uruchomione przez kontenerowe receptury repozytorium,
- konfiguracja MFEM 4.9, HYPRE 3.1.0, libCEED 0.12.0 i CUDA 12.4.1 w obrazie,
- konfiguracja i reużycie HYPRE na GPU,
- liczba synchronizacji sterujących CPU/GPU,
- ścieżka callbacku, profilera, live publishera, API i artefaktów,
- zawartość architektur CUDA w załadowanym bundle oraz w normalnym buildzie CMake,
- próbki <code>nvidia-smi dmon</code>.

### 3.3 Czego wynik jeszcze nie dowodzi

- Nie wykonano pełnego Nsight Systems ani Nsight Compute, więc nie ma jeszcze rozbicia occupancy, launch latency, czasu redukcji i poziomów AMG.
- Nie ma kontrolowanego A/B bundle <code>sm_52</code> kontra <code>sm_89</code> w tej samej zarządzanej ścieżce wykonawczej.
- Nie ma profilu CPU z symbolami, który przypisałby całe 115–127 ms <code>Gap</code> do konkretnych funkcji. Kod ujawnia kilka mocnych źródeł, ale suma nie została jeszcze zmierzona per faza.
- Benchmark 32- i 64-krokowy wygenerował dwie różne siatki mimo identycznych nominalnych parametrów. Nie wolno z nich wyciągać precyzyjnych wniosków o skalowaniu między uruchomieniami.
- Przejście benchmarkowej kontroli CPU/GPU oznacza zgodność z obecną bramką, nie pełną kwalifikację naukową relaksacji.

## 4. Czy wcześniejsza optymalizacja dała rzeczywisty zysk?

### 4.1 Porównanie próbek profilera

| Metryka | Przed | Po | Zmiana |
|---|---:|---:|---:|
| liczba próbek | 6 | 9 | — |
| mediana <code>Total</code> | 711,55 ms | 231,50 ms | **3,074× szybciej** |
| mediana <code>Demag</code> | 594,40 ms | 162,30 ms | **3,662× szybciej** |
| mediana <code>Native</code> | 603,60 ms | 164,90 ms | **3,660× szybciej** |
| solve demag na krok | 2 | 1 | **−50%** |
| iteracje CG | 73–75 | 76 | zbliżone na solve |
| mediana przepustowości z <code>Δstep/Δwall</code> | 1,377 kroku/s | 3,193 kroku/s | **2,318×** |
| przepustowość całego obserwowanego okna | 1,251 kroku/s | 3,057 kroku/s | **2,443×** |

Różnica między przyspieszeniem <code>Total</code> 3,07× a przepustowością 2,44× jest ważna: <code>Total</code> nie obejmuje całego kosztu między callbackami. Po optymalizacji natywny solver jest znacznie szybszy, więc stały koszt hosta stanowi większy procent czasu end-to-end.

### 4.2 Co dokładnie przyspieszyło

Ślad pokazuje zmianę z dwóch solve demag na jeden solve na zaakceptowany krok. To odpowiada optymalizacji reużycia zaakceptowanego stanu demag przy dokładnie tym samym punkcie końcowym. Nie jest to nielegalny warm start pomiędzy odmiennymi próbami Armijo.

Wcześniej typowy krok poświęcał około 560–638 ms na dwie aplikacje demag. Obecnie jedna aplikacja zajmuje około 144–226 ms w śladzie interaktywnym. Jest to rzeczywista redukcja pracy, a nie tylko zmiana etykiety profilu.

## 5. Interpretacja <code>Delta wall</code>, <code>Gap</code>, <code>Total</code> i <code>Missing</code>

### 5.1 Jak profiler faktycznie liczy <code>Gap</code>

Kod <code>crates/fullmag-runner/src/solver_profile.rs:551-619</code>:

1. księguje <code>wall_time_ns</code> każdego kroku, także kroków niewyświetlanych,
2. publikuje próbkę dopiero po upływie skonfigurowanego interwału,
3. liczy <code>Delta wall</code> jako różnicę czasu zegarowego między dwiema próbkami,
4. liczy <code>Gap = Delta wall − suma Total wszystkich kroków w przedziale</code>.

Wniosek: <code>Gap</code> nie jest doliczany do jednego kroku i nie jest losową liczbą. Jest sumą całego czasu ściennego nieobjętego przez <code>StepStats</code> pomiędzy dwoma próbkami.

### 5.2 Dlaczego prezentacja jest myląca

Control Room pokazuje ten przedziałowy <code>Gap</code> w wierszu oznaczonym numerem ostatniego kroku. Użytkownik naturalnie odczytuje wtedy:

<code>krok 3422: Total 151 ms + Gap 1,92 s</code>,

choć prawidłowa interpretacja brzmi:

<code>pomiędzy próbkami 3406 i 3422 wykonano 16 kroków; ich zmierzone fazy zajęły łącznie około 3,09 s, a pozostałe operacje około 1,92 s</code>.

### 5.3 Rozbicie nowych przedziałów

| Przedział kroków | Δ kroków | Delta wall | Gap | średni profilowany czas/krok | średni Gap/krok |
|---|---:|---:|---:|---:|---:|
| 3288→3304 | 16 | 5,235 s | 1,960 s | 204,7 ms | 122,5 ms |
| 3304→3320 | 16 | 5,095 s | 2,030 s | 191,6 ms | 126,9 ms |
| 3320→3338 | 18 | 5,254 s | 2,080 s | 176,3 ms | 115,6 ms |
| 3338→3354 | 16 | 5,011 s | 1,900 s | 194,4 ms | 118,8 ms |
| 3354→3371 | 17 | 5,205 s | 1,940 s | 192,1 ms | 114,1 ms |
| 3371→3389 | 18 | 7,816 s | 4,680 s | 174,2 ms | 260,0 ms |
| 3389→3406 | 17 | 5,213 s | 1,950 s | 191,9 ms | 114,7 ms |
| 3406→3422 | 16 | 5,011 s | 1,920 s | 193,2 ms | 120,0 ms |

Typowy niewidoczny koszt wynosi zatem około **115–127 ms/krok**. Przedział 3371→3389 zawiera dodatkowy stall około 2,5 s względem typowego poziomu; bez monotonicznego śladu faz nie można rozstrzygnąć, czy był to system operacyjny, I/O, publikacja, API, alokacja czy inny proces.

### 5.4 Dwa problemy implementacyjne pomiaru

1. Decyzja o próbkowaniu używa monotonicznego <code>Instant</code>, ale <code>Delta wall</code> jest wyprowadzane z <code>sample_time_unix_ms</code>. Ma więc rozdzielczość 1 ms i może być zaburzone korektą zegara systemowego.
2. Próbka nie zapisuje początku przedziału, końca, liczby zaksięgowanych kroków ani sumy kosztów per faza dla całego przedziału. Pokazuje fazy tylko ostatniego kroku obok przedziałowego <code>Gap</code>.

### 5.5 Co oznacza <code>Missing=0</code>

<code>Missing=0</code> znaczy jedynie, że fazy przypisane do wybranego <code>StepStats</code> sumują się do jego <code>Total</code>. Nie znaczy, że profiler pokrywa całe wykonanie procesu między krokami. Dlatego możliwe i poprawne jest jednoczesne:

- <code>Missing=0</code>,
- około 120 ms <code>Gap</code> na każdy krok.

### 5.6 Wymagana naprawa telemetryczna

Próbka przedziałowa powinna zawierać co najmniej:

- monotoniczne <code>span_wall_time_ns</code>,
- <code>span_first_step</code>, <code>span_last_step</code>, <code>span_step_count</code>,
- sumę i średnią każdej fazy w przedziale,
- <code>unprofiled_gap_total_ns</code> i <code>unprofiled_gap_per_step_ns</code>,
- osobne fazy hosta opisane w sekcji 7,
- flagę, czy próbka pokrywa normalny krok, publish, preview, finalizację lub stall.

UI nie powinno łączyć faz ostatniego kroku z sumą całego przedziału bez widocznego oznaczenia.

## 6. Pełna ścieżka krytyczna jednego kroku

| Warstwa | Praca | Urządzenie/wątek | Objęta obecnym <code>Total</code>? | Ryzyko |
|---|---|---|---:|---|
| FEM CUDA NCG | gradient, kierunek, retraction, Armijo | GPU + sterowanie hosta | tak, głównie <code>Native</code> | synchronizacje skalarów |
| demag Poisson | RHS, CG/AMG, recovery, energia | GPU/HYPRE | tak | dominujący solve, mały problem |
| preview/cache | ekstrakcja pól i preview | GPU/host | tak | okresowe piki około 79 ms |
| utworzenie <code>FemMeshPayload</code> | normalizacja, SHA-256, serde i klony | CPU | **nie** | wykonywane co krok |
| callback Rust | offset, heartbeat, live state | CPU | częściowo <code>Orchestr</code> | wielokrotne deep clone |
| profiler JSONL i jego publish | serializacja, plik, snapshot | CPU/I/O | **po timerze Orchestr** | trafia do następnego <code>Gap</code> |
| snapshot live | klon stanu i merge pod mutexem | CPU | zależnie od miejsca wywołania | duży payload |
| HTTP sync | wysłanie delta/snapshot | worker CPU | nie blokuje bezpośrednio | pośrednia kontencja mutexu |
| artefakty pola/skalary | enqueue w solverze, zapis w workerze | CPU/I/O | enqueue tak, writer kumulacyjny | UI myli koszt |
| Control Room | refetch/render | przeglądarka | nie | może zwiększyć obciążenie API, nie wykonuje solve |

## 7. P0: koszt hosta i live API poza solverem

### 7.1 Pełna siatka jest tworzona przy każdym callbacku

Potwierdzenie:

- <code>crates/fullmag-runner/src/fem/relax/direct_minimizer.rs:118-132</code>,
- <code>crates/fullmag-runner/src/fem/relax/direct_minimizer.rs:238-252</code>.

Obie ścieżki tworzą:

<code>fem_mesh: Some(FemMeshPayload::from(plan))</code>

dla każdego kroku.

<code>FemMeshPayload</code> posiada własne wektory węzłów, elementów, ścian i markerów. Konwersja w <code>crates/fullmag-runner/src/types.rs:1454-1645</code> wykonuje:

1. normalizację markerów elementów,
2. SHA-256 po wszystkich węzłach, tetraedrach, ścianach i markerach,
3. serializację JSON struktur periodic pairs, segmentów, części siatki, frame i quality do haszowania,
4. klonowanie wszystkich tablic do nowego payloadu.

Siatka nie zmienia się pomiędzy krokami relaksacji. Wykonywanie tej operacji w hot loop nie ma uzasadnienia semantycznego.

### 7.2 Ten sam ciężki obiekt jest później klonowany wielokrotnie

Potwierdzone miejsca:

- <code>crates/fullmag-cli/src/step_utils.rs:141-151</code> – <code>offset_step_update</code> zaczyna od <code>update.clone()</code>,
- <code>crates/fullmag-cli/src/orchestrator.rs:2070-2079</code> – heartbeat ponownie klonuje cały update,
- <code>crates/fullmag-cli/src/orchestrator.rs:1256-1305</code> – live ingest klonuje update i buduje manifest,
- <code>crates/fullmag-cli/src/step_utils.rs:348-384</code> – manifest klonuje mesh, magnetyzację i pola,
- <code>crates/fullmag-cli/src/live_workspace.rs:56-118</code> – payload publish klonuje live state, a następnie dodatkowo top-level mesh.

Top-level mesh jest później tłumiony po <code>generation_id</code>, ale kopia compatibility nadal pozostaje wewnątrz sklonowanego <code>live_state.latest_step</code>. Optymalizacja na końcu pipeline nie usuwa kosztu poniesionego na początku.

### 7.3 Heartbeat nie publikuje co krok, ale przechowuje pełny update

Wątek heartbeat publikuje dopiero wtedy, gdy przez 5 s nie było kroku. Normalnie nie jest więc regularnym źródłem requestów. Jednak <code>StageProgressHeartbeat::record</code> przy każdym kroku klonuje i przechowuje cały <code>StepUpdate</code>, mimo że heartbeat potrzebuje głównie:

- numeru kroku,
- czasu,
- wybranych statystyk,
- informacji o zakończeniu.

To powinien być mały snapshot postępu, nie kopia siatki i pól.

### 7.4 Publikacja sieciowa jest asynchroniczna, przygotowanie payloadu nie

<code>CurrentLivePublisher</code> posiada osobny worker i throttling:

- 200 ms w trybie fast,
- 1000 ms podczas solvera,
- status UI odświeżany co 5000 ms.

Potwierdzenie:

- <code>crates/fullmag-session/src/communication_policy.rs:3-21</code>,
- <code>crates/fullmag-cli/src/live_workspace.rs:681-726</code>,
- <code>crates/fullmag-cli/src/live_workspace.rs:1554-1633</code>.

HTTP sam w sobie nie powinien czekać na krytycznej ścieżce solvera. Przed obudzeniem workera wykonywane są jednak synchronicznie:

- klon stanu pod <code>state</code> mutexem,
- budowa delta payload,
- estymacja rozmiaru,
- filtr scalar telemetry,
- merge pod mutexem kolejki publishera,
- aktualizacja diagnostyki.

Źródło: <code>crates/fullmag-cli/src/live_workspace.rs:182-188</code> oraz <code>755-790</code>.

Przeglądarka może pośrednio pogorszyć sytuację przez kontencję na tych samych zasobach API, ale nie jest konieczna do wystąpienia podstawowego kosztu klonowania.

### 7.5 Profilowanie jest zsynchronizowane z kadencją publikacji

Control Room włącza profiler z interwałem dokładnie 5000 ms i automatycznie włącza zapis artefaktu:

- <code>apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts:80-81</code>,
- <code>apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts:903-939</code>.

Live progress także ma kadencję 5 s:

- <code>crates/fullmag-cli/src/orchestrator.rs:1060-1099</code>.

Skutkiem jest bias próbek: wiersze widoczne w UI częściej reprezentują krok, na którym wykonuje się publish. W dostarczonym śladzie <code>Orchestr</code> wynosi zwykle 61,9–85,6 ms, a jeden wiersz ma tylko 3,1 ms. Nie należy traktować mediany próbek jako kosztu każdego kroku.

Co więcej, <code>record_solver_profile_step_with_orchestration</code> kończy pomiar callbacku przed zapisem JSONL i wywołaniem <code>publish_snapshot</code> profilu. Kod w <code>crates/fullmag-cli/src/live_workspace.rs:240-282</code> wykonuje te operacje później. Ich czas trafia więc do następnego <code>Gap</code>, a nie do <code>Orchestr</code>.

### 7.6 Zalecana zmiana architektoniczna

Minimalny bezpieczny kierunek:

1. zbudować <code>FemMeshPayload</code> raz na etap,
2. przechowywać go jako niezmienny <code>Arc&lt;FemMeshPayload&gt;</code> lub zasób identyfikowany przez generation ID,
3. po publikacji początku etapu przekazywać w <code>StepUpdate</code> tylko referencję/generation ID,
4. zmienić heartbeat na mały <code>StageHeartbeatProgress</code>,
5. przekazywać ownership update zamiast klonować go w offset i ingest,
6. usunąć compatibility mesh z <code>live_state.latest_step</code> po zakończeniu migracji API,
7. budować/serializować delta w workerze z immutable resources,
8. dodać osobne fazy <code>mesh_payload</code>, <code>step_update_clone</code>, <code>live_state_build</code>, <code>publisher_replace</code>, <code>profile_persist</code>.

### 7.7 Kryterium akceptacji

- zero hashy topologii i zero głębokich kopii mesh po inicjalizacji etapu,
- <code>StepUpdate</code> bez owned mesh w normalnym kroku,
- normalny <code>Gap</code> p50 poniżej 20 ms/krok dla badanego przypadku albo pełne wyjaśnienie pozostałych faz,
- brak zmiany generation ID, resource revisions i zachowania Control Room,
- identyczne artefakty i zgodność CPU/GPU.

## 8. P0: błędna architektura CUDA w bundle

### 8.1 Stan potwierdzony

Załadowany zarządzany runtime:

<code>.fullmag/runtimes/fem-gpu-host/lib/libfullmag_fem.so</code>

zawierał:

- 67 obiektów ELF dla <code>sm_52</code>,
- 67 wpisów PTX odpowiadających tej architekturze,
- brak natywnego <code>sm_89</code>.

Ten runtime jest rzeczywiście ładowany przez:

<code>.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin</code>.

Dla porównania biblioteka z normalnego zarządzanego CMake:

<code>native/build/backends/fem/libfullmag_fem.so.0.1.0</code>

zawierała 67 obiektów <code>sm_89</code>, a CMake wykrył <code>89-real</code>.

### 8.2 Źródło błędu

Ścieżka eksportu:

1. <code>scripts/export_fem_gpu_runtime.sh:69-79</code> czyści i buduje <code>fullmag-fem-sys</code> przez Cargo,
2. <code>scripts/export_fem_gpu_runtime.sh:239-243</code> kopiuje bibliotekę z katalogu wygenerowanego przez build script,
3. <code>crates/fullmag-fem-sys/build.rs:81-96</code> uruchamia CMake bez <code>-DCMAKE_CUDA_ARCHITECTURES</code>,
4. build script nie obserwuje ani nie przekazuje <code>FULLMAG_CUDA_ARCHITECTURES</code>,
5. <code>backends/fem/CMakeLists.txt:10-14</code> wymaga jedynie niepustej wartości; domyślna wartość CMake spełnia warunek i w tym środowisku prowadzi do <code>52</code>.

Normalne receptury repozytorium jawnie przekazują:

<code>-DCMAKE_CUDA_ARCHITECTURES=native</code>

na przykład w <code>justfile:162-166</code>. Eksport bundle używa innej, niepełnej ścieżki konfiguracji.

### 8.3 Dlaczego walidator tego nie wykrywa

<code>scripts/validate_managed_fem_runtime_bundle.py:17-39</code> weryfikuje hashe wyłącznie:

- launchera,
- workera,
- API.

Nie hashuje bibliotek natywnych i nie sprawdza:

- wymaganej architektury CUDA,
- obecności PTX/cubin,
- wersji i ABI MFEM/HYPRE,
- tego, którą bibliotekę faktycznie ładuje binarka.

Bundle może więc przejść jako <code>valid</code>, mimo że kluczowa biblioteka solvera ma złą architekturę.

### 8.4 Skutek

RTX 4080 ma compute capability 8.9. Kod <code>sm_52</code> nie jest natywnym cubinem dla tego GPU, więc wykonanie korzysta z kompatybilnego PTX i JIT sterownika. Według [dokumentacji nvcc NVIDIA](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/) PTX może być kompilowany dla nowszego GPU, ale dostępne cechy i założenia kodu są ograniczone przez wskazaną architekturę wirtualną. Dochodzi też koszt JIT przy zimnym uruchomieniu.

Nie wolno jednak obiecywać dużego przyspieszenia całego solvera po samym przejściu na <code>sm_89</code>:

- dominujący solve wykonuje osobna biblioteka HYPRE,
- problem jest mały i launch-bound,
- nie wykonano jeszcze A/B tego samego bundle.

To jest mimo wszystko błąd produkcyjnego pakowania i musi być P0 niezależnie od oczekiwanego procentowego zysku.

### 8.5 HYPRE ma osobny problem architektury

Biblioteka HYPRE zawierała po 138 cubinów dla:

- <code>sm_60</code>,
- <code>sm_70</code>,
- <code>sm_80</code>,
- <code>sm_90</code>.

Nie zawierała <code>sm_89</code> ani PTX. CUDA gwarantuje zgodność binarną w obrębie głównej generacji, więc cubin <code>sm_80</code> może działać na <code>sm_89</code>; nie jest to błąd równy Fullmag <code>sm_52</code>. Natywne <code>89</code> należy jednak dodać do macierzy i zmierzyć.

### 8.6 Naprawa i bramka

- build script ma propagować <code>FULLMAG_CUDA_ARCHITECTURES</code> do <code>CMAKE_CUDA_ARCHITECTURES</code>,
- zmiana tej wartości musi powodować rerun build scriptu,
- eksport ma zapisać architekturę w manifeście,
- walidator ma hashować <code>libfullmag_fem</code>, MFEM, HYPRE i libCEED,
- CI ma wykonać <code>cuobjdump</code> i fail-closed, gdy wymagany cubin/PTX nie istnieje,
- runtime ma raportować wykryte compute capability oraz rzeczywisty zestaw architektur bundle,
- benchmark ma zawierać cold-start i steady-state A/B <code>sm_52 PTX-JIT</code> kontra <code>sm_89</code>.

## 9. Natywny solver GPU NCG

### 9.1 Obecna ścieżka jest rzeczywiście device-resident

Świeży 64-krokowy benchmark raportuje:

- <code>execution_engine=fem_native_gpu</code>,
- <code>fem_data_residency=device_source_of_truth</code>,
- <code>uses_cuda_kernels=true</code>,
- <code>uses_gpu_poisson=true</code>,
- <code>hypre_execution_policy=device</code>,
- <code>demag_residency=device</code>,
- brak hot-loop compute H2D/D2H,
- 25,7 KiB odczytów skalarów sterujących dla całego biegu.

To wyklucza hipotezę, że obecny solver każdorazowo kopiuje pełne pole magnetyzacji na CPU.

### 9.2 Dokładnie cztery synchronizacje sterujące na krok

Dla 64 kroków:

- <code>hot_loop_host_sync_count=257</code>,
- <code>hot_loop_control_scalar_host_sync_count=257</code>,
- <code>hot_loop_control_scalar_d2h_bytes=26768</code>.

Relacja:

<code>257 = 1 + 4 × 64</code>.

W śladzie użytkownika licznik wzrósł z 13177 do 13713 między krokami 3288 i 3422:

<code>13713 − 13177 = 536 = 4 × 134</code>.

To potwierdza stałą strukturę czterech synchronizacji na zaakceptowany krok w stanie ustalonym.

### 9.3 Redundantny readback energii przed Armijo

W <code>backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp:412-451</code> funkcja:

1. liczy fresh demag i pole efektywne,
2. redukuje składniki energii,
3. redukuje energię całkowitą,
4. odczytuje ją z GPU do hosta jako <code>trial_energy</code>.

Następnie główna pętla w <code>1249-1325</code> natychmiast wywołuje <code>gpu_direct_armijo_evaluate</code>, które korzysta z tych samych urządzeniowych tail slots i zwraca pełny <code>trial_snapshot</code> oraz decyzję różnicową. Podobny wzorzec istnieje w recovery w <code>935-1005</code>.

Hostowy <code>trial_energy</code> jest później potrzebny tylko do komunikatu po całkowitym wyczerpaniu line search w <code>1410-1423</code>.

Kierunek optymalizacji:

- rozdzielić compute effective field/final energy terms od hostowego odczytu total energy,
- źródłem diagnostycznego last trial ma być snapshot Armijo,
- zachować wszystkie warunki finite, rollback i direct-difference refinement,
- cel: **3 synchronizacje na normalny akceptowany krok**.

Jest to optymalizacja strukturalna bez zmiany równania, warunku Armijo lub dokładności demag.

### 9.4 GPU NCG nie używa preconditionera CPU

Komentarz źródłowy w <code>nonlinear_cg.cpp:9-19</code> mówi wprost, że GPU NCG nie stosuje exchange-mass preconditionera:

<code>(M + wK)^−1 M g</code>.

CPU używa tej realizacji, GPU wykonuje poprawny, ale potencjalnie wolniej zbieżny wariant bez preconditioningu.

To jest istotniejsze niż pojedyncza mikrooptymalizacja kernela, jeżeli:

- zmniejszy liczbę kroków do tolerancji momentu,
- ograniczy restarty,
- zmniejszy liczbę backtracków i dodatkowych demag solve.

Koszt wewnętrznego solve preconditionera może jednak przewyższyć zysk na małych siatkach. Wymagany wynik to czas do tej samej tolerancji, nie sam czas kroku.

### 9.5 Proponowany eksperyment preconditionera

Porównać:

1. unpreconditioned NCG – obecny baseline,
2. diagonal/lumped mass scaling,
3. device-resident exchange-mass CG z reuse operatora,
4. ograniczoną liczbę iteracji preconditionera,
5. wariant adaptive: preconditioner dopiero po wykryciu stagnacji.

Raportować:

- czas do tolerancji momentu,
- liczbę zaakceptowanych kroków,
- liczbę prób Armijo i fresh demag,
- czas preconditionera,
- całkowity czas HYPRE,
- energię monotoniczną, norm defect i CPU/GPU parity.

## 10. Demagnetyzacja HYPRE/MFEM

### 10.1 Co jest już zrobione poprawnie

Kod <code>backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp</code>:

- ustawia pamięć i policy HYPRE na urządzenie,
- włącza vendor SpMV, SpGEMM i SpTrans,
- tworzy trwałe <code>A_par</code>, <code>b_par</code> i <code>x_par</code>,
- tworzy solver i preconditioner tylko raz,
- wykonuje <code>Setup</code> raz,
- reużywa setup w kolejnych krokach.

Ślad potwierdza <code>Setup=reused</code> i <code>Setup=0 ns</code> w hot loop.

Integracja streamów w <code>hypre_stream_interop.cpp:56-133</code> używa zdarzeń:

- Fullmag-ready → HYPRE stream waits,
- HYPRE-done → Fullmag stream waits.

Nie ma tutaj bezwarunkowego <code>cudaDeviceSynchronize</code>. To prawidłowa architektura.

### 10.2 Dominujący koszt

W <code>stage_compute.cpp:181-241</code> właściwy <code>solver-&gt;Mult</code> dominuje solve. RHS i recovery mają w benchmarku dziesiątki mikrosekund, a apply około 47–62 ms.

Wniosek: dalsza duża poprawa demag wymaga:

- mniej iteracji,
- tańszego AMG apply,
- mniejszej liczby demag solve,
- albo innego algorytmu/preconditionera dla tej skali.

Optymalizacja exchange, które zajmuje 20–40 µs na GPU, nie zmieni wyniku end-to-end.

### 10.3 Fresh-zero nie jest prostym błędem

Próby Armijo odpowiadają różnym magnetyzacjom i różnym prawym stronom. Kanoniczne kontrakty direct minimizer wymagają niezależnego fresh solve dla odmiennych prób, aby wynik odrzuconej próby nie zanieczyścił kolejnej decyzji energii.

Nie wolno po prostu włączyć warm startu z poprzedniej, odrzuconej próby.

Legalne i już wykorzystane jest reużycie dla dokładnie tego samego zaakceptowanego endpointu. Bardziej zaawansowany warm/delta solve wymaga nowej formulacji:

- deterministycznego solve poprawki potencjału,
- dowodu niezmienności energii i tolerancji,
- aktualizacji noty fizycznej,
- CPU oracle i testów mesh convergence.

### 10.4 Dlaczego mały Poisson słabo wykorzystuje RTX 4080

Zmierzona siatka ma około 1210 węzłów i 5154 tetraedry. CG/AMG przy 22–76 iteracjach wykonuje sekwencyjnie:

- SpMV,
- operacje wektorowe,
- globalne redukcje skalarów,
- restrykcje i prolongacje,
- coraz mniejsze poziomy AMG.

Na dolnych poziomach liczba elementów jest zbyt mała, by wypełnić tysiące rdzeni GPU. Redukcje wprowadzają zależności i kolejne launch-e. Dlatego wysokie <code>GPU-Util</code> nie jest realistycznym głównym celem dla tej siatki.

Poprawne cele to:

- mniejszy czas solve,
- mniej iteracji,
- mniejsza liczba synchronizacji,
- lepszy czas do tolerancji,
- właściwy crossover CPU/GPU.

### 10.5 AMG relax type 18 kontra 6

Kontrolowany 32-krokowy sweep na tej samej wygenerowanej siatce:

| Backend | AMG relax | czas ostatniego kroku | demag | apply | iteracje | residual |
|---|---:|---:|---:|---:|---:|---:|
| GPU | 18 | 80,299 ms | 61,764 ms | 61,699 ms | 40 | 9,819e−13 |
| GPU | 6 | 66,703 ms | 46,933 ms | 46,868 ms | 20 | 5,766e−13 |
| CPU | 18 | 180,473 ms | 155,893 ms | 130,400 ms | 40 | 9,819e−13 |
| CPU | 6 | 140,986 ms | 116,790 ms | 95,103 ms | 20 | 6,494e−13 |

Dla badanego przypadku przejście 18→6 dało:

- **−16,9%** czasu kroku GPU,
- **−24,0%** czasu demag/apply GPU,
- **−50%** iteracji.

HYPRE dokumentuje relax type 6 jako wspieraną opcję GPU; dla PCG należy zachować symetrię preconditionera. Zobacz [HYPRE BoomerAMG](https://hypre.readthedocs.io/en/stable/solvers-boomeramg.html).

Nie należy jeszcze globalnie zmieniać defaultu na podstawie jednej małej siatki. Należy natomiast natychmiast wykonać A/B na dokładnym workloadzie użytkownika, gdzie ślad pokazuje 76 iteracji.

### 10.6 Dalszy sweep HYPRE

Po ustabilizowaniu siatki mierzyć kombinacje:

- relax type 6, 18 i wspierane smoothery GPU,
- coarsening PMIS/HMIS zgodny z GPU,
- interpolation 3, 6, 14, 15,
- aggressive coarsening 0/1,
- strength threshold,
- max levels i coarse-grid cutoff,
- CG kontra ewentualny wariant wymagany przez niesymetryczny preconditioner.

Nie optymalizować wyłącznie liczby iteracji. Funkcja celu:

<code>median apply wall time przy spełnionym residual, deterministycznej energii i CPU/GPU parity</code>.

### 10.7 HYPRE allocator i architektura

Obraz buduje HYPRE przez:

<code>--with-gpu-arch="60 70 80 90" --without-umpire</code>.

Oficjalna [dokumentacja budowania HYPRE GPU](https://hypre.readthedocs.io/en/stable/ch-misc.html) opisuje Umpire/pooling oraz opcje async malloc i async Thrust.

Ponieważ setup jest reużywany, allocator może poprawić głównie cold/setup i sporadyczne workspace allocation, niekoniecznie każdy apply. Wymagane A/B:

- obecny allocator,
- Umpire pool,
- CUDA malloc async,
- Thrust async,
- natywne <code>sm_89</code>.

Każdy wariant mierzyć oddzielnie dla cold setup i steady apply.

## 11. Preview, cache i kopie pól

### 11.1 Pole <code>Cache=79,4 ms</code> jest realnym kosztem

W śladzie krok 3320 zawiera około 79,4 ms w <code>Cache</code>. Podobny pik 78,6 ms występował przed optymalizacją. To nie jest <code>Gap</code>; czas jest ujęty w <code>Total</code>.

FEM domyślnie materializuje pola preview co 10 kroków:

<code>crates/fullmag-cli/src/orchestrator.rs:5953-5964</code>.

To wyjaśnia, dlaczego część kroków jest wyraźnie droższa. Heavy payload wymusza także natychmiastowe publish niezależnie od 5-sekundowej kadencji.

### 11.2 Co należy zmierzyć

- preview całkowicie wyłączone,
- samo <code>m</code>,
- <code>H_demag</code>,
- pełny cache aktywnych quantities,
- Control Room zamknięty/otwarty,
- kadencja 10/25/50 kroków,
- asynchroniczne handoff bez oczekiwania w bieżącym kroku.

### 11.3 Kierunek

- nie obniżać domyślnej jakości wizualizacji jako pierwszej optymalizacji,
- oddzielić deadline solvera od deadline preview,
- zachować ostatni kompletny frame, gdy nowe pole liczy się w tle,
- publikować pola po resource revision, nie kopiować ich do ogólnego statusu,
- raportować staleness i czas materializacji w UI.

## 12. Artefakty: etykieta wygląda groźnie, zapis nie jest głównym bottleneckiem

Wiersz:

<code>35,5 µs / 816 B / q1 / w3421 35,5 ms</code>

łączy cztery różne pojęcia:

1. czas enqueue bieżącego kroku – dziesiątki mikrosekund,
2. rozmiar bieżącego payloadu,
3. maksymalną historyczną głębokość kolejki,
4. skumulowany czas writerów od początku runu.

<code>w3421 35,5 ms</code> nie znaczy 35,5 ms na krok. To około:

<code>35,5 ms / 3421 ≈ 10,4 µs na job</code>.

Pipeline posiada worker thread i bufor o pojemności 4:

- <code>crates/fullmag-runner/src/artifact_pipeline.rs:33</code>,
- <code>crates/fullmag-runner/src/artifact_pipeline.rs:220-267</code>,
- <code>crates/fullmag-runner/src/artifact_pipeline.rs:695+</code>.

Stan przechowuje zarówno bieżącą, jak i maksymalną kolejkę, ale UI używa <code>artifact_queue_depth_max</code>. Formatter w <code>FooterDiagnostics.tsx:666-686</code> wyświetla dane kumulacyjne bez oznaczenia.

Naprawa UI:

- <code>enqueue now</code>,
- <code>queue current/max</code>,
- <code>writer delta since previous sample</code>,
- <code>writer cumulative</code> w osobnym tooltipie,
- analogicznie dla kumulacyjnego licznika GPU sync i bajtów.

## 13. CPU i OpenMP w trybie GPU

Ślad mówi <code>Effective OpenMP thread count is 1</code>. Jest to prawdziwe, ale wynika z konstrukcji:

- stan kontekstu domyślnie ma requested/effective = 1,
- gałąź CPU wywołuje <code>configure_cpu_openmp_runtime</code>,
- gałąź GPU w <code>mfem_context.cpp:248-266</code> tworzy streamy CUDA i pomija konfigurację CPU.

Świeży benchmark potwierdza:

- GPU: requested 1, effective 1,
- CPU auto: requested 40, effective 8.

To nie jest główna przyczyna niskiego użycia GPU:

- HYPRE apply działa na urządzeniu,
- klonowanie Rust jest jednowątkowe niezależnie od OpenMP,
- mesh/hash także nie korzysta automatycznie z tego runtime.

Może jednak spowalniać:

- hostowe fallbacki,
- setup/recovery,
- niektóre ścieżki MFEM,
- przygotowanie operatorów.

Zalecenie: konfigurować politykę CPU również w trybie GPU i raportować ją uczciwie, a następnie wykonać A/B 1/2/4/8. Nie ustawiać bezwarunkowo wszystkich rdzeni, bo może to zwiększyć oversubscription i kontencję z API/writerami.

## 14. Czy <code>nvidia-smi GPU-Util</code> jest właściwą miarą?

Nie jako samodzielna metryka.

Według [dokumentacji NVIDIA System Management Interface](https://docs.nvidia.com/deploy/nvidia-smi/index.html) utilization jest procentem okresu próbkowania, w którym urządzenie wykonywało pracę. Nie jest to:

- occupancy kernela,
- procent użytych CUDA cores,
- efektywność pamięci,
- miara użycia konkretnego procesu przy zwykłym <code>dmon</code>.

Świeży ślad 28 próbek:

| Metryka | Wszystkie próbki | Próbki z SM ≥ 10% |
|---|---:|---:|
| liczba | 28 | 18 |
| średnie SM | 23,71% | 35,61% |
| mediana SM aktywnych | — | 36,5% |
| p95 SM aktywnych | — | 40% |
| maksimum SM | 42% | 42% |
| średnia moc aktywnych | — | 56,22 W |
| maksimum mocy | 66 W | 66 W |
| memory controller | 0% | 0% |

Ślad obejmuje warmup, CPU, setup i okresy bez aktywnego GPU; nie jest per-process. Potwierdza jednak, że workload nie jest bandwidth-bound i pozostawia znaczące okresy bez pracy GPU.

Wymagane narzędzia:

- Nsight Systems: timeline CPU, CUDA, HYPRE, stream waits i launch gaps,
- Nsight Compute: occupancy, achieved bandwidth, warp stalls i rozmiary gridów,
- NVTX zakresy dla NCG, demag RHS, każdego poziomu AMG, redukcji, readback, preview i callbacku hosta.

## 15. Błędy i luki w obecnych metrykach API

### 15.1 <code>steps_per_second</code> ignoruje end-to-end wall time

<code>crates/fullmag-api/src/router_v2/handlers/sessions/status.rs:539-555</code> bierze do pięciu ostatnich próbek i liczy:

<code>1e9 / średnie(total_ns)</code>.

Ignoruje:

- <code>delta_wall_time_ns</code>,
- <code>unprofiled_gap_wall_time_ns</code>,
- liczbę kroków pomiędzy próbkami,
- bias 5-sekundowej publikacji.

Dlatego może pokazywać około 4–6 kroków/s, gdy rzeczywisty przebieg daje około 3,06 kroku/s.

### 15.2 Fallback jest matematycznie błędny

Gdy profiler nie ma próbek, kod w <code>233-240</code> dzieli całkowitą liczbę kroków przez <code>wall_time_ns</code> ostatniego kroku. To nie jest lifetime average.

Prawidłowe źródło:

- monotoniczny czas od pierwszego do ostatniego zaakceptowanego kroku,
- albo licznik kroków i monotoniczny czas w przesuwanym oknie.

### 15.3 Wymagany kontrakt

API powinno rozróżniać:

- <code>solver_steps_per_second</code> – tylko natywny solve,
- <code>end_to_end_steps_per_second</code> – zaakceptowane kroki / monotoniczny wall,
- <code>published_steps_per_second</code> – tempo widoczne dla UI,
- <code>time_to_tolerance</code> – najważniejsza metryka relaksacji.

Każda wartość musi mieć jawne okno, źródło i revision.

## 16. Audyt testów i bramek wydajności

### 16.1 Testy nie wymuszają błędnej fizyki

Nie znaleziono testu, który nakazywałby:

- dwa demag solve dla tego samego endpointu,
- kopiowanie pełnego pola GPU→CPU,
- przebudowę siatki co krok,
- blokujące HTTP w hot loop.

Problemem są głównie testy źródłowe i luźne performance gates utrwalające bieżące wartości jako kontrakt implementacyjny.

### 16.2 Hardcoded wartości utrwalają obecne sufity

Przykłady:

- <code>DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP = 11</code>,
- <code>DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP = 4</code>,
- test źródłowy wymaga literalnego defaultu AMG 18,
- produkcyjny recipe akceptuje NCG=4,
- dokument fizyczny nadal opisuje NCG=3 i PG-BB=4 w części historycznej.

To tworzy drift:

- dokument mówi jedno,
- benchmark defaults drugie,
- część receptur ma PG-BB 11,
- inna ma PG-BB 4.

Test performance powinien wyznaczać górny limit lub brak regresji, ale nie wymagać literalnie, aby implementacja nadal miała koszt 11 albo default 18.

### 16.3 Obecne bramki są za słabe

Production benchmark:

- domyślnie 32 kroki,
- minimalnie 50 węzłów,
- domyślnie jeden repeat,
- brak obowiązkowego accepted baseline.

Demag performance:

- domyślnie 4 kroki,
- minimalnie 800 węzłów,
- limit apply aż 5000 ms,
- accepted baseline opcjonalny,
- jeden repeat.

Takie ustawienia wykrywają awarie funkcjonalne i bardzo duże regresje, ale nie chronią poprawy rzędu 5–20%.

### 16.4 Benchmark nie gwarantuje tej samej siatki między uruchomieniami

32-krokowy run:

- 1204 węzły,
- 5160 elementów,
- signature <code>a8df1dd8…</code>.

64-krokowy run z tymi samymi nominalnymi ustawieniami:

- 1210 węzłów,
- 5154 elementy,
- signature <code>cbb0cfbd…</code>.

Skrypt używa tymczasowego cache, jeżeli nie podano trwałego katalogu:

<code>scripts/analysis/fem_gpu_benchmark.py:5399-5411</code>.

Istnieje <code>--require-stable-solver-mesh</code>, ale receptury domyślne go nie włączają. Nawet włączona opcja sprawdza repeaty wewnątrz jednego uruchomienia, nie historyczny baseline z innym ephemeral cache.

### 16.5 Nowa minimalna bramka

Każdy performance PR FEM GPU powinien mieć:

1. wersjonowaną, trwałą siatkę lub artefakt cache z hashem,
2. warmup oddzielony od pomiaru,
3. 3–5 powtórzeń,
4. medianę, p95 i odchylenie,
5. profiler off i on,
6. headless i interactive,
7. CPU oracle,
8. wymagany accepted baseline,
9. cold setup i steady-state oddzielnie,
10. architekturę CUDA zapisaną w raporcie,
11. time-to-tolerance oraz steps-to-tolerance,
12. synchronizacje i transfery na krok,
13. Nsight trace dla zmian stream/sync/kernel.

## 17. Wyniki świeżych benchmarków

### 17.1 Benchmark 32 kroki, sweep AMG 18/6

Artefakty:

- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver.csv</code>,
- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver-summary.json</code>,
- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver.md</code>.

Wynik:

- status: pass,
- CPU/GPU consistency gate: pass,
- CPU compute total: 7013,3 ms,
- GPU compute total: 4464,1 ms,
- wall speedup: **1,570×**,
- demag total speedup: **2,488×**,
- demag apply speedup: **2,029×**.

### 17.2 Benchmark 64 kroki, najlepszy profil 6

Artefakty:

- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.csv</code>,
- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64-summary.json</code>,
- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.md</code>,
- <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.dmon</code>.

Wynik:

| Metryka | CPU | GPU | CPU/GPU |
|---|---:|---:|---:|
| wall 64 kroków | 11117,381 ms | 6257,015 ms | **1,777×** |
| ostatni krok | 155,800 ms | 71,031 ms | **2,193×** |
| demag | 131,746 ms | 51,524 ms | **2,557×** |
| demag apply | 109,690 ms | 51,466 ms | **2,131×** |
| iteracje | 22 | 22 | identyczne |
| residual | 8,742e−13 | 8,743e−13 | zgodne |

Różnice końcowe:

- energia całkowita relative diff około 1,65e−4,
- energia demag relative diff około 9,47e−4,
- torque relative diff około 6,26%.

Obecna bramka oznaczyła parę jako pass. Te wartości nie są jednak samodzielnym dowodem pełnej trajektoryjnej kwalifikacji naukowej.

## 18. Priorytety wdrożeniowe

### P0.1 – naprawić architekturę CUDA bundle

Zakres:

- propagacja architektury przez Cargo build script,
- manifest i hash bibliotek,
- <code>cuobjdump</code> gate,
- A/B cold/steady.

Oczekiwany efekt: poprawność pakowania i potencjalny zysk Fullmag kernels. Wielkość zysku nieustalona.

### P0.2 – usunąć per-step mesh/hash/deep clone

Zakres:

- immutable mesh resource raz na stage,
- lekkie update/heartbeat,
- ownership zamiast clone,
- usunięcie compatibility duplication.

Oczekiwany efekt: największa szansa zmniejszenia typowego 115–127 ms host gap. Dokładny zysk wymaga nowych faz.

### P0.3 – naprawić profiler i throughput API

Zakres:

- monotonic span,
- sumy per faza w oknie,
- gap per step,
- poprawne end-to-end throughput,
- osobne cumulative/delta metrics.

Oczekiwany efekt: brak bezpośredniego przyspieszenia solve, ale wiarygodna podstawa każdej dalszej optymalizacji.

### P0.4 – ustabilizować benchmark

Zakres:

- stała siatka,
- repeaty,
- accepted baseline,
- exact architecture,
- headless/interactive matrix.

Oczekiwany efekt: ochrona przed fałszywym „przyspieszeniem” wynikającym z innej siatki lub UI.

### P1.1 – kwalifikowany profil AMG 6

Najpierw workload użytkownika z 76 iteracjami, potem sweep rozmiarów/airboxów. Nie zmieniać globalnego defaultu przed kwalifikacją.

### P1.2 – NCG 4→3 synchronizacje

Usunąć redundantny host readback trial energy, zachowując snapshot Armijo i diagnostykę.

### P1.3 – device-resident exchange-mass preconditioner

Ocena tylko przez time-to-tolerance i liczbę demag solve. Dodać fallback dla małych siatek.

### P1.4 – rozdzielić preview/cache od deadline kroku

Asynchroniczne materializowanie fields, jawna staleness, quality-preserving default.

### P1.5 – polityka host threads w GPU

Skonfigurować i A/B 1/2/4/8. Nie oczekiwać, że samo OpenMP naprawi Rust clone/hashing.

### P1.6 – HYPRE <code>sm_89</code>, pool i async allocator

Oddzielny A/B cold/steady. Nie łączyć kilku zmian w jednym benchmarku.

### P2.1 – dalszy tuning AMG i coarse solve

Wykonać po stabilizacji benchmarku. Rozważyć strategy zależną od rozmiaru siatki.

### P2.2 – crossover CPU/GPU

Dla bardzo małych układów GPU może być szybsze od CPU, lecz nadal dalekie od pełnego wykorzystania. Planner powinien w przyszłości wybierać execution na podstawie skalibrowanego rozmiaru i workloadu, nie obietnicy wysokiego <code>GPU-Util</code>.

### P2.3 – CUDA Graphs i kernel fusion

Ma sens dopiero po usunięciu host readbacks i ustabilizowaniu sekwencji prób. Graph nie przejdzie przez host-driven Armijo bez przeprojektowania sterowania.

### P2.4 – deterministyczny delta-potential demag

Potencjalnie zmniejsza koszt kolejnych podobnych solve, ale jest zmianą numeryczną wymagającą noty fizycznej i pełnej kwalifikacji.

## 19. Macierz eksperymentów izolujących bottleneck

| Eksperyment | A | B | Co rozstrzyga |
|---|---|---|---|
| profiler | off | on, persist off | sam koszt księgowania |
| persist profilu | off | on | JSONL + publish profile |
| preview | disabled | default FEM/10 | koszt cache i pola |
| UI | headless | interactive bez browsera | runtime/API process |
| browser | zamknięty | otwarty Control Room | request/render contention |
| publisher | normal API | sztucznie wolne API | wpływ pending merge/locks |
| mesh payload | obecny | immutable Arc/generation only | główna hipoteza Gap |
| heartbeat | full StepUpdate | lightweight stats | koszt clone |
| artefakty | scalar only | fields enabled | enqueue i writer contention |
| CPU threads GPU | 1 | 2/4/8 | host fallback/setup |
| CUDA arch | sm52 PTX | sm89 cubin | packaging/JIT |
| AMG | relax18 | relax6 | iteracje i apply |
| NCG sync | 4 | 3 | launch gaps/readback |

Każdy eksperyment:

- ta sama wersjonowana siatka,
- co najmniej 1 warmup + 5 powtórzeń,
- ten sam stop condition,
- raport p50/p95,
- ślad monotoniczny per krok,
- GPU trace zsynchronizowany z run ID.

## 20. Kryteria zakończenia optymalizacji

Nie uznawać zadania za wykonane na podstawie wyższego piku <code>GPU-Util</code>. Minimalne kryteria:

1. bundle zawiera natywną architekturę urządzenia i przechodzi fail-closed validation,
2. ta sama siatka i ten sam ProblemIR są użyte w baseline i candidate,
3. end-to-end wall time p50 poprawia się bez pogorszenia p95,
4. czas do tej samej tolerancji momentu maleje,
5. energia, residual, norm defect, stop reason i trajectory parity przechodzą kwalifikację,
6. normalny host gap jest rozliczony per faza,
7. nie ma pełnych H2D/D2H w hot loop,
8. liczba sync/step nie rośnie,
9. preview i artefakty zachowują kontrakt jakości i kompletności,
10. headless i interactive nie różnią się w sposób niewyjaśniony,
11. API pokazuje rzeczywistą przepustowość end-to-end,
12. benchmark ma trwały accepted baseline.

## 21. Ostateczna ocena

Obecny solver FEM GPU jest **production-executable** i rzeczywiście szybszy niż poprzednia wersja oraz CPU dla badanego przypadku. Nie jest jednak jeszcze wydajnościowo domknięty.

Największy pozostały zysk nie wynika wyłącznie z „przeniesienia większej ilości kodu na GPU”. Trzeba równolegle:

- naprawić produkcyjne pakowanie architektury CUDA,
- usunąć niezmienną siatkę i głębokie kopie z hot loop CPU,
- naprawić pomiar całego przedziału,
- dostroić AMG na stabilnym workloadzie,
- usunąć redundantną synchronizację NCG,
- dopiero potem rozważać preconditioner, HYPRE allocator, graphs i fusion.

Wrażenie, że „czas między krokami jest sztucznie liczony”, jest częściowo trafne tylko na poziomie prezentacji. Liczba <code>Gap</code> odpowiada realnemu czasowi ściennemu, ale jest przypisana do jednego wiersza mimo że obejmuje 16–18 kroków, a profiler nie mówi jeszcze, na co dokładnie ten czas został zużyty. Kod ujawnia jednak konkretne, niepotrzebne operacje CPU, które mogą wyjaśniać dużą część tego kosztu.

Najbardziej racjonalna kolejność prac:

<code>telemetria + immutable mesh → bundle sm89 → workload AMG6 → NCG 3 sync → preview isolation → preconditioned NCG → niższy poziom HYPRE/CUDA</code>.

## 22. Mapa najważniejszych źródeł

| Obszar | Plik / zakres |
|---|---|
| obliczanie Gap | <code>crates/fullmag-runner/src/solver_profile.rs:551-619</code> |
| błędne steps/s API | <code>crates/fullmag-api/src/router_v2/handlers/sessions/status.rs:233-240,539-555</code> |
| domyślna konfiguracja profilu UI | <code>apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts:80-81,903-939</code> |
| per-step mesh w NCG | <code>crates/fullmag-runner/src/fem/relax/direct_minimizer.rs:118-132,238-252</code> |
| koszt konwersji mesh | <code>crates/fullmag-runner/src/types.rs:1454-1645</code> |
| klon offset update | <code>crates/fullmag-cli/src/step_utils.rs:141-151</code> |
| klon heartbeat | <code>crates/fullmag-cli/src/orchestrator.rs:1970-2079</code> |
| live ingest | <code>crates/fullmag-cli/src/orchestrator.rs:1256-1305</code> |
| build/publish payload | <code>crates/fullmag-cli/src/live_workspace.rs:56-118,182-188,755-790</code> |
| background HTTP worker | <code>crates/fullmag-cli/src/live_workspace.rs:681-726,1554-1633</code> |
| preview cadence | <code>crates/fullmag-cli/src/orchestrator.rs:5953-5964</code> |
| artifact diagnostics | <code>crates/fullmag-runner/src/artifact_pipeline.rs:33-87,220-267,695+</code> |
| artifact formatter UI | <code>apps/control-room/src/modules/footer/FooterDiagnostics.tsx:487-493,666-686</code> |
| GPU NCG | <code>backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp</code> |
| GPU HYPRE setup | <code>backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp</code> |
| HYPRE stream events | <code>backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp</code> |
| HYPRE apply | <code>backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp:181-241</code> |
| GPU pomija CPU thread policy | <code>backends/fem/cpu/mfem/runtime/mfem_context.cpp:248-266</code> |
| export błędnego bundle | <code>scripts/export_fem_gpu_runtime.sh:69-79,239-243</code> |
| Cargo CMake bez arch | <code>crates/fullmag-fem-sys/build.rs:81-96</code> |
| walidator bundle | <code>scripts/validate_managed_fem_runtime_bundle.py:17-39</code> |
| obraz zależności | <code>docker/fem-gpu/Dockerfile:1-8,50-75</code> |
| benchmark defaults | <code>scripts/analysis/fem_gpu_benchmark.py:199-221</code> |
| ephemeral mesh cache | <code>scripts/analysis/fem_gpu_benchmark.py:5399-5411</code> |

## 23. Artefakty dowodowe z tego audytu

| Artefakt | Znaczenie |
|---|---|
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver.csv</code> | surowe wyniki CPU/GPU i AMG 18/6 |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver-summary.json</code> | bramki i porównania pierwszego sweepu |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-solver.md</code> | automatyczne podsumowanie pierwszego sweepu |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.csv</code> | surowy benchmark 64-krokowy |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64-summary.json</code> | zgodność i speedup 64 kroków |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.md</code> | automatyczne podsumowanie 64 kroków |
| <code>.fullmag/reports/audit-2026-07-20-fem-gpu-ncg-relax6-64.dmon</code> | 1-sekundowy ślad NVIDIA SM/power/memory |
