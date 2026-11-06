# Fig.3: rozróżnienie indukcyjności i SEM — 06.11.2026

**Sama zmiana obserwabli nie wyjaśnia rozbieżności Fig.3.**
To nowy, ograniczony test hipotezy generatora grafiki, nie poprawka
modelu, potwierdzenie błędu pracy lub reprodukcja publikacji.

## Cel i źródła

Niezależny odczyt Eq.1–3/6–10 nie znalazł błędu Jacobianu, dodatkowego2pi,
szerokości/gap lub center-to-center r. W GS h² różni się minusem od |h|²,
ale ten sam minus skraca się w normalizacji Eq.9. Pole efektywne w AppendixA
jest pełnym polem statycznym; nie dodajemy do niego demag drugi raz.
To źródłowa kontrola implementacji, nie nowy numeryczny dowód równoważności.

Nowy trop: §II.C wiąże T z indukcyjnością wzajemną, podczas gdy opis
cosine-like w §III.B.2 oraz czynnik i w Eq.14/AppendixB wymagają uważnego
rozróżnienia faz i obserwabli. Podpis Fig.3 nadal mówi Re(T); nie ma podstaw
do podmiany domyślnego renderera. Źródła pierwotne:
[APS](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203),
[TeX arXiv v1](https://arxiv.org/src/2001.11483v1), zachowane PDF/TAR.
Nie wykonywano kodu z archiwum i nie kontaktowano się z autorami.

Kanoniczne równanie Faradaya, znak dla exp(+i*omega*t), symbole SI,
komplet parametrów oraz prerejestracja są w
[nocie0951](../../physics/0951-sushruth-2020-forward-volume-reference.md#sushruth-faraday-observable-audit).
Jest to dimensionless proxy SEM i przeciwnego pasywnego napięcia;
nie znamy skali wzajemnej indukcyjności ani portowej kalibracji.
To nie jest skalibrowane napięcie lub S21. Nie dodano swobodnej fazy.

## Kontrola i dane

`scripts/test_sushruth_voltage_observable.py::SushruthVoltageObservableTests`
przeszedł4testy. Niezależna centralna pochodna rzeczywistego strumienia
na4096próbkach okresu i demodulacja potwierdziły przewidywanie dla6/7,5/9GHz
z prerejestrowanym progiem względnym5e−7. Sprawdzono także DC, skalowanie
jednostek, odmowy niefinitych danych i przepełnienia. Focused scientific
validator PASS; niezmienionych41regresji samego kontraktu nie powtarzano.

Wejście: zachowany sushruth-figure3-reference-dense.json, SHA256
3fa8dd8400f906870c9e794a88dbfda902c74616ab54328d73b031d9fa2751cd.
Wszystkie12przebiegów po701próbek zachowano. Analiza601próbek6–9GHz
z krokiem5MHz nie interpoluje; wybiera globalne maksima/minima oraz dwa
pierwsze dodatnie ścisłe lokalne maksima powyżej10% dodatniego maksimum.
Brak wystarczających maksimów jest null/listą krótszą, nie zerem.
Ten lokalizator nie ma medianowego wygładzania historycznego odczytu
oscylacji; nie zastępuje tamtych liczb i nie dowodzi korespondencji modów.

| Alfa0,01 | Globalne maksimum indukcyjności, GHz | SEM, GHz | Pasywne napięcie, GHz |
|---|---:|---:|---:|
|S|7,800|7,700|7,900|
|GS|8,175|8,085|8,265|
|GSG|8,175|8,440|8,265|

Żaden wariant GSG nie uzgadnia odczytanego maksimum7,59759GHz.
Wszystkie zachowują FMR7,5GHz z TableI, podczas gdy kreska panelu(e)
obejmuje7,13494–7,16386GHz. Zakres kreski nie jest pełnym boundem
niepewności digitizacji. Sama faza/obserwabla nie rozwiązuje problemu.
Nie dopasowano częstotliwości, amplitudy, gamma, pola, grubości lub r.

## Dowody i zakres wykonania

Prywatny control volume grupy3203:
`verification/sushruth-faraday-observable-20261106/source-checks.json`
z logiem4testów, walidatora i hashami źródeł przed przetworzeniem;
`retained-data.json`, SHA256
7fce12db325881ba888f65b08b439677c1e7d9aa0527234bbcb9be4c8bde9e25,
z pełnymi ekstremami12przebiegów, flagami braku fitu/nowego Solve/kwadratury.
Proces pomocniczy działał w istniejącym backendzie, na osobnym CPU
z limitem2GiB. Nie jest to managed runtime proof ani solver FDM/FEM.

Nie zmieniono fizyki, publicznego DSL, ProblemIR, planera lub API.
Nie wykonano transportu, H lub LLG i nie zmieniono sześciu narzędzi aktywnej
referencji. Historyczna eta pozostaje FAIL; nie odblokowujemy bazy lub
sprzężenia magnetycznego. Kolejnym krokiem wykonania pozostaje odbiór
9referencji i prepare-only nowych siatek połączeń. Rozstrzygnięcie Fig.3
nadal wymaga mocniejszego dowodu rzeczywistej recepty autorów.
