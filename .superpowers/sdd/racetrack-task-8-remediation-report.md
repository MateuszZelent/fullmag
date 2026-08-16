# Remediacja Task 8 — artefakt i estymator kąta Halla

## Zakres

Naprawiono trzy blokery audytu Task 8 bez zmiany UI ani porównania MuMax:

1. `SkyrmionHallArtifactV1` ma teraz stabilne pola
   `schema_version=skyrmion_hall_angle.v1` i
   `algorithm_version=weighted_gls.v1`, jest serializowalny przez `serde` i
   ma oddzielny payload `hall_angle` zgodny z walidatorem Pythona.
2. Każdy zaakceptowany punkt trajektorii wymaga dodatnio określonej,
   symetrycznej `centre_covariance_m2`; artefakt zachowuje też identyfikację
   zaakceptowanego szeregu $m(t)$, obiektu, geometrii, siatki/supportu oraz
   wersji metody $Q$.
3. Równanie OLS z jednostkowymi wagami zastąpiono GLS z macierzą kowariancji
   dla każdego punktu, wraz z bramkami zredukowanego $chi^2_\nu\le4$ i
   zgodności ruchu z kierunkiem dopasowanej prędkości $d_{\mathrm{coh}}\ge0.95$.

## Fizyczna i numeryczna granica

`centre_covariance_m2` musi pochodzić z kalibrowanego estymatora momentu
gęstości topologicznej. Nie wolno jej zastępować rozmiarem komórki, krawędzią
FEM ani rozdzielczością renderera. Dopóki producent akceptowanych próbek $m(t)$
nie dostarcza takiej kowariancji, wynik Hall angle jest poprawnie fail-closed.
To nadal jest czysty seam analityczny: nie jest jeszcze zasobem v2 ani dowodem
runtime GPU/produkcji.

## TDD i weryfikacja

Najpierw dodano czerwone testy Pythona odrzucające brak aktualnej wersji
algorytmu, brak identyfikacji gridu/mesh oraz wartości poza bramkami GLS. Przed
implementacją walidatora wynik był `2 failed, 6 passed`; po implementacji:

```text
PYTHONPATH=. python3 -m pytest -q -p no:cacheprovider \
  scripts/test_validate_skyrmion_hall_angle.py
10 passed
```

Przeszła również walidacja naukowej mapy źródeł:

```text
PYTHONDONTWRITEBYTECODE=1 python3 \
  .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
```

Zawężony `cargo test -p fullmag-api skyrmion_trajectory --no-default-features`
został uruchomiony z woluminem `/tmp/fullmag-zfn2-build`, ale współdzielony
cache Cargo zgłosił blokadę katalogu artefaktów przed zakończeniem procesu.
Nie jest to wynik pozytywny testu Rust; wymaga ponowienia po zwolnieniu cache.
