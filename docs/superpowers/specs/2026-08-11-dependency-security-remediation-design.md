# Produkcyjna remediacja podatności zależności

Data: 2026-08-11

## Cel

Celem jest usunięcie wszystkich otwartych alertów Dependabota, dla których
istnieje bezpieczna ścieżka naprawy, bez naruszania publicznych kontraktów
Fullmag, bez zmiany Next.js poza linię 16 i bez maskowania alertów przez
nieuzasadnione wykluczenia. Alerty bez dostępnej wersji naprawionej muszą zostać
ograniczone przez usunięcie ścieżki zależności albo jawnie udokumentowane jako
tymczasowo nierozwiązywalne.

Stan wejściowy z GitHub Dependabot obejmuje 50 otwartych alertów npm i Rust.
Największe grupy dotyczą Next.js, brace-expansion, postcss, js-yaml, nanoid,
image-size, Vite i PyO3.

## Zasady

1. Remediacja jest podzielona na niezależne etapy npm i Rust.
2. Aktualizowane są minimalne wersje potrzebne do zamknięcia alertów.
3. Next.js pozostaje w linii 16.
4. Nie wyłączamy skanowania, nie usuwamy lockfile i nie akceptujemy ryzyka bez
   analizy ekspozycji.
5. Każdy etap ma osobny commit i własne bramki regresji.
6. Stan końcowy wynika z grafu zależności, testów i ponownego odczytu
   Dependabota, a nie wyłącznie ze zmiany numeru wersji.

## Zakres npm

- Zidentyfikować właściciela każdej podatnej zależności przez graf pnpm.
- Aktualizować bezpośrednie zależności do najniższych bezpiecznych,
  kompatybilnych wersji.
- Stosować pnpm overrides tylko dla zależności przechodnich, gdy wymuszona
  wersja zachowuje zgodność API.
- Utrzymać Next.js 16 i zweryfikować integrację z React 19.
- Osobno przeanalizować image-size, ponieważ dwa alerty nie wskazują wersji
  naprawionej. Kolejność: usunięcie nieużywanej ścieżki, aktualizacja
  właściciela, odcięcie niezaufanych obrazów, a dopiero na końcu udokumentowane
  pozostawienie alertu.

## Zakres Rust

- Zidentyfikować ścieżki do pyo3, glib, quinn-proto i serde_with przez cargo
  tree.
- Aktualizować zależności bezpośrednie oraz lockfile bez przypadkowej
  aktualizacji całego ekosystemu.
- Dla PyO3 0.29 wykonać jawny audyt zmian API w bindingach Python.
- Dla glib ustalić, czy podatna wersja należy wyłącznie do aplikacji desktopowej
  i uruchomić testy tej powierzchni.
- Native FEM/MFEM/CUDA nie jest przedmiotem zmiany. Gdyby graf nieoczekiwanie
  dotknął tej części, obowiązują kontenerowe receptury just.

## Przepływ

1. Zapisać migawkę alertów: numer, ekosystem, pakiet, wersja podatna, minimalna
   wersja naprawiona i manifest.
2. Zbudować mapę alert -> właściciel zależności -> powierzchnia produktu.
3. Wykonać etap npm i sprawdzić lokalny audyt grafu.
4. Wykonać etap Rust i sprawdzić raport RustSec.
5. Uruchomić bramki regresji.
6. Wypchnąć gałąź i ponownie odczytać Dependabot po przeliczeniu grafu.
7. Dla alertów pozostałych utworzyć rejestr z przyczyną, ekspozycją i
   konkretnym warunkiem zamknięcia.

## Ryzyka i błędy

- Konflikt zakresów wersji zatrzymuje etap; nie stosujemy opcji force.
- Aktualizacja major wymagająca zmian kodu jest pokrywana testami właściwej
  powierzchni.
- Jeżeli zależność bez poprawki jest osiągalna dla niezaufanych danych w
  produkcji, etap nie jest zakończony bez usunięcia albo technicznego odcięcia
  tej ścieżki.
- Alert narzędzia developerskiego może pozostać tylko z dowodem braku ekspozycji
  produkcyjnej i planem aktualizacji.
- Nie zamykamy ręcznie alertów, dopóki graf i kod nie potwierdzą klasyfikacji.

## Weryfikacja

Minimalne bramki:

- instalacja pnpm z zamrożonym lockfile;
- lokalny audyt pnpm i brak podatnych wersji w pnpm-lock.yaml;
- testy wszystkich workspace npm dotkniętych aktualizacją;
- Control Room: testy, typecheck, lint i produkcyjny build;
- testy desktopowe, jeżeli zmieni się jego graf;
- cargo check workspace i testy crate'ów dotkniętych aktualizacją;
- testy bindingów Python po aktualizacji PyO3;
- git diff check;
- ponowny odczyt otwartych alertów Dependabota.

Testy przeglądarkowe są wymagane, jeśli aktualizacja Next.js, ECharts lub Vite
zmieni zachowanie runtime, bundlera albo renderowania.

## Kryteria ukończenia

1. Wszystkie alerty z dostępną i kompatybilną poprawką są zamknięte.
2. Nie ma regresji w testach, typechecku, lintowaniu ani buildzie.
3. Next.js pozostaje w wersji 16.
4. Żaden alert nie został ukryty bez uzasadnienia technicznego.
5. Każdy alert bez poprawki ma udokumentowaną ekspozycję, ograniczenie ryzyka,
   właściciela i warunek zamknięcia.
6. Commity npm i Rust są rozdzielone i możliwe do niezależnego review.

## Poza zakresem

- zmiana architektury aplikacji;
- aktualizowanie niezwiązanych zależności;
- migracja Next.js do kolejnej wersji głównej;
- refaktory niezwiązane z kompatybilnością aktualizowanych zależności;
- ręczne zamykanie alertów bez usunięcia podatnej wersji lub zatwierdzonej,
  udokumentowanej analizy braku ekspozycji.
