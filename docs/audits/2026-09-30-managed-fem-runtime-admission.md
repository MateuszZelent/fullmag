# Dopuszczanie managed runtime FEM — 2026-09-30

## Zmiana

Dependency query z załadowanej biblioteki musi zwrócić native_source_snapshot_sha256
zgodny z kapsułą źródeł. Sam hash pliku, stamp Rust i CMakeCache nie dowodzą
wykonania bieżącego kodu C++. Kontrola działa przy publikacji runtime-only,
publikacji kontraktu modalnego, walidacji receipt i dopuszczaniu benchmarku.
Brak, błędny format lub stary snapshot kończą etap błędem.

Profil runtime-only v2 deklaruje oddzielny CPU MFEM: CUDA OFF, wymagane
MFEM_DIR pod /opt/fullmag-mfem-cpu i sprawdzony przez ldd plik libmfem
w jego katalogu lib, z hashem biblioteki. Obraz benchmarku pochodzi z jawnego,
niezmiennego digestu skonfigurowanego dla danego profilu. Definicja profilu
w źródłach nie oznacza aktywacji na wspólnym runnerze.

Receipt kontraktu modalnego wymaga także rzeczywiście wykonanego dziewiątego
kontraktu shared-domain w JUnit i wykazie wykonanych targetów. Nie uruchomiono
kompilacji ani tego kontraktu podczas tej poprawki; zakaz kompilacji unit tests
pozostaje w mocy.

## Weryfikacja

29 testów build-entrypoint, 16 build-executor i 19 benchmarku: 64 PASS.
Wśród regresji: świeży stamp Rust ze starą biblioteką, brak native bindingu,
stary binding mimo poprawnych ponownie przeliczonych hashy receipt,
kontrola obu profili runtime-only i kontraktu modalnego oraz składnia
pięciu bloków Python osadzonych w skrypcie shell. Nie były kompilowane testy.
Diff/check: PASS. Zmieniono wyłącznie pliki tej ścieżki wykonania i jej testów.

Nie zmieniono historycznych receipt ani dotychczasowych wyników dyspersji.
Stare niepowiązane biblioteki nie mogą służyć do nowych benchmarków.

## Pozostała bramka

Managed build aktualnych źródeł, wynikowy query native binding, CPU MFEM ABI
w rzeczywistym kontenerze oraz runtime solvera: NOT VERIFIED.
Ostatni odczyt runnera: brak aktywnych jobów, worker_alive i accepting_jobs true;
4 931 870 720 B wolnego, mniej niż próg 8 GiB. Runtime-only v1/v2 nie są
na allow-list. Oczekujemy wcześniejszych decyzji operatora o dokładnym cleanupie
execution i profilu; nie usunięto danych, nie zmieniono konfiguracji.

Następnie: kontrolny Gamma i odrzucony DE k12, zagęszczenie DE/BV,
zbieżność siatki/airboxu i ciągłość modów. A1/COMSOL, ścieżka 2.5D,
interakcje lokalne, GPU i pełny workflow UI pozostają osobnymi bramkami planu.
