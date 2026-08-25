# Zakres i polityka dowodowa audytu LLG

Audyt z 2026-08-21 obejmuje cztery niezależne ścieżki wykonawcze:

- FDM CPU,
- FDM GPU,
- FEM CPU,
- FEM GPU.

Raporty rozdzielają:

1. defekty i hotspoty wskazane bezpośrednio przez kod;
2. ryzyka wynikające z braku jednoznacznego właściciela kontraktu lub testu;
3. hipotezy wydajnościowe wymagające profilu na reprezentatywnym sprzęcie;
4. kryteria akceptacji, które powinny wejść do CI i qualification receipts.

Brak trafienia w statycznym przeszukaniu nie jest dowodem braku implementacji. Z kolei obecność kodu GPU nie jest dowodem, że pełny krok LLG jest wykonywany rezydentnie na urządzeniu. Dla deklaracji produkcyjnej wymagany jest zapis requested/executed backend, precision, operator receipts, liczba transferów i synchronizacji oraz wyniki fizycznych oracles.
