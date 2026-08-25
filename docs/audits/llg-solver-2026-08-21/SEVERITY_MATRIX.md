# Macierz priorytetów

| Priorytet | Znaczenie | Przykłady |
|---|---|---|
| P0 | możliwa błędna fizyka, silent fallback lub zasadnicze zablokowanie GPU | `mu0/gamma` mismatch, host readback per stage, airbox DOF w LLG |
| P1 | duży błąd numeryczny lub dominujący koszt | mesh-dependent error norm, assembly per stage, alokacje w hot path, stiff explicit RK |
| P2 | utrzymanie, diagnostyka lub optymalizacja drugiego rzędu | brak telemetryki, niepełne komunikaty, niewystarczające profile |

Każde zachowane ustalenie ma w raporcie ścieżki rejestr dowodów zawierający:

- bieżący stan (`potwierdzone`, `częściowo potwierdzone` albo `luka dowodowa`);
- repozytoryjną tożsamość `ścieżka + symbol` dla implementacji i testu;
- poziom pewności oraz rozdzielenie obserwacji od hipotezy wydajnościowej;
- reproducer lub dokładny pomiar potrzebny do rozstrzygnięcia;
- test akceptacyjny i właściciela remediacji.

Brak profilu sprzętowego nie jest defektem sam w sobie. Ustalenie bez wskazanego symbolu i reproduktora nie może być klasyfikowane jako zaobserwowany błąd.
