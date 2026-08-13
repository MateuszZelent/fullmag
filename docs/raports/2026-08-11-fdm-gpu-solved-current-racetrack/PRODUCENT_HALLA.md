# Producent obserwabli kąta Halla — etap 1 racetracka

## Zakres i status

Dodano fail-closed producenta artefaktu `skyrmion_hall_angle.v1` dla FDM.
Producent odtwarza trajektorię wyłącznie z zaakceptowanego
`fields/m.zarr` oraz z wersjonowanych artefaktów siatki i maski FMRM. Nie
czyta danych z renderera, nie przyjmuje gotowego środka skyrmionu i nie
uruchamia ukrytego fallbacku.

Implementacja:

- `scripts/build_skyrmion_hall_artifact.py` — odczyt Zarr v2, walidacja FMRM,
  ładunek Berg–Lüscher, środek ważony podpisaną gęstością, odległość od
  krawędzi i ważona regresja GLS;
- `scripts/test_build_skyrmion_hall_artifact.py` — testy źródła, odrzuceń,
  krótkiego przebiegu i zaakceptowanego okna ruchu;
- `justfile` — receptury `build-fdm-racetrack-hall-artifact` i
  `verify-fdm-racetrack-hall-artifact`.

## Fizyka i algorytm

Na regularnej płaszczyźnie FDM każda komórka jest dzielona na dwa trójkąty.
Dla znormalizowanych wektorów magnetyzacji trójkąta używana jest orientowana
geometria sferyczna:

\[
q_T = \frac{1}{4\pi}2\operatorname{atan2}
\left(\mathbf m_1\cdot(\mathbf m_2\times\mathbf m_3),
1+\mathbf m_1\cdot\mathbf m_2+\mathbf m_2\cdot\mathbf m_3+
\mathbf m_3\cdot\mathbf m_1\right).
\]

Całkowity ładunek to `Q = Σ q_T`, a położenie jest momentem podpisanej
gęstości trójkątnej. Odległość krawędzi jest minimalną odległością środka od
granic prostokątnego, magnetycznego supportu FDM. Niepewność każdej próbki
jest publikowana jako `diag(dx²/12, dy²/12)` i ma jawny status
`provisional_cell_quantization`; to nie jest jeszcze kalibracja produkcyjna.

Regresja `weighted_gls.v1` modeluje `x(t)` i `y(t)` wspólnym dopasowaniem
liniowym. Artefakt zawiera macierz kowariancji prędkości, reszty, zredukowane
`χ²`, koherencję kierunku i średni podpisany prąd. Okno jest dopuszczane tylko
przy co najmniej 21 próbkach, czasie 100 ps, stabilnym `Q`, przemieszczeniu
co najmniej 4 nm, średniej prędkości co najmniej 1 m/s, CV prędkości nie
większym niż 0,10, `χ² ≤ 4` i koherencji co najmniej 0,95.

## Fail-closed i proweniencja

Artefakt przechowuje `field_revision`, `mesh_revision`, identyfikatory
generacji siatki/domeny, digest mapowania węzłów, `cache_key_digest`, stage
oraz źródło serii `m`. Producent odrzuca kompresję lub filtry Zarr, niepełne
chunki, niespójny FMRM, brak aktywnego supportu, więcej niż jedną populowaną
płaszczyznę, nieprostokątny support, nieprawidłowe wektory i
niekonserwatywne terminale prądu.

Krótki przebieg może wygenerować prawidłowy artefakt odrzucony z
`reason_code = insufficient_samples`; nie publikuje pozornego kąta Halla.

## Dowody

Ukierunkowany zestaw testów Python obejmujący kontrakt scenariusza,
producenta Halla, comparator MuMax i walidator artefaktu:

```text
37 passed in 6.27s
```

Na zapisanym krótkim przebiegu FDM CUDA (`fdm_gpu`, `cuda:0`, `double`,
`strict`, 2 próbki `m`) producent odtworzył:

```text
Q[0] = -0.9999996915460616
Q[1] = -0.9999994351779845
reason_code = insufficient_samples
```

Receptura:

```text
just verify-fdm-racetrack-hall-artifact <stage_06_flat_run>
```

zakończyła się poprawnie. Jest to dowód ścieżki źródło → obserwabla i
odrzucenia przy zbyt krótkiej serii, ale nie jest jeszcze kwalifikacją
produkcyjną GPU ani porównaniem z MuMax.

## Pozostałe bramki etapu 1

Nadal wymagane są:

1. pełny zarządzany przebieg z co najmniej 21 próbkami na każdym z sześciu
   prądów;
2. kalibracja niepewności środka i niezależna kontrola zbieżności siatki oraz
   kroku czasu;
3. publikacja obserwabli jako kanonicznego zasobu v2/UI;
4. rzeczywiste common-limit Fullmag↔MuMax z manifestami, OVF i tabelą;
5. osobne kwalifikacje FEM — obecny dowód dotyczy wyłącznie FDM.

Artefakt ma status `analysis_only_until_managed_runtime_and_uncertainty_gate`
i nie zmienia macierzy capability ani statusu produkcyjnego solvera.
