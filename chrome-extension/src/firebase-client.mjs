import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth/web-extension";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc, setLogLevel } from "firebase/firestore/lite";

const firebaseConfig = {
  apiKey: "AIzaSyC7vMX-c7MaRqoWWewafunnXONB8APdG0Y",
  authDomain: "reformationsbibeln-fel.firebaseapp.com",
  projectId: "reformationsbibeln-fel",
  storageBucket: "reformationsbibeln-fel.firebasestorage.app",
  messagingSenderId: "601385491636",
  appId: "1:601385491636:web:9d7dedc55db216d8c08be1"
};

let services, authentication;
setLogLevel("silent");
const attempted = new Set();
function getServices() {
  if (!services) {
    const app = initializeApp(firebaseConfig);
    services = { auth: getAuth(app), db: getFirestore(app) };
  }
  return services;
}
async function anonymousUser(auth) {
  if (!authentication) authentication = (async () => {
    await auth.authStateReady();
    const user = auth.currentUser || (await signInAnonymously(auth)).user;
    if (!user.isAnonymous) throw new Error("Anonym rapportering kunde inte startas.");
    return user;
  })().catch(error => { authentication = null; throw error; });
  return authentication;
}
function friendlyError(error) {
  const code = String(error?.code || "");
  if (/permission-denied|unauthorized|operation-not-allowed|invalid-api-key|api-key-not-valid/.test(code)) {
    return Object.assign(new Error("Rapporteringen är inte tillgänglig just nu. Försök igen senare.", { cause: error }), { code });
  }
  return Object.assign(new Error("Kunde inte bekräfta att anmälan sparats. Kontrollera internetanslutningen och försök igen. Dina uppgifter finns kvar.", { cause: error }), { code });
}
async function submit(draft) {
  try {
    const { auth, db } = getServices(), user = await anonymousUser(auth);
    const id = `${user.uid}_${draft.clientReportId}`, ref = doc(db, "pronunciationReports", id);
    // A retry uses the same document ID. Check a receipt after an uncertain response;
    // create-only rules prevent a second write from changing an existing report.
    if (attempted.has(id) && (await getDoc(ref)).exists()) return { id };
    attempted.add(id);
    try {
      // Lite has no offline write queue. Success means a server acknowledgement.
      await setDoc(ref, { ...draft, reporterUid: user.uid, createdAt: serverTimestamp() });
      return { id };
    } catch (error) {
      try { if ((await getDoc(ref)).exists()) return { id }; } catch { /* Retry the same ID later. */ }
      throw error;
    }
  } catch (error) { throw friendlyError(error); }
}

globalThis.RBReportStore = Object.freeze({ submit });
