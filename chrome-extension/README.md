# Reformationsbibeln – ljud på Bibelonline

Chrome-tillägg för **Läs bibeln** och **Studera bibeln** på https://bibelonline.se.
Version 1.1.0. Chrome 120 eller senare på dator.

## Installera ZIP-versionen

1. Packa upp `Reformationsbibeln-Chrome-1.1.0.zip` i en mapp som du behåller på datorn.
2. Skriv `chrome://extensions` i Chromes adressfält.
3. Slå på **Utvecklarläge** längst upp till höger.
4. Klicka **Läs in okomprimerat** (engelska: **Load unpacked**).
5. Välj den uppackade mappen `Reformationsbibeln-Chrome-1.1.0` som innehåller `manifest.json`.
6. Öppna https://bibelonline.se/bibelindex.php och välj **Läs Bibeln** eller **Studera Bibeln**.
7. Om en bibelsida redan var öppen, ladda om den.

Du ska välja mappen, inte själva ZIP-filen. Behåll mappen där du lade den;
Chrome använder dess filer. Tillägget behöver inte publiceras i Chrome Web Store.
Tillägget visas även under Chromes pusselikon och kan fästas där.

## Använd spelaren

- Alla versfiler i det aktuella kapitlet hämtas och kontrolleras innan **Spela** blir tillgängligt.
- **Spela / pausa**: lyssna eller pausa. Föregående/nästa pil byter vers.
- **Tidslinjen**: klicka eller dra för att gå till en valfri tid i kapitlet.
  Tooltipen visar versnummer och kapitlets tidsposition. Fokusera reglaget och
  använd piltangenterna för att spola med tangentbordet.
- **Följ vers**: aktuell vers markeras alltid efter att uppspelning eller spolning
  har startat. När knappen är på rullar sidan automatiskt när versen hamnar utanför
  det synliga området. Knappen fungerar även när ljudet är pausat.
- **Loop**: varje klick växlar **av → kapitel → aktuell vers → av**.
  När en vers loopas kan du välja en annan vers genom att spola eller använda pilarna.
- **Hastighet och volym**: ändra med reglagen. Dessa inställningar och följläget sparas lokalt.
- När loop är av fortsätter nästa kapitel automatiskt, även över bokgränser,
  och dess ljud hämtas först i sin helhet. Loop har företräde över nästa kapitel.
- Manuellt sidbyte, omladdning eller stängd flik stoppar uppspelningen.
  Att växla mellan Läs Bibeln och Studera Bibeln startar inte ljudet automatiskt.
- **Anmäl uttalsfel**: pausar ljudet och öppnar den aktuella versen. Markera ett
  eller flera ord genom att klicka på dem; klicka igen för att ta bort markeringen.
  Välj en annan vers i kapitelmenyn i formuläret om det behövs. Beskrivningen är
  valfri med markerade ord, men krävs om du inte markerar ord. Efter en anmälan
  startar du ljudet igen med **Spela**.

Innan rapporteringen används måste projektägaren publicera reglerna i
`firebase/firestore.rules`. Se [Firebase-instruktionerna](firebase/README.md).
Anmälningar granskas i Firebase Console, i samlingen `pronunciationReports`.

Om Chrome blockerar automatisk ljudstart, visar spelaren att kapitlet är förladdat
och att du ska trycka **Spela**. Det finns ingen bakgrundsuppspelning efter sidbyte.

## Ljudkällan

Katalog: https://github.com/akhansson88/reformationsbibeln-audio/blob/main/catalog.json

Tillägget använder befintliga AI-inlästa MP3-filer i samma repos GitHub Releases.
Det genererar inget nytt ljud och behöver inga API-nycklar eller ElevenLabs-krediter.
Kapitel utan publicerat ljud visar **Ljud saknas**. Uppspelningen stannar om nästa
kapitel saknar ljud; den hoppar inte över kapitel. Katalogen hämtas på nytt vid
kapitelöppning och när du väljer **Försök igen**.

Webbplatsen visar källtexten som Reformationsbibeln 2016. Ljudkatalogens interna
översättnings-ID är `reformationsbibeln2026`. Tillägget använder kopplingen i repot.
Tillägget ger ingen ny licens för bibeltexten eller ljudet.

## Integritet och behörigheter

Spelaren läggs bara till på de två angivna bibelsidorna. Den läser det valda
kapitlet och textens verselement för att markera och rulla till rätt vers.
Ingen analys, annonsering eller telemetri ingår.

När du själv skickar en uttalsanmälan skapas en anonym Firebase-identitet utan
synlig inloggning. Versreferens, versens text, markerade ord, beskrivning,
ljudfilens version och en tidsstämpel skickas till projektet `reformationsbibeln-fel`.
Inget namn eller e-post samlas in. En anonym teknisk identitet sparas lokalt
av Firebase-autentiseringen. Rapportering kontaktar inte Firebase före ett
första försök att skicka en anmälan. Uppgifterna i ett öppet formulär behålls
vid nätverksfel; oskickade formulär följer inte med vid sidbyte.

Nätverksbehörigheter behövs för `github.com`, `raw.githubusercontent.com` och
`release-assets.githubusercontent.com`, samt för rapportering till
`identitytoolkit.googleapis.com`, `securetoken.googleapis.com` och
`firestore.googleapis.com`. Chrome beviljar sådana behörigheter per
värdnamn; tilläggets kod begränsar ljudlänkarna till detta repo och dess versfiler.
GitHub ser vanliga nedladdningsförfrågningar för ljudet. Webbläsarens vanliga
nätverksuppgifter följer med dem, men inga inloggningsuppgifter skickas av spelaren.

`storage` används för spelarinställningar och ett kortlivat, flikbundet tillstånd
vid spelarens automatiska kapitelbyte. Ljudet förladdas i minnet och släpps när
kapitlet eller sidan lämnas. Ingen permanent ljudsamling laddas ner av tillägget.

## Utveckling

Utvecklingsfilerna och testerna finns i repots `chrome-extension`-mapp och ingår
inte i installationspaketet. Kommandona nedan körs från källkoden.

All JavaScript, inklusive Firebase SDK, ingår i tillägget. Ingen fjärrkod körs. Spelaren ligger i en
isolerad extension-iframe, som tas bort vid sidbyte; ljudet är därför inte beroende
av service workerns livslängd. DOM-kopplingen använder läsvyns vers-spans och
studievyns befintliga versrader. Noter och referenslänkar behåller sina funktioner.

Kör `npm ci`, `npm run build` och `npm test` från denna mapp.
`npm run test:rules` använder Firestore-emulatorn (Java 21 krävs).
Webbläsartestet kräver Playwright och dess Chromium-installation och kan köras
med `node tests/browser.cjs`. Det använder lokala fixtures och mockade ljudlänkar;
det genererar inget ljud hos en extern tjänst. Se tests/README.md.

Verifiering: lokala tester täcker spelarlogik, DOM-koppling, rapportformulär,
ordmarkering, validering och den paketerade Firebase-klientens serversvar.
Regeltester och fullständiga Chromium-tester körs även av repots
`Chrome extension`-workflow. Tester använder fixtures, mockade API-svar eller
demoprojektets emulator och skriver inget i din databas.

Från repots rot: `python chrome-extension/scripts/build-books.py` återskapar
bokmetadata; `python chrome-extension/scripts/package.py --output /absolut/sökväg`
skapar installationspaketet utan testkod och utvecklingsverktyg.

## Felsökning

- Spelaren syns inte: kontrollera att tillägget är aktiverat, ladda om sidan och
  gå via Bibelonlines startsida till Läs Bibeln eller Studera Bibeln.
- Ljud saknas: kapitlet finns inte i den publicerade ljudkatalogen ännu.
- Hämtningsfel: kontrollera internetanslutningen och välj **Försök igen**.
- Om sidans HTML ändras kan verskopplingen behöva uppdateras. Spelaren visar
  när hela kapitlets verser inte kan kopplas till sidans text.
- Uppdatera en lokal installation genom att ersätta dess filer och sedan
  klicka **Ladda om** på tilläggets kort i `chrome://extensions`.

Installationspaketet innehåller inga bibelkapitel eller MP3-filer.
