# Macierz priorytetów

| Priorytet | Znaczenie | Przykłady |
|---|---|---|
| P0 | możliwa błędna fizyka, silent fallback lub zasadnicze zablokowanie GPU | `mu0/gamma` mismatch, host readback per stage, airbox DOF w LLG |
| P1 | duży błąd numeryczny lub dominujący koszt | mesh-dependent error norm, assembly per stage, alokacje w hot path, stiff explicit RK |
| P2 | utrzymanie, diagnostyka lub optymalizacja drugiego rzędu | brak telemetryki, niepełne komunikaty, niewystarczające profile |

Każde ustalenie powinno mieć: lokalizację kodu, confidence, wpływ, reproducer, test akceptacyjny i właściciela remediacji.
