# Odtwarzanie zapisanych wyników — weryfikacja 2026-10-27

Status: lokalne testy i końcowa kwalifikacja YIG po integracji mastera zakończone. Wynik integracji CI jest publikowany w PR #297: https://github.com/MateuszZelent/fullmag/pull/297.

## Zachowanie i zakres

W Home dodaj folder dostępny backendowi, wybierz wynik i Open results viewer
(albo podwójne kliknięcie / Enter). Inspector wybiera etap, klatkę/czas,
składową m i skalę koloru. Istniejący viewport 3D pokazuje zapisane komórki
regularnej siatki. Otwieranie nie tworzy sesji i nie uruchamia solvera.
Niezapisane formularze/edycja obiektu blokują przejście.

Obsługiwane są playback.json i nieskompresowany Zarr v2 float64 LE,
chunks [1,3*N], AoS xyz. Deskryptor zawiera geometrię i jawną oś czasu.
Automatyczne generowanie deskryptora przez każdy writer oraz FEM pozostają
poza tym zakresem. Starszy folder bez deskryptora otrzymuje błąd formatu.

## Potwierdzone sprawdzenia

- Zarządzany build aplikacji backendowej: OK. Runtime zbudowano ze snapshotu
  a1155fa90bfac7e193c5a85a7c56829de27168c0938ee1511615f2765d685a8c
  na bazie 9a6cda090fd0608d31b96f2130b59107dbddd611, po integracji mastera.
  Próba development 96597c79dc1a4f8e9120f56866a8e001, konfiguracja
  ed0408d6f8af28f45ce517a08df71fdbb7689dc09f5d3dd074b51b9948f8f0ca.
- Reader Rust: 56/56 testów, w backendzie własnej grupy.
- Test HTTP saved_playback_routes_return_metadata_and_revision_checked_binary_frames:
  1/1, w backendzie własnej grupy.
- Python: 68/68 regresje poświadczenia WSL, czytników dowodów, codegen i browser QA.
- Typecheck: OK po integracji mastera i poprawce stylów dokumentacji.
- Pełny lint: OK; dodatkowy lint zmienionych stylów i komponentu dokumentacji: OK.
- Pełny frontend po integracji: 8899 testów OK, 1 istniejący skip; 865 plików
  OK, 1 skip. Testy cross-app uruchomiono z
  FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source.
- Architecture hygiene: OK. Przyjęty z mastera fallback CSS dokumentacji
  przeniesiono bez zmiany bajtów do centralnej warstwy stylów. Dodatkowo
  przeszło 11 testów modelu dokumentacji.
- Git diff --check i składnia YAML workflow: OK.

## Rzeczywisty podgląd YIG

Zarządzana kwalifikacja browser-qa/attempts/d5794403021b423e8f11e93718946fd6
zakończyła się succeeded. Źródło scenariusza:
88313211c68f37f482c4e89b348051f2296fb257daf132815593329ecac364bb.
Playwright 1.62.1, SwiftShader WebGL (dowód UI, bez deklaracji sprzętowego GPU).

Workspace item 1: 801 klatek, −4…+4 ns, 1000×20×1 komórek. Manifest:
8a711e55f6501ea8f3786afdf8285fbfaecedfff716bae5c6525f943b4be0c31.
Klatki 0/400/800 miały po 480000 bajtów, zgodne z odzyskanym oryginałem:

- 0: f1567257f629136d0dd8f8b48bde6bb39130965a54233aa22a3718a5f08af595
- 400: 27085242e0e9c9a027d1cc1e0c0c9eca4e8dede4ade844acd29e60590f0a3571
- 800: 92c875c19de85daa2439d27a9ce99ccc2208f1bd8ea61734570c6162446002d4

Potwierdzono: zmieniony obraz canvasu, niezmieniona geometria i kamera,
stabilny Inspector, widoczny canvas, context_lost=false, drawing buffer
649×683, brak błędów hooków, brak mutacji sesji i brak nowej sesji.
Zrzut oraz JSON dowodowy wyeksportowano jako YIG-playback-20261027.png/json
do dokumentów użytkownika; końcowe kopie mają sufiks -final. Obraz sprawdzono wizualnie: m_z przedstawia
propagujące paczki na końcowej klatce +4 ns.

Negatywne HTTP: klatka 801 i obcy etap → 404, nieaktualna rewizja → 409.

## Naprawa wznowienia po restarcie WSL

Zaimplementowano reattest-host-device-volume: jawne piny starego certyfikatu,
aktualnego urządzenia, próby development, konfiguracji i źródeł; kontrola
sentinela, inode, silnika, obrazu i zatrzymanych konsumentów. Stare/nowe bajty
są journalowane, częściowy zapis można ponowić wyłącznie dla tych wersji.
Inode bind-mountowanego certyfikatu i token właściciela pozostają zachowane.

Dla tej grupy urządzenie zmieniło się 2128→2096. Operacja
bf65c1df934941e8afddfe45dcf21f6c zakończyła się succeeded. Kontrolowany helper
zamknął osieroconą iterację dc4e49ccc55a40ce96e94a580f5969f1 pod flock
i dokładnym CAS, bez zmiany oryginalnego receipt.json; potwierdzono brak
helpera i brak zachowanych runów. Zwykłe resume
82b6809c6aa1486fa10a52c3e0dfb765 przywróciło API i frontend.

## Niezależny przegląd

Przegląd ścieżki WSL/CAS, walidacji shared pnpm, wrappera i cyklu życia
renderera wykonano niezależnie. Zamknięto dwa findings: jawny pin obrazu
każdej usługi oraz dokładna zgodność etykiet shared pnpm. Regresje obejmują
obcy obraz frontendu przed zapisem i dodatkową obcą etykietę wolumenu.
Ponowny bounded review nie stwierdził pozostałych actionable problemów.
Zestaw 68 regresji helperów pozostał zielony.

## Utrzymanie cache

Przypięta procedura cache-maintenance/attempts/0c242ff7ed4c4431bb7ef22f65d2e523
zakończyła się succeeded dla próby development i konfiguracji powyżej.
Dopasowano ścisły wrapper just do istniejącej recepty maintain-cache: dokładne
piny, bez eval, bez dodatkowych flag retencji i komend złożonych. Regresja
weryfikuje zarówno poprawny dispatch, jak i odrzucenie takich rozszerzeń.

## Integracja i ograniczenia dowodów

Użytkownik jawnie zezwolił na testy tej funkcji i wymagane CI.
Wcześniejsza odmowa kompilacji testów nie blokuje już tego zadania.
CI obejmuje teraz czytnik, test trasy HTTP i regresje helperów WSL/QA.
Finalne CI, merge i kwalifikowany cleanup są rejestrowane w PR #297 oraz
operacyjnym checkpointcie zadania. Nie są wnioskowane z testów lokalnych.

Narzędzie QA rozpoznaje nowy wspólny cache pnpm wyłącznie po tożsamości
projektu cache wyznaczanej przez renderer Compose, nazwie i etykietach
wolumenu, lokalnym driverze bez opcji, dokładnym subpath store i NoCopy.
Wolumen pnpm nie jest dodatkowo montowany do samego browser helpera.

Stary hostowy hook React Doctor miał błąd parsera oxlint
(Unexpected discriminant 160); nie jest raportowany jako zaliczona bramka.

Oryginalny zapis YIG zachowuje status nieudanej publikacji ENOSPC.
Odtwarzanie nie przepisuje go na sukces. Rewizja API obejmuje deskryptor
i metadane, bez checksum wszystkich chunków; integralność odzyskanego
oryginału ma odrębny dowód SHA256.
