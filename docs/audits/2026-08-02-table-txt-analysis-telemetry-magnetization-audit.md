# Audyt `table.txt` / Analysis / Telemetry dla `mx`, `my`, `mz`

Data: 2026-08-02  
Zakres: wartości komponentów średniej magnetyzacji zapisywane do TXT, publikowane przez v2 API i wyświetlane w Analysis oraz w telemetry Footer.

## Wniosek

Rozbieżność nie ma jednej przyczyny. W kodzie istnieją dwie różne klasy wartości:

1. **Globalna próbka skalarna**: `StepStats.mx/my/mz`. Z niej korzystają `TableStore`, stage `TXT` oraz v2 `scalar_rows`, a więc także Analysis.
2. **Średnia per-object**: `ObjectMetricsResource.magnetization_average`. Może jej użyć Footer Telemetry, gdy nie ma bieżącej próbki skalarnej, albo gdy UI pracuje na wybranym obiekcie.

Jeżeli Footer pokazuje `Live scalar sample`, jego `mx/my/mz` powinny być tymi samymi liczbami co ostatni wiersz tabeli Analysis dla tego samego `step`/`time`. Jeżeli resource obiektu ma źródło `solver_per_object`, `solver_global` albo `initial_state`, porównywane są już metryki wybranego obiektu lub stan początkowy z globalną tabelą i rozbieżność jest oczekiwana przy obecnej implementacji.

## Jednostka i znaczenie

`mx`, `my`, `mz` są komponentami znormalizowanej magnetyzacji `m`, a nie magnetyzacji fizycznej `M` w `A/m`.

- jednostka w katalogu ilości, Python DSL, runnerze i v2 API: **dimensionless**, serializowana jako `"1"`;
- znaczenie: odpowiednio `avg(m_x)`, `avg(m_y)`, `avg(m_z)`;
- magnetyzacja fizyczna ma postać `M = Ms * m` i jednostkę `A/m`;
- `|avg m|`, które pokazuje Footer, to `sqrt(mx² + my² + mz²)`, czyli norma już uśrednionego wektora. To nie jest `avg(|m|)`. W domenie z domenami magnetycznymi lub ścianą domenową może być mniejsze od 1.

Ważna wada artefaktu: nagłówek `.txt` zawiera nazwy kolumn, ale nie zawiera jednostek. Jednostka i `dimension` są dostępne w `schema.json` / metadanych v2 API. Sama nazwa kolumny, także ewentualny sufiks, nie jest wiarygodnym kontraktem jednostki.

## Rzeczywisty przepływ danych

```text
solver step
    -> StepStats.mx/my/mz
       ├─ TableStore::append_if_due
       │    └─ stage main.txt / main.stage_....txt
       ├─ latest_scalar_row_if_due
       │    └─ current live snapshot -> v2 scalar_rows -> Analysis table/chart
       └─ Footer Telemetry
            ├─ Live scalar sample: ta sama globalna próbka
            └─ ObjectMetrics fallback: średnia wybranego obiektu
```

Konsekwencja: **Analysis nie parsuje `table.txt`**. Pobiera binarną tabelę przez resource-first v2 API (`useTableRowsBinaryResource("default")`), a adapter i model wykresu nie wykonują transformacji wartości. `table.txt` i Analysis mają wspólnego producenta (`StepStats`), ale mogą mieć inną kadencję próbkowania i inny ostatni `step`.

## Jak liczona jest wartość globalna

### FDM

Ścieżki FDM używają `average_magnetization_components` / `apply_average_m_to_step_stats`: suma komponentów podzielona przez liczbę niezerowych próbek. Dla regularnej siatki jest to odpowiednik średniej objętościowej, o ile każda aktywna komórka ma tę samą objętość. Funkcja pomija dokładnie zerowe wektory.

### Produkcyjny native FEM CPU

`backends/fem/cpu/mfem/runtime/step_metrics.cpp` wykonuje redukcję ważoną. W uproszczeniu:

```text
avg(m) = sum_i(Ms_i * V_i * m_i) / sum_i(Ms_i * V_i)
```

`V_i` to lumped FEM volume/mass, aktywne są tylko węzły magnetyczne, a `Ms_i` może być stałe albo elementowe. Przy stałym `Ms` zostaje średnia ważona objętością. To jest poprawna redukcja globalnego momentu dla dyskretyzacji FEM.

### Produkcyjny native FEM GPU

Kernel CUDA robi tę samą redukcję przez `node_volumes[i] * ms[i]`, a publikacja `StepStats` dzieli sumy komponentów przez `MomentWeight`. To potwierdza, że globalne `StepStats.mx/my/mz` w FEM nie są zwykłą średnią po liczbie węzłów.

## Główna przyczyna rozbieżności Telemetry

Ścieżka object metrics nie używa tej samej redukcji co globalny native FEM:

1. C ABI `fullmag_fem_backend_average_m_for_nodes_f64` sumuje wartości węzłowe i dzieli przez liczbę zaakceptowanych węzłów. Nie używa objętości lumped FEM ani `Ms`.
2. `native_fem.rs::attach_native_object_average_m` zapisuje ten wynik jako `per_object_scalars[object_id][mx/my/mz]`.
3. API fallback `average_indexed_magnetization` również wykonuje zwykłą średnią arytmetyczną po indeksach węzłów.
4. Footer wybiera `liveRow.mx/my/mz` tylko wtedy, gdy istnieje live scalar row; w przeciwnym razie bierze `objectMetrics.magnetization_average`.

Dla FEM z nierównymi objętościami węzłów przykładowo:

```text
wektory: m1=(1,0,0), m2=(0,1,0), m3=(0,0,1)
wagi:    V=(1,2,7)

średnia węzłowa:     (1/3, 1/3, 1/3)
średnia FEM ważona:  (0.1, 0.2, 0.7)
```

Obie wartości są bezwymiarowe i obie mogą wyglądać wiarygodnie, ale opisują inną redukcję.

## Pozostałe, niezależne źródła pozornej rozbieżności

| Przyczyna | Skutek |
|---|---|
| Footer ma `Live scalar sample`, ale wykres jest zatrzymany, zdecymowany albo ma widoczny starszy zakres | Footer pokazuje nowszy wiersz niż ostatni punkt widoczny na wykresie |
| Footer ma object fallback | Porównanie globalnego `mx/my/mz` z wybranym obiektem; dodatkowo obecnie inna waga |
| Inny `step`, `time` lub stage | Porównanie różnych stanów solvera; tabela może być próbkowana co `N` accepted steps albo co czas fizyczny |
| FDM kontra FEM | FDM używa regularnej średniej próbek, native FEM redukcji `Ms*volume`; różnica może być backendowa, nie UI-owa |
| `|avg m|` kontra komponenty | Norma wektora nie jest kolejną średnią po punktach |
| Brak próbek skalarnej tabeli / wyłączone charts | Footer przechodzi na object/session fallback; Analysis może nie mieć tego samego źródła |

## Status dowodów

Potwierdzone statycznie w bieżącym checkoutcie:

- default table columns to `step,t,mx,my,mz,e_total,max_torque`;
- `table_column_value` kopiuje `StepStats.mx/my/mz` bez przeliczenia;
- TXT zapisuje wartości w tej samej kolejności i bez jednostek w nagłówku;
- v2 table metadata opisuje `mx/my/mz` jako `unit="1"`, `dimension="normalized_magnetization"`, `reduction="average"`;
- Analysis dekoduje surowe wartości tabeli bez skalowania;
- Footer preferuje scalar row, ale ma fallback do object metrics;
- native FEM globalny `StepStats` jest ważony `Ms*volume`, natomiast native FEM per-object oraz API mesh fallback są średnią po węzłach.

Uruchomione testy:

- `fullmag-runner` testy `scalar_metrics`: **4 passed**;
- `fullmag-api` testy `object_metrics_endpoint`: **3 passed**;
- Control Room testy Analysis/Footer: **4038 passed** w 425 plikach.

Nie wykonano w tym audycie nowej sesji managed native FEM ani porównania konkretnego pliku `main*.txt` z konkretnym numerem rewizji API. Bez identyfikatora sesji, backendu, stage, `step` i `time` nie byłoby uczciwe twierdzić, że każda obserwowana przez użytkownika różnica pochodzi z jednej konkretnej gałęzi.

## Zalecany kontrakt naprawczy

Przed zmianą kodu trzeba wybrać jedną politykę produktu:

1. globalne `mx/my/mz` pozostają fizycznie ważoną średnią FEM, a object metrics dostają tę samą redukcję z wagami i jawne pole `reduction`/`weighting`; albo
2. produkt świadomie pokazuje średnią po węzłach wszędzie, co byłoby prostsze, ale mniej poprawne dla globalnego momentu FEM.

Rekomendowana jest opcja 1. Niezależnie od wyboru, każdy zapis i każdy resource powinien nieść co najmniej `step`, `time`, `backend`, `scope` (`global`/`object`) oraz opis redukcji. Dodatkowo TXT powinien odwoływać się do schematu z jednostką, bo obecny nagłówek sam nie wyjaśnia, że `mx/my/mz` są znormalizowanym `m`, a nie `M` w `A/m`.

## Źródła w kodzie

- `crates/fullmag-runner/src/table_autosave.rs`: default columns, metadata i kopiowanie z `StepStats`.
- `crates/fullmag-runner/src/autosave_txt.rs`: nagłówek i format wierszy TXT.
- `crates/fullmag-runner/src/scalar_metrics.rs`: średnia równomierna i ważona.
- `backends/fem/cpu/mfem/runtime/step_metrics.cpp`: globalna redukcja native FEM CPU.
- `backends/fem/gpu/cuda/observables/observable_kernels.cu` oraz `.../rk_step_stats_publication.cpp`: globalna redukcja native FEM GPU.
- `backends/fem/src/api.cpp` i `crates/fullmag-runner/src/native_fem.rs`: per-object native FEM.
- `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`: object metrics fallback.
- `crates/fullmag-api/src/router_v2/handlers/data/tables.rs`: v2 table values and metadata.
- `crates/fullmag-cli/src/live_workspace.rs` i `crates/fullmag-api/src/session.rs`: scalar-row publication/upsert.
- `apps/control-room/src/modules/analysis-plots/*` i `apps/control-room/src/modules/footer/FooterTelemetry.tsx`: konsumpcja w Analysis i Footer.
- `packages/fullmag-py/src/fullmag/runtime/simulation.py`: publiczne opisy `mx/my/mz` jako dimensionless.
- `docs/adr/0019-regional-field-drive-and-stage-time-semantics.md`: backendowe zasady średniej FDM/FEM.
