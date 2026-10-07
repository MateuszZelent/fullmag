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


## Zgłoszenie managed i kontroler

- Commit poprawki na remote: `494443d64655b7f65e19bd79bc12b5ad19d26cd8`.
- Working i exact-staged page validator: zero błędów; 35 testów validatora PASS;
  changed-scientific-docs dla tego commita względem edf682970 PASS.
- Job #182: `116603d0835d4309b03b7981d23d89f8`, profil runtime-v2, `queued`.
- Source digest: `6265144754cfa99cc704b8df2517ac77cb7407063efd01d37e2048d2cd5dcc72`.
- Native snapshot: `3111f4966a08a0e031c0f763216dbb400991e4fb4d6abc202aa33539ac0c9425`.
- Capture: `f8513d92772a43508f885c6de3f439e5/source`; snapshot obejmuje wcześniejsze
  tracked WIP oraz jawny untracked `crates/fullmag-runner/src/eigen/tracking_mass.rs`.
  Nie utożsamiać snapshotu z czystym HEAD. Pierwsza próba bez tego wejścia została
  odrzucona przed submit; odczyt request key potwierdził brak joba przed retry.
- Dwa wcześniejsze joby FIFO zachowane. Nie wymieniano koordynatora.
- Kontroler pod `runs/<worktree-id>/<job-id>/comsol-dispersion/periodic-fix-smoke-20260930`:
  żywa sesja 31729, odczyt `build_state=queued`. Po `succeeded`/exit0 uruchomi
  wersjonowany model z 494443d64: Gamma L2/t3, potem DE/BV k25 L2/t3/t6/t9.
  Wrappery pochodzą z niezmiennej kapsuły, runtime jest związany z #182.
  Pierwszy niezerowy exit zatrzymuje serię. Własne wyniki i logi per przypadek.
- Kapsuły #179 nie zmieniono. Kolejka i żywy kontroler nie są dowodem runtime
  ani wyniku naukowego. Brak nowych częstotliwości z poprawionej realizacji.
- Registry worktree zaktualizowany; pełny zakres S00–S12 pozostaje aktywny.
