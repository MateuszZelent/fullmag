# CUPTI dla wybranego zakresu zaakceptowanych kroków FEM GPU

Cel: uzyskać kompletny profil ciepłych kroków Poissona SP4 bez zmiany fizyki,
tolerancji, integratora ani pełnego zapisu Zarr. Dotychczasowy limit śladu
512 MiB nie zapewnił kompletnego profilu całego biegu. Obecny capture zaczyna
się przed runnerem; limit bajtów/czasu oznacza `partial`, nie wybrane okno.

## Niezmienne wejście i kompatybilność

Dotychczasowe `accepted_cuda_trace.v1` i receipt `worker_cuda_trace.v1.json`
zachowują zachowanie i serializowany kształt. Nowy jawny parametr authoringu:

```json
{
  "cuda_trace": {
    "schema_version": "accepted_cuda_trace.v2",
    "max_bytes": 67108864,
    "max_duration_ms": 60000,
    "accepted_step_window": {"start_after_step": 16, "end_after_step": 32}
  }
}
```

Config i wewnętrzne okno mają zamknięte pola. V1 zabrania okna, V2 wymaga okna.
Wartości to liczby całkowite: `1 <= start_after_step < end_after_step` oraz
`end_after_step - start_after_step <= 1000`. Nie dopuszczamy bool, float,
nieznanych pól, przepełnień ani nieznanej wersji. Limity pozostają
4096–536870912 B i 1–120000 ms; rezerwa storage to cap + 1 MiB na receipt.
Digest obejmuje także okno. Istniejące ścieżki CLI startup V1 pozostają V1;
V2 przechodzi przez kanoniczne `prepare-run-json` i publiczny Submit.

Nadal wymagane: jawne FEM GPU, strict/double, supported plan, brak fallbacku.
Nie dodajemy nowych selektorów środowiska ani bezpośredniego uruchomienia
binarium poza zaakceptowanym workerem.

## Granice i lifecycle

Zakres `(N,M]` obejmuje pracę po zaobserwowaniu zaakceptowanego kroku N do
zaobserwowania zaakceptowanego kroku M, wraz z próbami odrzuconymi między nimi.
Callback graniczny oznacza ukończony krok, nie początek kolejnego. Obserwator
używa tylko `StepDataKind::PhysicalObservation` i pól `step`, `time`; nie
wpływa na `StepAction`, stan magnetyzacji, wybór dt ani operatory.

Przed runnerem rezerwujemy nowy plik i identity jak dotąd. Dla V2 native
CUPTI jeszcze nie startuje. Przy dokładnym N uruchamiamy istniejący kolektor,
przy dokładnym M zatrzymujemy go raz. Nie dopisujemy nowych synchronizacji
CUDA. To wciąż ten sam proces i GPU; nie przełączamy urządzenia ani Context.
Nie przechowujemy fabryki z niejasnym lifetime: produkcyjny start jest
wywoływany z metody obserwacji, a testy korzystają z wstrzykniętej fabryki fake.

Pominięcie granicy, cofnięcie zaakceptowanego kroku lub niefinitywny czas przed
zamknięciem okna
uniemożliwia `complete`; nie uruchamiamy ponownie capture. Powtórna obserwacja
tego samego kroku i czasu jest idempotentna. Granice muszą mieć skończony,
nieujemny czas, a czas końca nie może poprzedzać początku.

Przedwczesne zakończenie/Stop/błąd runnera zachowuje jego wynik i dowody;
capture jest zamykany najwyżej raz. Błąd opóźnionego startu/Stop/hashowania nie
zastępuje wyniku obliczeń ani nie powoduje replay. Błąd diagnostyki raportujemy
w receipcie. Nie dodajemy błędu na każdy późniejszy callback.

## Dowody i interpretacja

Format natywnego NDJSON i C ABI pozostają V1. V2 publikuje osobny
`worker_cuda_trace.v2.json`, z `schema_version=worker_cuda_trace.v2` oraz
`trace_file=worker_cuda_trace.v1.ndjson`. Nie zapisuje równocześnie receiptu V1.
To chroni starego czytnika przed interpretowaniem wybranego zakresu jako całości.

Receipt zachowuje identity/config/digest/PID/GPU UUID/outcome/hash/liczniki jak
V1, a dla V2 wymaga `accepted_step_window` z dokładnymi polami:

- `start_after_step`, `end_after_step`: żądane granice;
- `observed_start_step`, `observed_end_step`: u64 lub null;
- `observed_start_time_s`, `observed_end_time_s`: f64 lub null;
- `completed`: bool;
- `completion_reason`: `completed`, `start_boundary_missed`,
  `invalid_observation`, `start_failed`, `stop_failed`, `solver_finished_before_start`
  albo `solver_finished_before_end`;
- `capture_wall_seconds`: nieujemny czas od native start do native stop,
  lub 0 jeśli native nie wystartował.

`total_wall_seconds` V2 nadal opisuje cały czas życia wrappera, więc nie jest
mianownikiem wykorzystania wybranego zakresu. Analyzer używa dla V2
`capture_wall_seconds` w kontroli zgodności zegara i jawnie zwraca scope
`accepted_step_window`; V1 zachowuje dotychczasową semantykę. Unie kerneli są
czasem śladu, nie sprzętowym utilization ani czasem całego SP4.

`complete` wymaga dokładnie osiągniętych granic N/M, ważnych czasów i licznika
kroków oraz dotychczasowych warunków: zgodna identity, hash/rozmiar,
status native0, API28, dodatnia liczba rekordów, brak dropped/starvation,
unknown/truncated/incomplete, limit flags i błędów I/O/API. Wcześniejszy koniec
lub limit nadal oznacza `partial`; brak poprawnego native start/stop oznacza
`failed`. Późniejszy błąd solvera pozostaje oddzielnym outcome i nie wymazuje
zamkniętego, kompletnego okna. Analyzer odrzuca jednoczesny receipt V1/V2 oraz
niezgodne konfiguracje, granice i digesty.

Wyjątek od obecności native stats jest jawny: V2 zakończony przed początkiem
okna ma `native=null`, oba obserwowane kroki/czasy null, `completed=false`,
`capture_wall_seconds=0`, pusty zahashowany plik oraz status `partial` z powodem
`solver_finished_before_start` albo `start_boundary_missed`/`invalid_observation`.
Nieudany native start ma w tym samym kształcie status `failed`, powód
`start_failed` i niepuste errors; plik może zawierać jedynie zachowane dane
nieudanej inicjalizacji. Analyzer może zwrócić uwierzytelniony status i scope,
ale nie wyprowadza z `native=null` liczników lub czasów GPU. Obserwowane granice
oznaczają skuteczny native start/stop, nie nieudaną próbę ich wywołania.
Przy `stop_failed` dopuszczamy `native=null`, status `failed`, niepuste errors,
poprawną obserwowaną granicę początku i null dla granicy końca; capture wall
może być dodatni. To również wyłącznie metadane diagnostycznej porażki. Jeżeli
nie da się uwierzytelnić stabilnego pliku/hashu, analyzer odmawia analizy.

## Weryfikacja i eksperyment SP4

Testy admission: zgodność V1, pełne V2, digest różny dla innego zakresu,
odrzucenie niepoprawnych typów/pól/granic, CPU/auto/fallback jak dotąd.
Fake-session testy: brak startu przed N, jeden start/stop, idempotentny callback,
pominięta granica, early completion/cancel/drop, błąd start/stop, limity i brak
fałszywego complete. Testy analizatora obejmują V1 i V2, tamper, niepełne okno
oraz odrębny mianownik czasu capture.

Build należy wyłącznie do niezależnej grupy Q na3275, po potwierdzonym idle
i drain. Historyczny CPU A na3274 pozostaje aktywny. Rust unit tests obejmuje
standardowe CI SP4; lokalnie nie uruchamiamy hostowego Cargo. Jeśli potrzebne
są lokalne testy Rust, muszą przejść przez zgodną receptę tej samej grupy.

Po buildzie: osobne trace-off/on5ps z tym samym m(110ps), siatką i biblioteką,
pełnym `.py/.zarr` na ext4 E. Najpierw zakres16–21 i cap512MiB/60s przy lease
storage2GiB. Pięć ciepłych kroków RK45 obejmuje około30rozwiązań Poissona;
dotychczasowe liczniki wskazują wiele wywołań AMG na solve. Samo ograniczenie
cap do64MiB nie jest dowodem, że uzyskamy kompletny ślad. Jeżeli
wybrany zakres przekroczy cap, zachowujemy partial i dobieramy krótszy jawny
zakres w nowym request, bez osłabiania limitów lub podmiany historii. Weryfikujemy
energie wszystkich8składników, m/H, fizyczny torque, dokładne zegary,
residuum1e-12 i brak fallbacku. Capture musi być kompletny bez strat, aby
wybierać z niego następną optymalizację. Miarą przyspieszenia pozostają
nieprofilowane, powtarzane biegi, nie pojedynczy ślad.

Źródła: `accepted_cuda_trace_admission.rs`, `accepted_cuda_trace.rs`,
`accepted_fem_study_worker.rs`, `scripts/analyze_accepted_cuda_trace.py`;
poprzedni kontrakt: plan `2026-11-06-sp4-fem-cupti-profile.md`. Baza źródeł to
cf6f62a34 zawierający master4c9424. Piny konkretnego runtime i wyniki prób
pozostają w operacyjnym checkpointcie SP4 na ext4. Nowy zakres pozostaje
NOT VERIFIED do źródłowych testów i rzeczywistego capture.
