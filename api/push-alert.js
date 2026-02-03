import admin from "firebase-admin";
import webpush from "web-push";

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    initFirebaseAdmin();

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const { roomId, fromUid, kind = "group", toUid = null, message = "" } = req.body || {};
    if (!roomId || !fromUid) return res.status(400).json({ ok: false });

    const db = admin.firestore();
    const snap = await db.collection("rooms").doc(roomId).collection("pushSubs").get();

    const payload = JSON.stringify({
      title: "WALKIE",
      body: message || (kind === "direct" ? "Te están llamando (directo)" : "Alguien está hablando en la sala"),
      url: `/?room=${encodeURIComponent(roomId)}`
    });

    const jobs = [];
    snap.forEach(doc => {
      const s = doc.data();
      if (!s?.endpoint || !s?.keys) return;
      if (s.uid === fromUid) return;
      if (kind === "direct" && toUid && s.uid !== toUid) return;

      const sub = { endpoint: s.endpoint, keys: s.keys };
      jobs.push(webpush.sendNotification(sub, payload).catch(() => null));
    });

    await Promise.all(jobs);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
