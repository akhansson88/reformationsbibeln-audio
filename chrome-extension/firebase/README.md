# Anmälningar av uttalsfel

Projekt: `reformationsbibeln-fel`. Firestore och anonym autentisering är redan
aktiverade enligt projektägaren. Tillägget är färdigkonfigurerat för detta projekt.
Ingen administratörsnyckel finns i tillägget.

## Publicera databasreglerna

1. Öppna Firebase Console och välj **reformationsbibeln-fel**.
2. Öppna **Firestore Database → Rules / Regler**.
3. Öppna **reformationsbibeln-firestore-ascii.rules** i en textredigerare och
   kopiera hela filens innehåll.
4. Markera allt i Firestores regelredigerare med **Ctrl+A** och ersätt hela
   innehållet med den kopierade koden. Första raden ska vara `rules_version = '2';`.
5. Klicka **Publish / Publicera**.

De tre regelfilerna innehåller exakt samma regelkod och kan klistras in direkt i
Firestore Console. Filnamnet `firestore-rules.json` behålls enligt önskemålet,
men innehållet är Firestores regelspråk. Filen har inget JSON-omslag och ska
inte läsas med en JSON-parser. Koden använder endast ASCII-tecken; Unicode i
ordkontroller och svenska boknamn skrivs med explicita escape-sekvenser.
Den nya filen med `ascii.rules` i namnet är den rekommenderade nedladdningen.
Reglerna ingår i ZIP-versionens `firebase`-mapp. De publiceras inte genom att
Chrome-tillägget installeras. Filen nekar åtkomst till övriga samlingar i projektet.

Alternativt, från källkodens `chrome-extension`-mapp, med ett administratörskonto:

```sh
npx firebase login
npx firebase deploy --only firestore:rules --project reformationsbibeln-fel --config firebase/firebase.json
```

Denna leverans ändrar inte projektets befintliga publicerade regler.

## Granska anmälningar

Öppna **Firestore Database → Data → pronunciationReports** i Firebase Console.
Samlingen skapas av den första godkända anmälan; du behöver inte skapa den manuellt.
Varje dokument är en anmälan med följande fält:

| Fält | Innehåll |
| --- | --- |
| `bookName`, `bookId`, `chapter`, `verse` | Bibelstället |
| `verseText` | Versens visade text när anmälan gjordes, utan Strongs-nummer och referenskolumner |
| `selectedWords` | Markerade ord, inklusive skiljetecken; nycklarna är ordens nollbaserade positioner |
| `description` | Beskrivning; tom sträng tillåts när minst ett ord markerats |
| `audioUrl`, `audioRevision`, `audioChecksum` | Ljudfilen och den exakta inspelningsversion som lyssnaren anmälde |
| `createdAt` | Tid satt av Firestore-servern |
| `status` | `new` för nya anmälningar |
| `reporterUid` | Teknisk identitet för anonym autentisering; inget namn eller e-post samlas in |
| `clientReportId`, `extensionVersion`, `schemaVersion`, `translation`, `source` | Identifiering och versionsuppgifter |

Exempel: `selectedWords: { "0": "Gud", "2": "Gud" }` betyder att det första
och det tredje ordet markerats. Även identiska ord i samma vers kan skiljas åt.
Om texten inte kunde läsas blir `verseText` tom; då krävs en beskrivning.

Du kan som administratör ändra `status` till exempelvis `reviewed` eller `fixed`
i Console. Tillägget visar inte andra användares anmälningar och kan inte lista,
redigera eller radera rapporter. Det får läsa ett eget exakt dokument-ID som kvitto
vid ett nytt försök efter ett osäkert nätverkssvar. Console använder dina
administratörsrättigheter, inte tilläggets klientregler.

## Kontrollera funktionen

Efter publicering av regler och installation av tillägget:

1. Öppna ett kapitel med ljud på Läs bibeln eller Studera bibeln.
2. Klicka **Anmäl uttalsfel**, markera ett ord och skicka en verklig anmälan.
3. Kontrollera att bekräftelsen visas och att dokumentet finns i `pronunciationReports`.
4. Prova en beskrivning utan ordmarkering. Ett tomt eller blankt fält ska stoppas.

Sparandet använder Firestore Lite utan kö för offlineskrivningar. Bekräftelsen
visas efter ett serversvar. Vid fel behålls formulärets uppgifter medan dialogen
är öppen. Ett oförändrat nytt försök använder samma dokument-ID för att undvika
dubbletter efter ett förlorat svar. Ett manuellt sidbyte stoppar ljudet och tar
bort rapportdialogen; oskickade formulär sparas inte mellan sidor.

Reglernas automatiska tester använder en emulator och demoprojektet
`demo-reformationsbibeln-fel`. De skriver inga testanmälningar i ditt projekt.
Från källkodens `chrome-extension`-mapp med Node 24 och Java 21:

```sh
npm ci
npm run test:rules
```

`node scripts/build-firestore-rules.cjs` återskapar alla tre regelfilerna från
tilläggets bok- och kapitelmetadata. Gör regeländringar i generatorn och bygg om.
