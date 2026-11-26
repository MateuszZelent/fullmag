# Dane wejściowe przed odtworzeniem odpowiedzi magnetycznej

Audyt źródeł i wejść; bez zmiany fizyki i bez uruchomienia LLG. Źródło: [M. Sushruth i in., Electrical spectroscopy of forward volume spin waves in perpendicularly magnetized materials, PR Research 2, 043203 (2020)](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.2.043203), Table I, rozdział IV i podpis Fig. 6. Ponowna weryfikacja 01.11.2026.

| Wielkość | Model Table I | Próbka / dopasowanie Fig. 6 |
| --- | --- | --- |
| Pole efektywne | 0,25 T | Nie utożsamiać z polem przyłożonym |
| Współczynnik częstotliwości | 30 GHz/T | Konwencja Appendix A wymaga rozróżnienia gamma dla B i H |
| Magnetyzacja | mu0 Ms = 0,89 T | Nie przenosić automatycznie wartości modelowej do materiału próbki |
| Grubość magnetyczna | 20 nm | 17,4 nm wyliczone z opisanego stosu Ni/Co |
| Tłumienie | 0,01–0,1 | Pomiar warstwy 0,013 ± 0,002; dopasowanie urządzenia 0,03 |
| Efektywne pole anizotropii | Nie utożsamiać z całkowitym polem efektywnym | 3 mT dla wybranej warstwy, rozdział IV A |
| Szerokość próbki | Model translacyjnie niezmienny w kierunku poprzecznym | 20 µm, rozdział IV A |
| Szerokość / szczelina | Osobne geometrie S/GS/GSG | Nominalnie 200/250 nm; fit 180/200 nm |
| Odstęp pionowy | Osobny parametr widma | Fit 80 nm, definicja od środka warstwy do środka anteny |
| Odległość anten | Osobny parametr | Nominalnie 2 um; fit 1,8 um |

## Konsekwencje dla obecnego kodu

- docs/physics/0951-sushruth-2020-forward-volume-reference.md :: governing-equations i python-api już rozdzielają wzorzec analityczny od solvera. Nie tworzyć drugiego wzorca.
- scripts/reference_sushruth_2020_response.py :: inductive_response pozostaje referencją modelu; jego wynik nie potwierdza wykonania LLG.
- examples/fem_antenna_sushruth_2020_closed_gsg.py deklaruje geometrię i sampling; nie deklaruje magnetycznej próbki. H247 przy próbce i pełny Universe mikrostripu nie zastępują magnetyzacji.
- Przed realistycznym LLG jawnie rozwiązać brak przypisania Ms, Aex, Ku, gamma, pola zewnętrznego, długości próbki i warunków brzegowych. Nie dobierać wartości tak, aby krzywa wyglądała podobnie.
- Osobny przypadek odtwarzający przybliżenie analityczne musi jawnie zachować jego pominięcie wymiany i liniową odpowiedź. Nie przedstawiać go jako kompletnego modelu próbki eksperymentalnej.
- Nadal wymagane: zakwalifikowane pole anteny, projekcja na siatkę magnetyczną, równowaga, rzeczywisty Run, monitory i m(k,omega). Brak tych danych nie upoważnia do nazwania FFT pola wzbudzonym modem.

Ten rejestr nie zastępuje noty fizycznej ani zgody na niejednoznaczne założenia. Nie zmieniono parametrów istniejącego źródła ani referencji.

## Sprawdzenie mapowania gamma

Publiczny model packages/fullmag-py/src/fullmag/model/dynamics.py :: LLG.to_ir zapisuje gamma jako gyromagnetic_ratio. Dotychczasowy DEFAULT_GAMMA wynosi 2.211e5. W world.py :: _gamma_from_g_factor widoczny jest czynnik mu0, czyli kontrakt współczynnika dla H w A/m. Przy 30e9 Hz/T z modelu referencyjnego jawna wartość LLG.gamma wynosi 236870.50562614459 m/(A s), z konwersji mu0*2*pi*30e9. Sprawdzono algebraicznie f=7.5e9 Hz dla mu0 H_eff=0.25 T. Nie uruchomiono LLG, nie zmieniono domyślnej stałej ani parametrów materiału. W przyszłym przykładzie jawnie ustawić właściwą gamma; nie wkładać 30e9 bezpośrednio do tego pola. Weryfikacja runtime pozostaje wymagana.

## Weryfikacja źródeł i rozdzielenie domen — 01.11.2026

Źródłem wartości opublikowanych pozostaje [PDF APS](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203), rozdział IV A–B, Fig. 5–6 i Appendix A/C. [arXiv:2001.11483v1](https://arxiv.org/abs/2001.11483v1) jest wcześniejszym preprintem, nie zamiennikiem wersji wydawniczej. Oficjalne [archiwum TeX v1](https://arxiv.org/src/2001.11483v1) sprawdzono osobno: `main.tex`, `main.bbl` i siedem plików PNG. Nie zawiera osobnego skryptu symulacji ani tabeli surowych danych. Nie wykonywano zawartości archiwum.

- Stos magnetyczny ma 17,4 nm: 21 powtórzeń Ni(0,6)/Co(0,2) oraz końcowe Ni(0,6). Warstwy Cu/Ta ponad nim nie powiększają domeny LLG.
- Rysunek 5 preprintu pokazuje pętlę jako M/Ms; nie dostarcza osi bezwzględnego Ms. Rysunek 6 preprintu nie podaje osobnej wartości pola przyłożonego. Nie wpisano wartości odczytanych wizualnie do konfiguracji solvera.
- `examples/fem_antenna_sushruth_2020_closed_gsg.py` :: `source_length_m` wykorzystuje 20 µm jako długość skończonego źródła w kierunku przewodników. To jawne założenie obwodu, a nie odtworzenie długości padów.
- Ten sam przykład :: `sampling_length_m`, `sampling_width_m`, `sampling_depth_m` definiuje niemagnetyczne okno pola 4 µm × 100 nm × 17,4 nm. Okno obejmuje 1/200 opublikowanej szerokości próbki; nie jest jej siatką LLG. `study.geometry_object` nie deklaruje materiału magnetycznego.
- Z pozycji warstw w przykładzie wynika odstęp środków 88,7 nm: środek metalu 75 nm minus środek Ni/Co −13,7 nm. Nie jest to dokładnie parametr dopasowania 80 nm. Nominalnego obwodu i dopasowania nie wolno łączyć bez jawnego rozróżnienia.

## Następny krok modelu magnetycznego

| Wejście | Stan po weryfikacji | Wymaganie przed Run |
| --- | --- | --- |
| Grubość / szerokość | 17,4 nm / 20 µm ustalone | Osobny magnetyczny obiekt i siatka, nie zmiana roli okna pola |
| Ms i Ku | Brak zweryfikowanego przypisania do próbki | Ustalić wspólnie z anizotropią; 3 mT nie jest samodzielną wartością Ku |
| Aex | Model analityczny pomija wymianę | Jawny model bez wymiany albo źródło wartości i zakresu jej ważności |
| Gamma i pole przyłożone | Konwersja Table I znana; przypisanie do Fig. 6 nieustalone | Nie mylić gamma dla H/B ani pola przyłożonego z efektywnym |
| Długość / brzegi | Nieustalone dla skończonej symulacji | Jawna domena i kwalifikacja wpływu brzegów |
| Pole anteny | Wynik inspekcyjny istnieje | Zakwalifikowane źródło, projekcja i warunki ważności przed LLG |

Bez tych wejść nie uruchomiono nowego Solve, Relax ani Run. Audyt nie zastępuje kompletnej noty 0950/0951, jej map źródeł, bramek runtime ani decyzji o niejednoznacznych założeniach fizycznych.

Dowód pobrania i manifest archiwum: prywatny wolumen control naszej grupy, `verification/sushruth-primary-inputs-20261101/download.json` i `archive-manifest.json`. Archiwum: 8 016 677 bajtów, SHA256 `3f4a0b06f64182ad842437dc00738afad144c07a0840a0adebcaf8b9cb084b89`. To dowód identyfikacji źródła, nie kwalifikacji symulacji.

Kontrola `verification/sushruth-primary-inputs-20261101/input-audit-verification.json` przeszła przez publiczny `load_problem_from_script` i `export_builder_draft` w istniejącym kontenerze backendu. Potwierdziła granice i środki obu obiektów, brak magnetyków, jeden etap field-only oraz dokładny zestaw dziewięciu plików archiwum. Bez przygotowania siatki i bez kompilacji. Przykład GSG jest nadal lokalnym WIP; ten checkpoint dokumentacji nie publikuje jego implementacji.
