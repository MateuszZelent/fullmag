# Automatyczne pomiary wydajności przebiegu

Rejestrator `run_performance` jest lekką diagnostyką przy wspólnych wejściach
runnera: plan bez callbacku, callback, live preview, unified interactive,
interaktywne FDM/FEM oraz wspólny core histerezy. Zagnieżdżone adaptery
współdzielą właściciela plików, bez podwójnego writera. Obsługuje ich realizacje
FDM CPU/GPU oraz FEM CPU/GPU. Szczegółowy `SolverProfile` pozostaje opt-in;
rejestrator nie włącza jego dodatkowych synchronizacji, logów ani prób.

W katalogu wyniku etapu powstaje `performance/steps.csv`, `resources.csv`
i `summary.json` (`fullmag.run_performance.v1`). Są to diagnostyki przebiegu,
nie dowód zbieżności, poprawności fizyki ani wznowienia. Prywatny accepted
attempt zachowuje je także przy anulowaniu i błędzie. Identyfikację wykonania
należy połączyć z sąsiednim `metadata.json` i receiptami próby; etykieta
urządzenia z override nie zastępuje rzeczywistej execution provenance.

Callback przekazuje wyłącznie skalary przez ograniczoną kolejkę `try_send`.
Przepełnienie nie blokuje solvera: liczba utraconych rekordów jest jawna.
Powtórzony indeks kroku aktualizuje końcowe liczniki, lecz nie dodaje kroku.
Luki oznaczają obserwowane przedziały/batche — nie generujemy fikcyjnych
rekordów dla brakujących kroków. Ścieżka bez callbacku odczytuje dostępne
statystyki po solve i jawnie nie mierzy opóźnień poszczególnych callbacków.

Czas trwania i szybkość używają zegara monotonicznego. UTC służy identyfikacji.
Surowe `StepStats.wall_time_ns` ma semantykę zależną od realizacji; tylko
jawnie wskazana ścieżka BB korzysta z delty licznika kumulatywnego.
Fazy hostowe, device elapsed i fazy inkluzywne
są rozdzielone; nakładających się faz nie sumuje się jako rozłącznych kosztów.
Starsze niewypełnione pola zerowe pozostają oznaczone jako potencjalnie
niezainstrumentowane. Jedno zero nie stanowi dowodu zerowego kosztu.

Niezależny writer próbuje mierzyć CPU procesu i RSS raz na sekundę. NVML
odczytuje wyłącznie fizyczny UUID przypisany workerowi przez
`CUDA_VISIBLE_DEVICES`, bez utożsamiania indeksów CUDA i NVML. Nie tworzy
kontekstu CUDA. GPU utilization, VRAM, moc i temperatura dotyczą całego
urządzenia, nie procesu ani occupancy. Nieobsługiwane pomiary mają `null`
oraz przyczynę/status; brak GPU w realizacji CPU ma stan N/A. Nie uruchamia
się `nvidia-smi` co krok. Błędy diagnostyk nie zmieniają wyniku obliczeń.

Raport i wykresy powstają bez uruchamiania solvera:

```sh
python3 -B scripts/report_run_performance.py \
  --run /absolute/run-or-performance-directory \
  --output-dir /absolute/report-directory
```

Raport zawiera szybkość okna i całego przebiegu, pokrycie, zasoby, narzut
callbacku, hashe surowych danych oraz PNG/PDF. Wykresy używają ograniczonych
koszyków czasu obejmujących cały przebieg. Opcjonalny `--baseline` daje
porównanie opisowe; deklaracja przyspieszenia wymaga zgodności geometrii,
materiałów, stanu, tolerancji, precyzji, publikacji i warunków hosta. Czas
do tolerancji, energie, torque i odrzucone próby pozostają częścią oceny.

Granice kwalifikacji: źródła/testy parsera, build, pomiar runtime, parytet
numeryczny i przeglądarka są odrębnymi dowodami. Ten kontrakt nie deklaruje,
że dana ścieżka ma zmierzony czas każdego kernela ani że wykresy zostały
już zakwalifikowane w każdej realizacji.

## Control Room i odświeżanie

`GET /v2/sessions/current/diagnostics/performance` udostępnia osobny,
typowany `RunPerformanceResource`. Panel „Automatic performance” w zakładce
Engine pobiera go przez wspólną fasadę i session-scoped resource hook.
Szybkość „Stage rate” używa rozpiętości indeksów kroków i monotonicznego czasu
etapu runnera: obejmuje jego inicjalizację/finalizację, a przygotowanie siatki
i admission mają odrębny zakres. Wykres zawiera jawnie ostatnie 120 próbek.

Writer aktualizuje atomowo `performance/live.v1.json` co sekundę i po końcu
przebiegu, bez synchronizacji ani zapisu JSON w callbacku solvera. Istniejący
tick projektora publikuje invalidację wyłącznie po zmianie sekwencji/stanu;
WebSocket nie przenosi próbek. Endpoint stosuje ETag. Brak wartości jest
`null`/N/A; brak zweryfikowanej próby jest odrębnym stanem.

Tożsamość run/task/stage/attempt/epoch pochodzi z accepted workera. API
wybiera ścieżkę na podstawie katalogu i weryfikuje claim, lease i receipty;
nie przyjmuje ścieżek od klienta. Snapshot ma limit 128 KiB i 120 punktów,
sprawdzane są zegary, zakresy i skończoność liczb. Absolutne ścieżki oraz
wewnętrzna obwoluta rejestratora pozostają prywatne. Chwilowe zajęcie store
zwraca `409 performance_observation_busy`: invalidator odracza odczyt,
a cache UI zachowuje ostatnie poprawne dane z oznaczeniem odświeżania.
Rzeczywista niezgodność próby odcina poprzednie dane.
