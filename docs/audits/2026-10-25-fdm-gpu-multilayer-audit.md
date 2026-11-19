# Audyt FDM i gotowości multilayer convolution na GPU

Data: 2026-10-25. Checkout: `/home/kkingstoun/git/fullmag/fullmag`, branch
`master`, bazowy HEAD `28f4fcf5bba4387025944b8fb276c94b3eef5eb5`.

Status: audyt źródeł i lekkie eksperymenty verifiera. **Nie jest to kwalifikacja
runtime ani deklaracja poprawności całego FDM.** Nie zmieniano solvera, nie
budowano aplikacji ani testów jednostkowych, nie uruchamiano symulacji GPU.
Zastany stan: zmodyfikowany submoduł `external_solvers/3`; pozostawiony bez zmian.
`git status` zgłosił brak dostępu do pięciu katalogów `examples/.fullmag-tmp/`;
ich zawartość nie została objęta audytem.

## 1. Wniosek

Multilayer convolution istnieje już w kodzie. Praca wdrożeniowa powinna
rozszerzać i kwalifikować istniejącą realizację, zamiast budować drugi solver.
Publiczna ścieżka CUDA świadomie blokuje kluczowe klasy stosów: `two_d_stack`,
transfer `push_pull`, nierówne natywne grubości komórek Z i przesunięcia XY.
Jest to ograniczenie funkcjonalne, nie dowód błędnych obliczeń dla tych wejść:
odmowa następuje przed sondowaniem urządzenia i alokacją.

W natywnym kroku CUDA znaleziono brak walidacji skończoności dt i kandydata
Heuna. W CPU skalarna energia exchange pomija periodyczne wiązania brzegowe.
W verifierze kwalifikacyjnym odtworzono dwa niezależne problemy: pomijanie
wartości wcześniejszych klatek oraz brak zgodności tożsamości warstw i kroków
między referencją a kandydatem. Przechodzące testy nie wykrywają tych luk.
Naprawa bramek dowodowych musi poprzedzać rozszerzenie deklarowanego wsparcia.

## 2. Kontrakty i zakres

Kanoniczne źródła intencji:

- `docs/architecture/backend-golden-masterplan.md`, sekcja 8: Rust
  `CpuReference` jako bieżąca realizacja CPU, natywne CUDA pod `backends/fdm`.
- `docs/physics/0421-fdm-multilayer-convolution-demag.md`: tensor pary
  źródło–cel, orientacja przesunięcia, objętościowa wzajemność, transfer
  zachowujący moment i sprzężony operator powrotu.
- `docs/physics/0400-fdm-exchange-demag-zeeman.md`: bazowy kontrakt FDM.
- `docs/superpowers/plans/2026-08-09-fdm-multilayer-convolution.md` oraz
  `docs/audits/2026-08-11-fdm-multilayer-convolution-implementation-audit.md`:
  historyczny plan i findingi wymagające ponownej oceny w bieżącym kodzie.

To wewnętrzny audyt, nie nowa terminalna publikacja fizyki. Równania i API
pozostają w istniejących notach wraz z source-map. Nie przenosi się tutaj ich
statusu kwalifikacji. FEM CPU/GPU są poza zakresem zmian i nie dziedziczą
wyników FDM. Browser/WebGL i niezależna walidacja fizyczna: **NOT VERIFIED**
w tej sesji.

## 3. Aktualne ścieżki multilayer

| Obszar | Stan stwierdzony w źródłach | Granica dowodu |
|---|---|---|
| FDM CPU | Descriptorowy operator referencyjny, osobne siatki natywne i scratch, katalog par | Kod/testy w repo nie zastępują świeżego niezależnego oracle |
| CUDA native multilayer | Wybierany dla demag, FP64, fixed Heun, `three_d`, identity i wspólnych zgodnych siatek; Frozen Spins wyklucza tę ścieżkę | Nie uruchomiono urządzenia ani parity |
| CUDA assisted | Zachowana odrębna ścieżka dla pozostałych dozwolonych kombinacji, m.in. części integratorów i FP32 | Nie wolno opisywać jej jako całego kroku rezydentnego na GPU |
| CUDA native stacked | Zgodne warstwy mogą korzystać z single-grid; warunek wyboru obejmuje requested strategy `auto` i integrator inny niż Heun | Jawne `multilayer_convolution` nie jest automatycznie tą ścieżką |
| `two_d_stack` z demag na CUDA | Jawna odmowa | Brak publicznego wsparcia |
| `push_pull`, nierówne native hz, XY-offset z demag na CUDA | Jawna odmowa | Obecność niskopoziomowych kerneli nie znosi tej bramki |
| Materiały komórkowe CUDA multilayer | `ms_field`, `a_field`, `alpha_field` odrzucane | Jednorodne parametry każdej warstwy i parametry różne między warstwami to osobne przypadki |
| GPU FP32 production gate | Verifier wymaga native residency, a selektor rezydentny wymaga FP64 | Brama pozostaje zamknięta do wdrożenia i kwalifikacji FP32 |

Kotwice: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs` ::
`execute_cuda_fdm_multilayer_with_live`, `validate_device_resident_cuda_multilayer_lane`,
`validate_cuda_multilayer_execution_contract`, `validate_accepted_fdm_multilayer_cuda_lane`;
`crates/fullmag-plan/src/fdm.rs` :: `fdm_multilayer_cuda_containment_reason_codes`,
`fdm_multilayer_cuda_material_field_errors`;
`crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` :: `reject_cuda_multilayer_containment`.

## 4. Potwierdzone findingi

Priorytet napraw: A04/A05 (akceptacja stanu), A03 (energia), A01/A02 (dowody),
A06 przed rozszerzeniem obsługi transferu. A01/A02 odtworzono wykonawczo w
Pythonie; A03–A06 są findingami źródłowymi, bez uruchomienia binarnego solvera.

### FDM-A01 — P1 / Required: verifier nie sprawdza wartości całej zapisanej trajektorii

**Źródło:** `scripts/verify_fdm_multilayer_cuda_parity.py` :: `field_artifact`,
linie 145–158; `verify` korzysta z tak zredukowanego pola.

Wszystkie klatki przechodzą kontrolę kształtu i typów, lecz do porównania i
kontroli `isfinite` trafia tylko `paths[-1]`. Uszkodzenie wcześniejszej klatki,
nawet `NaN`, nie blokuje statusu `qualified`, jeśli ostatnia klatka jest poprawna.
Metadane i liczniki nadal opisują wszystkie snapshoty. Nie jest to dowód
błędu solvera, tylko fałszywie pozytywnego wyniku bramki.

**Reprodukcja:** oficjalne syntetyczne fixture'y verifiera; zmiana jednej
składowej `layer-0/step_000000.json` na `NaN`. Wynik: `qualified`.

**Naprawa:** kontrolować skończoność każdej wartości i porównywać odpowiadające
sobie klatki. Jeśli zamierzony zakres to wyłącznie ostatnie pole, status musi
to jawnie deklarować, a walidacja całej trajektorii wymaga osobnej bramki.
Regresje: wcześniejszy NaN/Inf oraz duży skończony błąd przy zgodnej ostatniej
klatce. Nie zmniejszać progu tolerancji w celu obejścia błędu.

### FDM-A02 — P1 / Required: parity nie wiąże warstw i kroków obu przebiegów

**Źródło:** `scripts/verify_fdm_multilayer_cuda_parity.py` :: `FieldArtifact`,
`field_artifact`, `verify`, szczególnie linie 260–265.

Porównanie geometrii sprawdza wyłącznie wektor liczby komórek. ID warstw i
nazwy snapshotów nie są przechowywane w `FieldArtifact`; liczba klatek jest
porównywana bez sprawdzenia odpowiadających kroków/czasów. Zmiana ID pierwszej
warstwy nie powoduje błędu. Przenumerowanie wszystkich kroków kandydata z
0/1 na 100/101 również kończy się `qualified`.

**Wpływ:** bramka może porównać różne warstwy lub różne chwile fizyczne i
potraktować zgodne liczby jako parity. Zewnętrzna recepta wiążąca źródła nie
zastępuje sprawdzenia semantycznej tożsamości pola przez verifier.

**Naprawa:** przenosić uporządkowaną tożsamość object/layer, fingerprint siatki,
kształt, spacing/origin, maskę i tożsamość kroku/czasu; weryfikować je przed
porównaniem wartości. Jawnie określić, które identyfikatory mogą różnić się
między dwoma niezależnymi uruchomieniami, zamiast porównywać run ID wprost.
Regresje: inne ID, zamiana warstw o tej samej liczbie komórek, inne kroki/czasy,
inny grid przy tym samym `value_count`.

### FDM-A03 — P1 / Required: skalarna energia exchange CPU pomija wiązania periodyczne

**Źródło:** `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs` ::
`ExchangeLlgProblem::exchange_energy_from_vectors`, linie 143–198;
`crates/fullmag-engine/src/fdm/shared/problem.rs` :: `exchange_energy`,
linie 432–438. Porównanie: `fdm/cpu/fields/exchange.rs` ::
`cell_exchange_field`, linie 54–65, oraz `exchange_field_from_vectors`.

Suma energii przechodzi tylko do sąsiada o większym indeksie mieszczącego się
w gridzie; nie czyta `boundary_policy`. Pole exchange zawija sąsiadów na
osiach periodycznych. `exchange_energy_density` liczy energię z tego pola,
więc jej całka nie zgadza się ze skalarnym `exchange_energy`.

**Konkretny przypadek:** trzy aktywne komórki w osi X, jednorodne dodatnie A,
periodyczność X, jednostkowe spiny `(1,0,0)`, `(0,1,0)`, `(-1,0,0)`.
Bez wiązania ostatnia–pierwsza suma kwadratów różnic wynosi 4, z nim 8.
API skalarne zwraca więc połowę energii periodycznego operatora w tym
przypadku (wspólny mnożnik to A razy objętość komórki podzielone przez dx²).
To wyprowadzenie z kodu, **nie uruchomienie skompilowanego Rust**.

**Zakres wpływu:** publiczna metoda silnika i jej konsumenci. Zwykłe
observables używające `exchange_energy_from_field` nie mają wykazanego tutaj
tego samego błędu; nie rozszerzać findingu na wszystkie raporty energii.

**Naprawa:** skorzystać ze wspólnego operatora/energii field-dot albo uwzględnić
periodyczne wiązanie dodatniej ściany dokładnie zgodnie z dyskretyzacją pola.
Regresje: energia skalarna = całka gęstości dla periodic/open, siatki X=1,2,3,
maski i niejednorodne A; różniczkowanie energii zgodne z H_ex. Nie budowano
testu regresyjnego z powodu obowiązującego zakazu kompilacji testów.

### FDM-A04 — P1 / Required: ABI kroku przepuszcza NaN i nieskończone dt

**Źródło:** `backends/fdm/api/c_api.cpp` :: `fullmag_fdm_backend_step`,
linie 2141–2146; `execute_multilayer_step_transaction`, linie 594–615.

Warunek `dt_seconds <= 0.0` nie odrzuca NaN ani dodatniej nieskończoności.
Bezpośredni klient ABI może przekazać taką wartość do Heuna. Normalizacja
predictora/correctora nie naprawia NaN, a kontrola błędu CUDA nie wykrywa
niepoprawności liczbowej. Transakcja ma ścieżkę zatwierdzenia takiego kroku.
Nie wykazano obejścia walidacji publicznego DSL; finding dotyczy obowiązku
walidacji na granicy publicznego natywnego ABI.

**Naprawa:** przed zmianą stanu wymagać skończonego, dodatniego dt, a także
skończonego czasu końcowego. Regresja dla NaN, +Inf, -Inf, zera i ujemnego dt:
błąd argumentu, niezmienione m/czas/licznik zaakceptowanych kroków i
nienaruszone statystyki wyjściowe według kontraktu ABI.

### FDM-A05 — P1 / Required: Heun nie ma bramki skończoności kandydata

**Źródło:** `backends/fdm/gpu/cuda/integrators/multilayer_heun.cu` ::
`multilayer_heun_predictor_kernel`, linie 284–292,
`multilayer_heun_corrector_kernel`, linie 323–334;
`backends/fdm/api/c_api.cpp` :: `execute_multilayer_step_transaction`.

Nawet skończone dt i RHS mogą przepełnić kandydat lub obliczenie jego normy.
Implementacja liczy `sqrt(x*x+y*y+z*z)` i mnoży przez odwrotność normy bez
kontroli skończoności. Nieskończona norma może wyzerować skończony wektor,
a nieskończona składowa pomnożona przez zero daje NaN. Żaden z tych stanów
nie musi generować błędu uruchomienia kernela CUDA.

**Naprawa:** stabilne skalowanie przy liczeniu normy oraz jawna flaga błędu
liczbowego etapów i końcowego kandydata, sprawdzana przed commit. Zachować
istniejącą transakcję i rollback; nie wprowadzać dodatkowego pełnego transferu
wektora na host. Nie wystarczy naprawa walidacji dt z A04.
Regresja: skończony skrajny dt/RHS lub kontrolowana iniekcja NaN/Inf; błąd
bez zmiany zaakceptowanego m, czasu i liczników, a kolejny legalny krok działa.
Kontrakt odniesienia: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`,
wymóg skończonego kandydata i transakcyjnego zatwierdzenia.

### FDM-A06 — P1 przed rolloutem / Required: niskopoziomowy transfer CUDA ma inną semantykę

**Źródło:** `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu` ::
`push_multilayer_m_transfer_fp64_kernel`, linie 189–203, oraz odpowiednik FP32;
`backends/fdm/gpu/cuda/runtime/context.cu` :: `build_pull_map_host`, linie 1413–1462.

Push normalizuje sumę przez pokrytą aktywną objętość (`total_weight`), podczas
gdy nota 0421 wymaga pełnej objętości komórki scratch. Przy połowie pokrycia
zamiast połowy gęstości momentu pojawia się pełna wartość. Pull jest
interpolacją trójliniową centrów z clamp, zamiast adjointem objętościowym tego
samego operatora overlap. Nie zachowuje zadeklarowanego kontraktu P/P*.

**Osiągalność:** publiczny planner i runner blokują demag `push_pull`.
Finding nie oznacza błędnych wyników obecnego publicznego D-07 identity.
Oznacza, że nie można wdrożyć transferu przez samo zdjęcie containment ani
uznać istniejących niskopoziomowych kerneli za gotowe.

**Naprawa:** wspólny descriptor overlap z poprawną normalizacją push i wagami
adjoint pull, maskami oraz konwersją scratch/kernel-cell density. Regresje:
częściowe pokrycie, nieaktywne komórki, różne hz, moment, iloczyn skalarny
adjointa i gradient energii, niezależny oracle oraz parity CPU/GPU FP64.

## 5. Luki wdrożeniowe i ryzyka, które nie są potwierdzonymi błędami solvera

1. **P1, zakres funkcji:** wymagane docelowe klasy GPU nadal są blokowane.
   Nie zdejmować containment przed implementacją i niezależnym dowodem pary
   kernel–transfer–energia dla każdej nowej klasy.
2. **P1, kwalifikacja:** pojedynczy scenariusz
   `scenario_l3_cuda_v2_small.py` obejmuje trzy zgodne warstwy i jeden krok
   `1e-14 s`. Nie dowodzi długiej stabilności, zbieżności, różnych siatek,
   różnych grubości ani wszystkich interakcji.
3. **P2, dokumentacja:** macierz kwalifikacji z sierpnia opisuje stare ryzyka
   assisted i stare luki CPU. Obecny containment oraz nowsze testy muszą być
   rozliczone osobno. Historycznej tabeli nie traktować jako aktualnego
   wykazu błędów dostępnych użytkownikowi.
4. **P2, metryka:** `verify` nazywa RMS `weighted_rms`, ale liczy zwykłą średnią
   po składowych bez wag objętości. Dla zgodnych komórek odpowiada to równym
   wagom; przed dopuszczeniem siatek heterogenicznych trzeba zdefiniować
   właściwe wagi i zaktualizować metrykę oraz fixture'y.
5. **P2, utrzymanie:** selekcja ścieżki wykonania występuje zarówno w dispatchu,
   jak i preflight accepted-state. Wspólny jawny wynik selekcji ograniczy
   ryzyko rozjazdu admission/wykonanie; nie jest to samo w sobie dowód błędu.

## 6. Wykonana weryfikacja

| Kontrola | Wynik | Znaczenie |
|---|---|---|
| Checkout / HEAD / status | Odczytano | Tożsamość źródeł podana na początku |
| `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_verify_fdm_multilayer_cuda_parity.py` | **27 passed**, exit 0 | Testy istniejącego verifiera; nie test solvera |
| Wczesny NaN | **Błędnie qualified**, exit 0 skryptu eksperymentu | Odtworzenie A01 |
| Zmienione ID warstwy | **Błędnie qualified**, exit 0 | Odtworzenie A02 |
| Kroki kandydata przesunięte o 100 | **Błędnie qualified**, exit 0 | Odtworzenie A02 niezależnie od NaN |
| Kompilacja Rust/CUDA/C++ | Nie wykonywano | Obowiązuje zakaz kompilowania testów jednostkowych |
| Managed runtime / GPU / performance / fizyka / WebGL | **NOT VERIFIED** | Brak promocji produkcyjnej |

Eksperymenty używały `TemporaryDirectory` pod `/tmp`, importu helperów z
`scripts/test_verify_fdm_multilayer_cuda_parity.py` i nie zmieniały plików
produkcyjnych. Poniższa reprodukcja uruchamiana z root repo zachowuje niezależne
przypadki oraz celowo oczekuje obecnego błędnego wyniku; po naprawie powinien
wystąpić błąd walidacji zamiast wypisania `qualified`:

```python
import importlib.util
import json
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "fixtures", "scripts/test_verify_fdm_multilayer_cuda_parity.py"
)
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

for case in ("early_nan", "layer_id", "step_identity"):
    with tempfile.TemporaryDirectory(prefix="fdm-audit-") as directory:
        cpu, gpu = Path(directory) / "cpu", Path(directory) / "gpu"
        fixtures.write_artifact(cpu, fixtures.cpu_provenance())
        fixtures.write_artifact(gpu, fixtures.candidate_provenance())
        base = gpu / "fields/H_demag"
        if case == "early_nan":
            path = base / "layer-0/step_000000.json"
            payload = json.loads(path.read_text())
            payload["values"][0][0] = float("nan")
            path.write_text(json.dumps(payload))
        elif case == "layer_id":
            path = base / "manifest.json"
            payload = json.loads(path.read_text())
            payload["layers"][0]["id"] = "different-physical-layer"
            path.write_text(json.dumps(payload))
        else:
            for path in base.glob("layer-*/step_*.json"):
                step = int(path.stem[5:]) + 100
                path.rename(path.with_name(f"step_{step:06}.json"))
        result = fixtures.load_verifier().verify(
            cpu, gpu, fixtures.THRESHOLDS, "cuda-fp64"
        )
        print(case, result["status"])
```

## 7. Status decyzji projektowej

Przedstawiono trzy podejścia: kwalifikację wąskiego istniejącego zakresu,
etapowe rozszerzenie o cienkie/heterogeniczne warstwy oraz pełną przebudowę.
Użytkownik wybrał **pełną implementację i pełną przebudowę operatora od razu**,
obejmującą różne rozdzielczości, grubości i przesunięcia warstw.
Powstał [projekt wdrożenia](../superpowers/specs/2026-10-25-fdm-gpu-multilayer-rebuild-design.md),
zaakceptowany przez użytkownika 2026-10-25, oraz
[szczegółowy plan wykonawczy](../superpowers/plans/2026-10-25-fdm-gpu-multilayer-rebuild.md)
obejmujący wszystkie sześć findingów. Zlecenie obejmuje wyłącznie dokumentację;
nie rozpoczęto implementacji solvera.

## 8. Pokrycie przeglądu i dalsze granice

| Podsystem | Przejrzany zakres | Wynik / granica |
|---|---|---|
| CPU exchange / energia | `fields/exchange.rs`, `energy.rs`, `observables.rs`, `shared/problem.rs`, odpowiadające testy w `fullmag-engine/src/lib.rs` | A03; nie kompilowano testów |
| Planner multilayer | `fullmag-plan/src/fdm.rs`, containment, eligibility, materiał i odpowiadające testy | Obecne odmowy chronią przed dawnym błędem heterogenicznego assisted |
| Wybór urządzenia | `solver_runtime/selection.rs`, `solvers/fdm/execute.rs`, CUDA `route.rs` i `multilayer.rs` | W przejrzanych ścieżkach brak potwierdzonego cichego fallbacku forced GPU do CPU |
| Konwolucja CUDA | `multilayer_convolution.cu`, klasyfikacja batch/pair i mapy transferu w `context.cu` | A06; brak znalezionego potwierdzonego błędu FFT w wąskim D-07 nie jest dowodem jego poprawności |
| Integracja CUDA | multilayer Heun, sąsiednia organizacja RK, C ABI transakcja, FFI `native.rs` | A04/A05; bez pełnego przeglądu wszystkich integratorów single-grid |
| Kwalifikacja | verifier CUDA, jego fixture'y/testy, progi, scenariusz L3, recepty `justfile` | A01/A02 i ograniczony zakres scenariusza |
| Ogólna architektura | rozdzielenie CPU reference / native GPU / assisted, requested/resolved, obecne noty i historyczny audyt | Nie rekomenduje się drugiego solvera ani przepisywania całości |
| Termika, STT/SOT, transport spin/charge, pełne DMI i magnetoelastyka, minimizery | Poza szczegółowym przeglądem w tej sesji | **NOT AUDITED**; nie ma podstaw do oceny „cały FDM bez błędów” |
| API/UI/eksport pola i renderer | Odczyt kontekstu i kontraktów, bez pełnego review komponentów | **NOT VERIFIED** wykonawczo |

Przegląd był przekrojowy i priorytetyzował fizykę, granice wykonania oraz
multilayer. Nie był przeglądem każdej linii repozytorium. Dwóch niezależnych
recenzentów źródeł objęło odpowiednio CPU/planner oraz native CUDA; agent
prowadzący sprawdził wskazane ścieżki i odtworzył problemy verifiera.
