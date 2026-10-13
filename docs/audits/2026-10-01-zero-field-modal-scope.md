# Eigensolve — zerowe pole równowagi a krzywizna energii

## Przyczyna i zmiana

`validate_shared_domain_modal_scope` odrzucał amplitudę H_eff równą zero.
Skończone zerowe pole spełnia warunek stacjonarności, lecz nie określa
Hessiana energii. Operator wymiany dla niezerowego k może mieć dodatnią
krzywiznę przy jednorodnym stanie o zerowym polu statycznym. Dla u prostopadłego
do m0 i ujemnego Ku pole anizotropii też znika, choć pozostaje dodatnia
krzywizna w kierunku u; w Gamma drugi kierunek może być Goldstone'owski.

Zmieniono warunek na amplitudę skończoną i nieujemną. Dodano odrzucenie
ujemnej amplitudy torque; NaN/Inf pozostają błędami. Kontrole normy m0,
periodycznego szwu, zakresu interakcji, certyfikatów i modalnych residuali
pozostają wymagane. Zerowe pole nie daje gwarancji stabilności ani wyniku f>0.
Publiczny guard Ku pozostaje aktywny do pełnego spięcia tożsamości i runtime.

## Weryfikacja

- Niezależny rachunek energii na sferze: 4 testy Python i 12 podprzypadków PASS.
  Nowy przypadek potwierdza gradient zero i krzywiznę easy-plane, osobno
  granicę Gamma z kierunkiem zerowym i dodatnią krzywiznę obu kierunków po
  dodaniu wymiany dla Fourierowego zaburzenia. Nie wykonuje solvera FEM.
- Dwie regresje Rust przygotowane: akceptacja pola zero, utrzymanie guardu Ku
  oraz odrzucenie ujemnych/NaN/Inf amplitud. Nie kompilowano i nie uruchamiano
  tych testów zgodnie z aktualnym AGENTS.md.
- Dwa pliki Rust: parser rustfmt PASS; nie jest to kontrola typów.
- Nota 0831 i source-map: validator PASS. Public examples guard PASS.
- Runtime tej poprawki: NOT VERIFIED. Kapsuła #188 jest niezmienna i nie
  zawiera poprawki; nie przypisujemy jej wyników do nowego kodu.

## Bieżące wykonanie i pełny cel

#188 succeeded/exit0 i 14 hashy receipt zweryfikowanych wcześniej.
Kontroler90201 i solver7df4be7c5ace nadal wykonują Gamma na własnej kapsule;
ostatni zaobserwowany etap base subwindow4/50, CPU około200%, bez nowego
zaakceptowanego punktu. Nie restartowano procesu ani nie usunięto danych.

Kolejne wymagania: canonical/raw material identity z wersjonowaniem
artefaktów; pełne runtime Ku po odblokowaniu; aktualne DE/BV signed26punktów
plus4kontrole grubości; residuale, profile, phase seam, phi/H_demag i branch;
zbieżność, COMSOL A1, pozostałe interakcje, waveguide, GPU, browser, review,
PR/integracja. Cały plan S00–S12 pozostaje aktywny.

## Review i commit

Przyrost źródeł zapisany i wysłany jako
ab64bac46b7ceda295812da93244b2eba81174e4. Niezależne review nie znalazło
P1/P2 w poprawce Rust/Python; wskazało błędne położenie wiersza noty.
Wiersz przeniesiono do właściwego indeksu źródeł, sprawdzono siedem kolumn
i dodano niezmienny link do commita. Review i poprawka dokumentacji nie
zastępują kontroli typów ani managed FEM runtime.
