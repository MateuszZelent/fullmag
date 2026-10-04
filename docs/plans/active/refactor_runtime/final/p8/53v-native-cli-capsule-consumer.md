# P8-53V — konsument kapsuły w natywnym launcherze

## Zachowanie

Natywny CLI przekazuje zweryfikowaną ramkę przejęcia API do zarządzanego
Pythona przez zamknięty stdin. Zachowuje oryginalne bajty JSON, identyfikację
generacji i źródeł ownera. Token ownera pozostaje w CLI i nie trafia do helpera.
Interpreter musi wskazywać dokładną ścieżkę środowiska natywnego profilu dev;
brak interpretera nie powoduje fallbacku do PATH.

Helper zapisuje kapsułę i wykonuje readback przez istniejącą warstwę staging.
CLI czeka na zakończenie własnego procesu, wymaga exit 0, ogranicza rozmiary
wejścia i odpowiedzi oraz sprawdza binding i ACK. Dopiero wtedy potwierdza
aktualne przejęcie przez ten sam prywatny kanał API. Błąd zamyka przejęcie;
nie uruchamia replacement ani nie oznacza kapsuły jako odtworzonej.

Proces helpera ma limit 20 sekund. Przekazywanie wejścia i odczyt odpowiedzi
działają równolegle, aby pełna rura nie blokowała kontroli terminu. Limit
przejęcia API pozostaje bezwzględny i nie jest przedłużany przez staging.

## Weryfikacja

Końcowy natywny build dev: exit 0. Review wykrył porównanie zwykłej ścieżki
Windows z wariantem `\\?\`; poprawiono kontrolę całego łańcucha bez symlinków
i reparse points oraz kanonikalizację obu ścieżek przed porównaniem.
Ponowny build i sonda korzystają z poprawionego kodu; review delta bez uwag.

Lekka kontrola: **101/101**, zero skip, exit 0. Receipt
`development-handoff-checks/checks/d8526f23a9d641468d2d14ea23ef1a59/receipt.json`.
Pierwsze discovery liczyło ponownie siedem przypadków przez import klasy testów;
zmieniono import na moduł. Receipt wcześniejszej próby zachowano.
Nie kompilowano testów jednostkowych.

Produkcyjna sonda: **100 sprawdzeń**, exit 0. Receipt
`development-backend-api-checks/checks/db152b3a668a429bb3c7e1380ecba33b/receipt.json`.
Oba helpery Python mają potwierdzony exit 0 i wait. CLI zapisuje kapsułę pustego
workspace i kanonicznej sesji; po staging nadal potwierdza ten sam guard API.
Verifier niezależnie odczytuje oba staged receipt i zachowany marker edytora
po zakończeniu CLI. Dane fixture nie są dowodem transportu prawdziwych szkiców UI.
Wszystkie **20** procesów sondy mają potwierdzony wait. Fixture kończy własne API
przez istniejące wymuszone zatrzymanie; jego exit 1 nie dowodzi graceful shutdown.
Digest backendu przed/po:
`57c61c3c023aa30de77db96479840879f6159cd8f4bc9fdf9f7f8b4e3c41b865`.
Snapshot buildu:
`0d727798b96d5b743bbb9dcb2d24d58655e327c4f32944634314fbcddda13fe5`.
Po sondzie bieżący UI 3197 odpowiada HTTP 200; nie był restartowany.

Sonda używa własnego API, odrębnego katalogu stanu i generacji obserwatora.
Kapsuły i kandydat korzystają z kanonicznego resolvera storage oraz własnych UUID.
Nie zastępuje aktywnego pakietu ani procesów użytkownika na porcie 3197.

## Pozostały zakres P8-53

Do wykonania pozostają transport rzeczywistych szkiców UI, atomowy commit
z globalnym idle/fence, kontrolowany shutdown i wait API, replacement,
nowa tożsamość API oraz hydration z potwierdzeniem frontendu. Ten etap
nie dowodzi gotowego przycisku restartu, odtworzenia symulacji ani kwalifikacji
Windows release/FEM/GPU. Procenty całego planu pozostają bez awansu.
