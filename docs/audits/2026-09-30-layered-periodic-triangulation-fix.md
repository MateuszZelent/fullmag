# Korekta periodycznej siatki warstwowej — 2026-09-30

## Problem i poprawka

Kontynuacja audytu `2026-09-30-layered-periodic-triangulation-blocker.md`.
Sześć runtime #179 było terminalnie odrzuconych przed solverem.

1. GEO Layers wybierało rozbieżne przekątne przeciwległych ścian. Nowy wewnętrzny
   podział pomocniczych prism6 i quad4 stosuje wspólny porządek kolumn x/y.
   Wynik: tet4/tri3, zachowane nodes, exact planes i physical entities/markers.
2. Test incydencji ujawnił interfejs magnetic–air oznaczony jako exterior.
   Bbox-extrema uznawało poziomą płaszczyznę interfejsu za powierzchnię zewnętrzną.
   Brzeg połączonych volumes eliminuje te wewnętrzne płaszczyzny z Gamma_out.
   Nie zmieniono warunków fizycznych ani nie wyłączono walidacji certyfikatu.

Dokumentacja kanoniczna: `docs/physics/0104-thin-film-shared-domain-meshing.md`,
sekcja `thin-film-periodic-tetrahedral-layer-realization`, z source-map.

## Dowody i zakres

RED: real-Gmsh Box 3 warstwy — niepełna bijekcja x_faces.
Po poprawce: 26 testów `scripts/test_box_layered_airbox_mesh.py` PASS,
następnie pięć nowych testów `-k prism_subdivision` PASS. Łącznie 31 różnych
zielonych przypadków. Nie kompilowano testów Rust/native.

- Certyfikat Python x/y i commutation: Box 3/6/9; ring 1/2/3.
- Ściany tet mają najwyżej dwie komórki; interface dokładnie dwie,
  exterior/periodic dokładnie jedną; brak duplikatów facetów.
- Wszystkie jednowłaścicielskie ściany tet pokryte facetami exterior/periodic:
  brak pozostawionej szczeliny wewnętrznej.
- Dodatnie wyznaczniki, całkowita objętość airboxu i dokładne płaszczyzny filmu.
- Podział niezależny od lokalnej kolejności wierzchołków, translacji i skali.
- Niepionowy pryzmat odrzucany przed mutacją Gmsh.
- Istniejący public-model shared-domain test oraz zachowanie hmax przechodzą.

Niezależne bramki nadal otwarte: Rust v6, managed runtime po zmianie,
częstotliwości DE/BV/Γ, residual, zbieżność i analityka/COMSOL, browser/GPU,
integracja pełnego zadania S00–S12. Nie twierdzimy, że zmiana wyjaśniła rozbieżność
częstotliwości starych siatek; błąd dotyczy odrzuconej realizacji warstwowej #179.

## Następna realizacja

Nowy immutable snapshot profilu runtime-v2 musi zawierać helper i poprawioną
klasyfikację. Starej kapsuły #179 nie modyfikować; brak podmiany PYTHONPATH
pod istniejącym receipt. Oczekiwany pierwszy rezultat: przejście v6 przed
wyborem modów; potem mała seria Γ/DE/BV oraz kontrola potencjału fizycznego.
Storage był poniżej progu admission 8 GiB; nie usuwać danych bez autoryzacji.
