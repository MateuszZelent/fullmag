# S04/S07 — powiązanie potencjału z modem

## Błąd i naprawa

Kontrola H=-grad(phi) mogła zaakceptować pole o poprawnym gradiencie, lecz z deklaracją fazy lub operatora innego modu. Regresja wykonana przeciw wcześniejszej funkcji pilota wykazała brak oczekiwanego odrzucenia.

Pilot wymaga teraz opublikowanego mode JSON i zgodności sample_index, raw_mode_index, fingerprintów siatki, operatora i ograniczeń fazowych. Walidator odrzuca sprzeczne indeksy, błędne typy, powtórzone klucze JSON i niekanoniczne ścieżki manifestu/sidecarów. Samodzielny walidator zachowuje opcjonalną kontrolę tożsamości; pilot wymaga jej bezwarunkowo.

## Dowody

- 16 testów walidatora + 18 testów pilota: PASS. Są to lekkie testy Python, bez kompilacji testów natywnych.
- Source-map strony 0831: PASS po wskazaniu deklaracji klasy testowej.
- Niezależne ponowne przetworzenie 9 zachowanych artefaktów joba #173: 9 consistent, 0 błędów. Raport: storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/physical-potential-mode-binding-20260930/historical-job-173.json; zawiera hash walidatora i deklaracje tożsamości artefaktów.

Zgodność deklaracji nie jest niezależnym przeliczeniem fingerprintu siatki, sprawdzeniem równania Poissona, normalizacji względem magnetyzacji ani zbieżności fizycznej. Kwalifikacja pozostaje NOT VERIFIED. Wyniki #173 pochodzą sprzed naprawy periodycznej siatki.

## Kolejny krok

Job #182 (116603d0835d4309b03b7981d23d89f8) pozostaje queued za wykonywanym #181. Zdrowy worker przyjmuje zadania; ostatni odczyt runnera: 18 484 011 008 B wolnego. Kontroler 31729 obserwuje to samo zgłoszenie i po sukcesie wykona Γ, DE/BV k=25e6 rad/m, L2 oraz 3/6/9 warstw. Nie usuwano danych i nie tworzono duplikatu.

Nowa kontrola nie jest częścią niezmiennej kapsuły #182. Zastosujemy ją osobno do nowych wyników i zachowamy tożsamość postprocessingu; nie zmieniamy receipt buildu. Następnie: residual, periodyczność, demag, zbieżność siatki/airboxu i porównanie do oracle. Pełny plan S00–S12 pozostaje otwarty.
