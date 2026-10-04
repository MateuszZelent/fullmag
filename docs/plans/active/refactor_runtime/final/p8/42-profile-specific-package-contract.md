# P8-42 — wymagania pakietu niezależne od rejestru profili

Data: 03.10.2026. Baza: `19f6b9f059e92b3e685e429e966d6ad2b0413c99`.
Zmiana źródeł koordynatora/entrypointu. Pełny kontrakt następnie wdrożono
w [P8-43](43-package-contract-runner-overlay.md); P8-41 obejmował tylko sondy nightly.

## Przyczyna i poprawka

Źródłowy koordynator używał `PROFILES` entrypointu jako listy profili
wydania. W głównym checkoutcie rejestr ma trzy release profiles, natomiast
wdrożony obraz ma osiem profili. Skopiowanie tego warunku do rozszerzonego
obrazu wymusiłoby pakiet release także na profilach specjalistycznych.
EntryPoint również stosował bezwarunkowo pełny zestaw plików.

Nowy `required_outputs_for_profile` jest wspólnym selektorem obu granic:
`fdm-cpu-release`, `fem-cpu-release`, `fem-gpu-release` wymagają pięciu
bazowych plików i dziesięciu binariów accepted runtime. Pozostałe legalne
profile zachowują pięć bazowych plików. Legalność profilu nadal sprawdzają
istniejące admission/configuration/profile lookup; selector jej nie nadaje.

Aktualny release zestaw ma **15** plików. Starsze dokumenty P6-68–70
opisywały 14 przed dodaniem `fullmag-runtime-service`; aktualnego zestawu
nie wolno zredukować do historycznej liczby. Regresja każdego brakującego
binarium obejmuje teraz dziewięć `fullmag-api-*` oraz runtime service,
łącznie 30 przypadków dla trzech release profiles.

## Dowody

| Kontrola | Wynik |
|---|---|
| Dwie nowe regresje przed poprawką | RED: entrypoint wymagał accepted worker dla specialized profile, koordynator błędnie promował go do release po rozszerzeniu PROFILES. |
| Dwa moduły interpretowanych testów Python po poprawce | 41 testów PASS, exit 0. |
| Brak każdego accepted binarium | PASS, 10 × 3 przypadki w powyższym zestawie. |
| Diff check własnych czterech plików | PASS. |
| Niezależny source review | PASS, brak P0/P1; legality/admission oraz provenance zachowane. |
| Native/Rust/TypeScript unit compilation | NOT RUN; testy Python używają fixture/mocków, nie wykonują builda solvera. |
| Wdrożenie pełnego kontraktu | DEPLOYED w P8-43; minimalny overlay zachowuje profile rozszerzonego obrazu. |
| Build 218 / runtime / nauka | QUEUED / NOT VERIFIED / NOT VERIFIED; stan storage nie został zmieniony. |

## Wdrożenie i dalsza bramka

P8-43 wdrożył minimalny overlay na rzeczywistym obrazie P8-41, zachowując
osiem definicji profili i specjalistyczne funkcje koordynatora. Kluczowe
interpretowane regresje obrazu przeszły; rzeczywiste hashe i tożsamość
potwierdzono. Wymianę poprzedziła własna kontrolowana pauza zdrowej kolejki
bez aktywnych jobs; po wymianie tę pauzę wznowiono.

Po wdrożeniu nadal potrzebny jest rzeczywisty receipt i komplet artefaktów
218 na przypiętym źródle. Przejście kontroli fixture ani wymiana obrazu
nie kwalifikują pakietu, API/UI ani niezależnego produktu Windows.
