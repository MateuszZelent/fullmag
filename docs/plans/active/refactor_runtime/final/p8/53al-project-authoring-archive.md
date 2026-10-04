# P8-53AL — aktualizacja sceny w archiwum projektu

Data: 04.10.2026. Status: implementacja i weryfikacja w toku.

## Kontrakt

`POST /v2/persistence/projects/authoring` aktualizuje dostarczone bajty projektu
bez instalowania go w bieżącej sesji i bez uruchamiania solvera. Wejście zawiera
archiwum, etykietę diagnostyczną, oczekiwane ID i rewizję oraz pełny `scene.v2`.
Niezgodne ID, rewizja i tryb read-only blokują operację. Nie ma wejścia hostPath.

Właścicielem archiwum pozostaje ProjectApplication/FileProjectRepository.
Walidacja korzysta z typowanego SceneDocument, ale zapis zachowuje surowy JSON
sceny dopuszczony przez aktualną walidację, dodatkowe pola definicji, opaque
documents i istniejące assets. Nie rozszerza listy pól akceptowanych przez
ścisłe schematy. Dla kompletnej sceny kanoniczny Python powstaje przez istniejący
renderer. Helper może wykonać własny bootstrap DSL w trybie lightweight;
nie wykonuje dostarczonego źródła użytkownika ani Compute. Poprzedni
różniący się Python pozostaje w `project/source-history/<sha256>.py`.
Zmiana zwiększa rewizję raz. Identyczna scena i źródło zachowują rewizję i bajty.
Limit archiwum to 64 MiB, wygenerowanego UTF-8 źródła 8 MiB.

Niekompletna scena pozostaje zapisywalna bez materiału, initial state i solvera.
Jej bieżące źródło jest nieobecne; poprzednie źródło zostaje w historii zamiast
udawać aktualny model. Nie generujemy fikcyjnych parametrów fizycznych.
Edytowalny eksport Python dla niekompletnych szkiców jest nadal otwartą bramką
P2/P8; samo zachowanie archiwum jej nie zamyka.

Nowy endpoint używa ograniczonego wariantu renderera: 30 sekund obserwacji
procesu i 1 MiB łącznego stdout/stderr. Przy naruszeniu limitu kończy dokładny
uruchomiony Child i odbiera jego zakończenie. Po uruchomieniu helpera nie ma
fallbacku do innego interpretera. Dotychczasowe wywołania helpera zachowują
swoją politykę. Prywatne pliki mają ograniczone czyszczenie; nie kasujemy
rekurencyjnie nieznanych pozostałości.

Kontroler udostępnia jawną synchronizację. Dopiero zweryfikowana odpowiedź
zastępuje lokalne archiwum. Błąd zachowuje dotychczasowy dokument; operacja
blokuje konkurencyjne save/open/close/capture. Persisted revision oraz source
hash wcześniejszego pliku nie stają się dowodem nowego zapisu na dysku.
Blokada operacji działa już podczas walidacji wejścia; klonowanie przez
deskryptory odrzuca accessors, toJSON, cykle, symbole i wartości nie-JSON.

## Granice odbioru

Nie przypisujemy automatycznie sceny bieżącej sesji do dowolnego otwartego
projektu. Powiązanie projektu z sesją, pending forms i konsument kapsuły restartu
pozostają wymaganymi następnymi bramkami. Nowe zewnętrzne assets wymagają
osobnego mechanizmu przenośnego importu. Istniejące assets muszą być zachowane.

Weryfikacja obejmuje rzeczywisty natywny API, zachowanie archiwum i źródła,
konflikty tożsamości/revision, brak zmiany przy ponowieniu oraz kontroler
w izolowanej przeglądarce. Pełny restart UI i kwalifikacja wydania pozostają
NOT VERIFIED. Nie kompilujemy testów jednostkowych.

Przeniesienie `workspace.search-docs` do modułu Start usuwa zależność kernela
od wewnętrznego store modułu. ID polecenia, F1 i zachowanie pozostają zachowane.

## Bieżące dowody

Natywny build Windows zakończył się exit 0. `just verify-windows-project-document`
przeszedł 25 kontroli: receipt `2485c7e2de16430287cc4508faa1aa97` w profilu
`development-backend-api-checks`. Fingerprint backendu przed i po próbie:
`f59c6d48295966586e9bb426e7eb31c8e1ce646e3a181c6c88f2e81037dcaa67`.
Build pochodzi z bazowego commita `dd7bb9106c2a85cd98bcc0f7f1ca9fa7f5b4f149`
z dirty snapshotem `d36272159d6faf796d63bbc3733f01aff860fe550cecab328e41289df21304e4`.

Potwierdzono zachowanie archiwum, odmowy ID/revision/read-only, zapis szkicu bez
starego źródła, historię źródła, assets/opaque/raw metadata i kompletną scenę
box/material/region. Wygenerowany Python przeszedł kontrolę składni, obecności
materiału i regionu, kanonicznego LF oraz pełnego no-op bajtów i rewizji.
Nie jest to dowód wykonania modelu, roundtrip wszystkich pól ani fizyki.

W odseparowanych fake-root helperach API zakończył dokładny proces po deadline
(30,078 s) i po przepełnieniu logu (0,281 s). Verifier zachował HANDLE przed
uzbrojeniem próby i potwierdził jego zakończenie. Trzy procesy API próby
zakończono kontrolowanie w cleanup; oba helpery zakończył sam badany API.
Wszystkie pięć procesów ma dowód zakończenia. Dane użytkownika nie były wejściem.

Pierwsze próby wykazały wymaganie materiału w rendererze oraz niezgodność
`write_text` LF→CRLF z `bytes_written` na Windows. Poprawka helpera zapisuje
bezpośrednio bajty UTF-8 i raportuje rozmiar tego samego bufora.

Import surowego OpenAPI z powyższego receipt przeszedł kontrolę tożsamości
commita/snapshotu, SHA-256 eksportu, stabilności źródeł i zakończenia procesów.
Domyślny import nadal wymaga clean; ścieżka `--native-receipt` dopuszcza dirty
wyłącznie z kompletnym dowodem. Interpreted import checks PASS:
`c5d46cc72b684b858580f0fb1074075a`; regeneracja klienta PASS:
`014fe9bce1834e87b5e5525654c28b76`. Generated diff zawiera tylko nowy endpoint
i jego request/operation.

Production TypeScript PASS: `c7fa4eee50c34ab3902c78b1a3496458`;
lint PASS: `904018458b674a4ea04b72b6705dcdea`;
API hygiene PASS: `c130c3d71e2947f4822da75e8696441a`.
React Doctor (lokalny, zakres changed) PASS:
`264ab92ee5c6418785badef8f700ee01`.
Próba kontrolera w przeglądarce PASS: `c925ec8ef6e5495bbffb53009a337976`,
15/15 grup, bez błędów strony i konsoli, serwer próby zakończony.
To izolowana fixture z rzeczywistym kontrolerem i mock API, odrębna od
natywnego dowodu backendu. Nie dowodzi pełnego restartu ani działania solvera.
Przegląd ścieżki importu oraz wcześniejszy przegląd backendu/kontrolera:
bez nierozwiązanych findings. Architecture hygiene PASS po przeniesieniu
polecenia dokumentacji do Start, commit
`30f9cac083cdd46833bc8f6bd47b41928934e3e1`.
