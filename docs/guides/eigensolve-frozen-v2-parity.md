# Eigensolve — próba parytetu wykonania z frozen bundle v2

Ta próba sprawdza, czy wykonanie sekwencyjne i adaptacyjna pula procesów
odtwarzają te same wejścia i częstotliwości. Nie zastępuje pełnej kampanii
15 punktów, zbieżności ani porównania z COMSOL-em. Stan implementacji i bramek
pozostaje w [planie wdrożenia](../superpowers/plans/2026-09-12-eigensolve-dispersion-implementation-status.md).

## Wymagane wejścia

Potrzebne są zakończony sukcesem, atestowany job profilu
`fem-cpu-slepc-runtime-v2` oraz rzeczywisty bundle
`fullmag.serial-adaptive-probe-input-manifest.v2`
utworzony przez [generator](../../scripts/freeze_signed_de_probe_inputs.py)
z zaakceptowanego produktu signed15. Bundle i oba wyjścia muszą znajdować się
w kanonicznym storage wskazanym przez resolver. Nie używamy nieukończonej
kampanii, danych zastępczych ani wyników odtworzonych przez symetrię.

Oba tryby korzystają z **tego samego managed build ID i source digest**.
Każdy otrzymuje osobny, nowy katalog wyjściowy. Driver nie buduje runtime'u;
weryfikuje istniejący receipt, tożsamość kapsuły, obraz i artefakty. Bundle
oraz wygenerowany skrypt są montowane tylko do odczytu. Wyjścia, logi i
receipty są zachowywane również przy niepowodzeniu.

## Uruchomienie

Uruchom polecenia z checkoutu zadania. Zmienne poniżej oznaczają zweryfikowane
wejścia operatora, a nie wartości domyślne hosta. Katalogi `SERIAL_OUTPUT`
i `ADAPTIVE_OUTPUT` muszą być różne i jeszcze nie istnieć.

```text
python scripts/run_de_frozen_v2_probe.py --repo-root REPO --job-id BUILD_JOB_ID --runtime-source-digest SOURCE_DIGEST --bundle BUNDLE --mode serial --output-dir SERIAL_OUTPUT
python scripts/run_de_frozen_v2_probe.py --repo-root REPO --job-id BUILD_JOB_ID --runtime-source-digest SOURCE_DIGEST --bundle BUNDLE --mode adaptive --output-dir ADAPTIVE_OUTPUT
python scripts/validate_frozen_v2_execution_parity.py SERIAL_OUTPUT ADAPTIVE_OUTPUT
```

Driver [run_de_frozen_v2_probe.py](../../scripts/run_de_frozen_v2_probe.py)
korzysta z istniejącej zarządzanej trasy Compose i blokady storage.
Opcjonalne `--timeout-seconds` określa deadline solvera; watchdog hosta
zachowuje dodatkowy czas na zakończenie i kontrolę dokładnego kontenera.
Nie należy ponawiać uruchomienia po samym timeout odczytu stanu kontenera.

Próba liczy faktycznie trzy wektory: −10, +10 i ponownie −10 rad/µm
(indeksy źródłowej kampanii 3, 11, 3). Zachowuje stan równowagi, source/modal
MeshIR, pełne okno 8,5–16 GHz, jeden żądany mod oraz receipt-bound
EPS/KSP/FGMRES/restart. Alokacja 4 rdzeni i 8 GiB jest osobno sprawdzana
w kontenerze przez cgroup i affinity; to nie jest dowód wykorzystania zasobów
ani osiągniętej równoległości.

## Kryteria i ograniczenia dowodu

[Walidator artefaktów](../../scripts/validate_de_frozen_v2_probe.py) ponownie
czyta i hashuje obecne pliki. Odtwarza dokładne preimages tożsamości oraz
sprawdza powiązane EQ, LinearizationState, accepted/certified fields i
certyfikat przeliczenia. Sprawdza także source/build, materiał, siatki,
Floquet, potencjał, demag i pełny residual. Zapisane wcześniej pole `pass`
nie zastępuje tej kontroli.

[Walidator parytetu](../../scripts/validate_frozen_v2_execution_parity.py)
sprawdza oba produkty przed porównaniem i ponownie po odczycie raportu puli.
Porównuje 50 pól tożsamości fizycznej. Wyłącza wyłącznie
`consumer_plan_snapshot_sha256` (plan zawiera różny `policy.mode`) i
`content_sha256` pełnej tożsamości. Każda pełna tożsamość i jej preimage
pozostają niezależnie sprawdzane. Hash planu konsumenta nie jest ignorowany
w walidacji pojedynczego produktu.

Częstotliwości wymagają istniejącej tolerancji względnej `1e-8`
z absolutnym floor `1e-6 Hz`, również dla powtórzenia −10 w każdym trybie.
Każdy fizyczny residual musi osobno spełniać próg `1e-8`.
Nie wymagamy identycznej wartości residualu między wykonaniami.
Zmiany progu ani kopiowanie wartości z jednego znaku `k` są niedopuszczalne.

Sukces porównania daje `parity_passed_unqualified`, nadal z
`qualification: NOT VERIFIED`. Raport osobno zawiera współaktywność
procesów i jakość pomiarów CPU/RAM. Dopuszczony brak współaktywności
nie dowodzi skutecznego zrównoleglenia; skrypt nie deklaruje przyspieszenia.
Zbieżności siatki/airboxu/liczby modów, Γ, pełne signed DE/BV, COMSOL A1,
GUI i pozostałe wymagania S00–S12 pozostają odrębnymi bramkami.

Kontrole interpretowane w
[testach drivera](../../scripts/test_run_de_frozen_v2_probe.py) i
[testach porównania](../../scripts/test_validate_frozen_v2_execution_parity.py)
obejmują kontrakty źródeł, zmiany artefaktów i lifecycle na fixture'ach.
Nie stanowią dowodu wykonania solvera na rzeczywistym bundle.
