# Zadanie 8 — obserwabla trajektorii i kąta Halla

## Zakres wykonany

Dodano backend-neutralny, typowany kontrakt `SkyrmionTrajectoryV1` oraz
`SkyrmionHallAngleV1` w `crates/fullmag-api/src/analysis/skyrmion_trajectory.rs`.
Funkcja przyjmuje wyłącznie zaakceptowaną serię próbek z podpisaną gęstością
topologiczną, środkiem w metrach, odległością od krawędzi, podpisanym prądem i
pełną tożsamością rewizji. Nie pobiera danych z renderera ani z niezweryfikowanej
tablicy UI.

Algorytm wykonuje:

- walidację monotonicznego czasu/sekwencji oraz wspólnej proweniencji;
- fail-closed kontrolę znaku i wartości $|Q|$, odległości od krawędzi i liczby
  próbek;
- wybór najdłuższego okna o stabilnej prędkości na podstawie danych, bez
  stałego indeksu ramki;
- regresję pozycji $x(t),y(t)$, macierz kowariancji prędkości, residua,
  średni podpisany prąd i `atan2(v_perp,v_parallel)`.

Kody odrzucenia to `no_motion`, `topology_lost`, `edge_contaminated`,
`no_stationary_window` i `insufficient_samples`.

Dodano również `scripts/validate_skyrmion_hall_angle.py`, który waliduje
serializowany artefakt, zgodność `atan2`, kowariancję, okno regresji oraz
proweniencję. Jest to walidator artefaktu, nie substytut materializacji serii
magnetyzacji z runtime.

## Dowody

```text
CARGO_TARGET_DIR=/tmp/fullmag-racetrack-api-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api skyrmion_trajectory -- --nocapture
```

Wynik: `9 passed`. Testy obejmują ruch 30 stopni, odwrócenie prądu, zmianę osi,
szum heteroscedastyczny, brak ruchu, utratę topologii, skażenie krawędzi,
zbyt krótkie okno oraz zbyt małą liczbę próbek.

## Granica integracji

Aktualny v2 resource-first API nie ma jeszcze zaakceptowanego, wersjonowanego
zasobu czasowej serii magnetyzacji z rewizją snapshotu/mesha. Dlatego nie
dodano fikcyjnego endpointu, OpenAPI ani panelu, który obchodziłby ten brak.
Moduł jest bezpiecznym seamem obliczeniowym; publikacja HTTP/UI wymaga osobnej
bramki materializacji serii i zachowania tej samej proweniencji. Do tego czasu
obserwabla nie jest dowodem produkcyjnego runtime ani kwalifikacji GPU.
