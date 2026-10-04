# Kontrola HTTP surowego wyniku anteny external-lead

## Zakres i stan

Checker `scripts/smoke_antenna_external_lead_inspection.py` wykonuje wyłącznie
GET do lokalnego API. Nie tworzy sesji, nie uruchamia solvera, nie zmienia
modelu ani plików wynikowych. Jego sukces oznacza tylko zgodność odczytu HTTP
z opublikowanymi descriptorami; **nie oznacza kwalifikacji fizycznej anteny**,
aktualności wyniku względem zmienionej sceny ani zgodności natywnego buildu
z obecnymi źródłami.

Na 2026-10-04 sprawdzono 14 lekkich regresji Python, w tym rzeczywisty
transport do małego serwera loopback. Dane harnessu nie są poprawnym
numerycznym bundle i nie zastępują native readera. Uruchomienie checkera
przeciw nowemu API Fullmaga pozostaje **NOT VERIFIED**.

Kontrakty nadrzędne: [API v2](../specs/resource-first-control-room-api-v2.md)
i [nota 0950](../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-external-lead-inspection-api).

## Warunki uruchomienia

Potrzebne są: binarium z nowymi endpointami, aktywna sesja z zakończonym
etapem inspekcji, zarejestrowany rekord etapu oraz komplet pięciu payloadów
pod jej artifact root. Rekord musi mieć `inspection_only`,
`external_electrode_truncation` i `NOT VERIFIED`. Etap failed/cancelled nie
jest poprawnym wejściem pozytywnego smoke testu. Session/run/revision muszą
pozostać niezmienne przez cały odczyt.

Uruchom wybranym interpreterem Python 3 skrypt z argumentami
`--origin <rzeczywisty-origin-API>` i `--stage-id <dokładny-runtime-stage-id>`.
Origin to sam adres HTTP loopback, np. `http://127.0.0.1:8080`, jeżeli API
rzeczywiście używa tego portu. Runtime ID, np. `stage-000`, pochodzi z rekordu
wykonania; nie jest authored ID anteny. Nie zgaduj adresu, portu ani ID.
Skrypt korzysta wyłącznie ze standardowej biblioteki Pythona. Pomoc CLI
(`scripts/smoke_antenna_external_lead_inspection.py --help`) została sprawdzona.

Origin nie może zawierać credentials, ścieżki, query ani fragmentu. Checker
nie korzysta z proxy środowiska i nie podąża za przekierowaniami. Odczyt
JSON jest ograniczony do 1 MiB, pojedynczego binarnego payloadu do 128 MiB,
a liczba punktów do 1 000 000 zgodnie z readerem. Timeout 30 s dotyczy operacji
socketu, nie całkowitego czasu przebiegu. To kontrola lokalnego, zaufanego API,
nie narzędzie do badania niezaufanych serwerów.

## Sprawdzane bramki

- JSON: runtime/authored identity, raw inspection reference, exact namespace,
  jednostki, descriptor count/size/SHA oraz `validation_scope=manifest_only`;
  brak promocji do asset/basis i pojedynczy silny ETag.
- Wszystkie pięć payloadów: HTTP 200, dokładna liczba bajtów i SHA-256,
  typ binarny, zachowanie jednostek; liczby `float64_le` muszą być skończone.
- Dla każdego payloadu: HTTP 304 z pustym body i niezmienionym ETagiem,
  HTTP 206 z dokładnym fragmentem bajtów i `Content-Range`, HTTP 416 dla
  zakresu poza końcem; wymagane nagłówki data plane i `no-cache`.
- Brak digestu oraz samodzielny RT0: HTTP 400; inny digest: HTTP 409 z
  `inspection_digest_mismatch`, również przy `If-None-Match: *`.
- Końcowy conditional odczyt metadanych musi dać 304. Zmiana rewizji unieważnia
  cały przebieg; checker nie skleja dowodu z kilku sesji lub rewizji.

Checker robi 25 żądań. Każdy binary GET może uruchomić pełny verifier
wszystkich payloadów; to jednorazowa bramka na małym kontrolowanym artefakcie,
nie benchmark ani wzorzec pobierania danych przez UI. Nie sprawdza samodzielnie
wnętrza ordered bundle, nie przelicza H i nie certyfikuje globalnego błędu
kwadratury. Ufa wynikowi kanonicznego verifiera po stronie badanego API;
jego działanie wymaga odrębnej weryfikacji native.

## Wynik i dalszy dowód

Stdout zawiera jeden obiekt JSON: `fullmag.antenna_external_lead_http_smoke.v1`.
Kod 0 oznacza przejście wyłącznie tego smoke testu, kod 1 jego niepowodzenie.
W obu przypadkach pozostają `qualification="NOT VERIFIED"`,
`physics_qualified=false` i `scope="http_inspection_integrity_only"`.
Sukces zachowuje session/epoch/run/runtime stage/revision, record digest,
inspection reference oraz SHA/size/unit/ETag każdego payloadu.

Zachowaj stdout obok dowodu buildu i uruchomienia w katalogu run wskazanym
przez resolver storage; sam checker niczego nie zapisuje. Dopiero pełny
receipt buildu, rzeczywisty native artefakt i pozytywny odczyt badanego API
mogą zamknąć transportową bramkę T14. Nadal osobno wymagane są test zmiany
ownera podczas I/O, testy path/symlink na Windows, klient OpenAPI, UI oraz
kwalifikacja fizyki i LLG.
