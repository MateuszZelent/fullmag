# P7-C / P8 — żywe discovery natywnego runtime

Data: 03.10.2026. Kontynuacja etapu [18](18-native-runtime-service.md).

Zaimplementowano odczytowe polecenie status na prywatnym loopback istniejącej
usługi. Token ownera i wersja są obowiązkowe; klient dostarcza świeże nonce,
które usługa zwraca wraz z descriptorem z własnej pamięci. Status nie uruchamia
ani nie zatrzymuje procesu. Drain zachowuje dotychczasowy kontrakt.

Odpowiedź umożliwia klientowi sprawdzenie tożsamości instancji i builda;
nie wystarcza sam plik OWNER.json ani wiek/PID. Polityka klienta i integracja
z launcherem/UI pozostają do wykonania. Brak odpowiedzi podczas startup/drain
jest nieznanym wynikiem obserwacji, nie dowodem zakończenia.

## Weryfikacja

- Parser/format Rust i scoped diff check PASS.
- Zapisano regresje parsera dla owner mismatch, braku/pustego/niepoprawnego
  lub zbyt długiego nonce oraz zachowania drain.
- Unit tests nie kompilowano i nie uruchomiono zgodnie z zakazem operatora.
- Proces Windows, typecheck i live discovery: NOT VERIFIED.
- Niezależny review źródeł: brak P0/P1. Nonce zapewnia korelację odpowiedzi;
  nie jest samodzielnym dowodem kryptograficznym ani atomowym pomiarem dzieci.
- Etap 18 zapisany i wysłany na master:
  f2cc4227fb1cec0a392da69c9cd1d90df5142cce.

Następny krok: klient zgodności/discovery i bezpieczny start/attach launchera.
Nie zmieniono sesji na 3104 ani procentu ukończenia całego planu.
