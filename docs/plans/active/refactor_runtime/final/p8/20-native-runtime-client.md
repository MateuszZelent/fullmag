# P7-C / P8 — klient zgodności natywnej usługi

Data: 03.10.2026. Kontynuacja [discovery](19-native-runtime-discovery.md).

CLI zawiera klienta `fullmag runtime service-status --store <absolute-root>
--target <target-id> [--timeout-seconds 3]`. Polecenie jest odczytowe: nie
otwiera SessionStore do zapisu, nie uruchamia usługi i nie wykonuje takeover.
Wynik JSON `runtime_service_discovery.v1` ze statusem ready jest emitowany
wyłącznie po odpowiedzi żywej usługi zgodnej z buildem klienta.

Klient odrzuca niezgodny target, pełny commit/snapshot, owner/process-start
token, PID/host, adres sterowania, identyfikatory i generacje obu pul.
Wymaga ready i sprawdza wspólny walidator descriptora, obejmujący role oraz
status dzieci. Losowe nonce jest porównywane z odpowiedzią. Nieznana wersja,
brak odpowiedzi, uszkodzony plik lub mismatch kończy polecenie błędem.
Brak odpowiedzi pozostaje nieznaną obserwacją, bez automatycznego restartu.

Ścieżka jest absolutna, istniejąca, bez parent traversal; kontrola linków
korzysta z repository_path. Descriptor i odpowiedź mają limit 256 KiB.
Adres jest numerycznym IPv4 loopback, bez DNS. Connect/write/read używają
wspólnego deadline, przeliczanego po każdej częściowej operacji; timeout
operatora jest ograniczony do 1–30 sekund. Żądanie używa prywatnego kanału
usługi, nie nowej przeglądarkowej rodziny endpointów.

## Dowody i pozostała praca

- Parser Rust i scoped diff check PASS; klient ma zapisane regresje mismatch
  nonce, owner, process-start token, builda, generacji i stanu oraz deadline.
- Unit tests nie kompilowano ani nie uruchomiono zgodnie z zakazem operatora.
- Typecheck, rzeczywisty TCP z binariami Fullmaga i Windows: NOT VERIFIED.
- Niezależny review źródeł: brak P0/P1; wynik zawiera prywatny token ownera
  zgodnie z lokalnym kanałem sterowania i nie powinien trafiać do raportów
  publicznych. Odpowiedź nie jest atomowym pomiarem stanu dzieci.
- Automatyczny start/attach launchera, API/UI detach oraz kontrolowane recovery
  pozostają otwarte. Komenda nie zmienia domyślnego `fullmag ui`.
- Zachowano instancję 3104, aktywne zadania i cudze zmiany źródeł.

To etap źródłowy; nie oznacza kwalifikacji Windows ani wykonania obliczeń
przy zamkniętym UI. Procent całego planu nie został zwiększony.
