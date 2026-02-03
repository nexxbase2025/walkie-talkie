import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, onSnapshot, serverTimestamp, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/**
 * ✅ PASO 1: pega aquí tu firebaseConfig (Firebase Console → Web App)
 * ⚠️ No pegues tus llaves privadas aquí.
 */
const firebaseConfig = {
  apiKey: "AIzaSyB3JEE6-txcJtRo2jFnAXu5O_LZ3ysTc2M",
  authDomain: "walkie-pwa-50a22.firebaseapp.com",
  projectId: "walkie-pwa-50a22",
  storageBucket: "walkie-pwa-50a22.firebasestorage.app",
  messagingSenderId: "962381266853",
  appId: "1:962381266853:web:a20f5b58a4b60e3c94324c"
};


/**
 * ✅ PASO 2: pega aquí tu VAPID PUBLIC KEY (para Web Push)
 * La VAPID PRIVATE KEY va en Vercel (env var).
 */
const VAPID_PUBLIC_KEY = "TU_VAPID_PUBLIC_KEY";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// UI
const roomInput = document.getElementById("roomInput");
const newRoomBtn = document.getElementById("newRoomBtn");
const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const pttBtn = document.getElementById("pttBtn");
const statusEl = document.getElementById("status");
const peersCountEl = document.getElementById("peersCount");
const meterBar = document.getElementById("meterBar");
const qrEl = document.getElementById("qr");
const shareLinkEl = document.getElementById("shareLink");
const copyBtn = document.getElementById("copyBtn");
const shareBtn = document.getElementById("shareBtn");
const installBtn = document.getElementById("installBtn");
const dndBtn = document.getElementById("dndBtn");
const pushBtn = document.getElementById("pushBtn");
const modeSelect = document.getElementById("modeSelect");
const toUidInput = document.getElementById("toUidInput");

// PWA install
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
  installBtn.hidden = true;
});

// Service worker
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");

// helpers
const uid = crypto.randomUUID().slice(0, 8);
let roomId = "";
let joined = false;
let dnd = false;

// audio
let localStream = null;
let audioTrack = null;
let analyser = null, audioCtx = null;

// peers
const peers = new Map(); // peerId -> { pc, callId }
let unsubPeers = null;
let unsubCalls = [];

// WebRTC
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function setStatus(t){ statusEl.textContent = t; }
function setPeersCount(){ peersCountEl.textContent = String(peers.size); }

function makeRoomId(){
  const w = ["amigos","grupo","walkie","canal","ruta","familia"];
  return `${w[Math.floor(Math.random()*w.length)]}-${Math.floor(100+Math.random()*900)}`;
}

function currentRoomFromURL(){
  const u = new URL(location.href);
  return u.searchParams.get("room") || "";
}

function updateQR(){
  const link = new URL(location.href);
  link.searchParams.set("room", roomId);
  shareLinkEl.textContent = link.toString();
  qrEl.innerHTML = "";
  // global QRCode from qrcodejs
  // eslint-disable-next-line no-undef
  new QRCode(qrEl, { text: link.toString(), width: 170, height: 170, correctLevel: QRCode.CorrectLevel.M });
  copyBtn.disabled = false;
  shareBtn.disabled = false;
}

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLinkEl.textContent);
  setStatus("Link copiado ✅");
  setTimeout(() => setStatus(joined ? "Conectado" : "Listo"), 900);
});

shareBtn.addEventListener("click", async () => {
  const url = shareLinkEl.textContent;
  if (navigator.share) {
    try { await navigator.share({ title:"Walkie PWA", text:"Entra a la sala:", url }); } catch {}
  } else {
    await navigator.clipboard.writeText(url);
    setStatus("Copiado ✅");
    setTimeout(() => setStatus(joined ? "Conectado" : "Listo"), 900);
  }
});

// ---------- AUDIO ----------
async function ensureLocalAudio(){
  if (localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });

  audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = false; // PTT starts muted

  // meter
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(localStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  meterLoop();

  return localStream;
}

function meterLoop(){
  if (!analyser) return;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i=0; i<data.length; i++){
    const v = (data[i] - 128) / 128;
    sum += v*v;
  }
  const rms = Math.sqrt(sum / data.length);
  const pct = Math.min(100, Math.floor(rms * 220));
  meterBar.style.width = `${pct}%`;
  requestAnimationFrame(meterLoop);
}

function setPTT(on){
  if (audioTrack) audioTrack.enabled = on;
  pttBtn.classList.toggle("talking", on);
}

// ---------- FIRESTORE PATHS ----------
const roomRef = () => doc(db, "rooms", roomId);
const partRef = (pid) => doc(db, "rooms", roomId, "participants", pid);
const callsCol = () => collection(db, "rooms", roomId, "calls");
const pushSubRef = () => doc(db, "rooms", roomId, "pushSubs", uid);

async function upsertParticipant(){
  await setDoc(partRef(uid), { joinedAt: serverTimestamp(), lastSeen: serverTimestamp() }, { merge:true });
}

async function removeParticipant(){
  try { await deleteDoc(partRef(uid)); } catch {}
}

// ---------- PUSH (best effort) ----------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

async function ensurePush() {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  await setDoc(pushSubRef(), {
    uid,
    endpoint: sub.endpoint,
    keys: sub.toJSON().keys,
    updatedAt: serverTimestamp()
  }, { merge:true });

  return true;
}

async function sendPushAlert() {
  try {
    const kind = modeSelect.value;
    const toUid = (kind === "direct") ? (toUidInput.value || "").trim() : null;

    await fetch("/api/push-alert", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        roomId,
        fromUid: uid,
        kind,
        toUid: toUid || null,
        message: kind === "direct" ? `Llamada directa (${uid})` : `Alguien habla (${uid})`
      })
    });
  } catch {}
}

// ---------- WEBRTC MESH ----------
function createRemoteAudioEl(peerId){
  let el = document.getElementById(`a_${peerId}`);
  if (el) return el;
  el = document.createElement("audio");
  el.id = `a_${peerId}`;
  el.autoplay = true;
  el.playsInline = true;
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

async function ensurePeer(peerId){
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  const remoteEl = createRemoteAudioEl(peerId);

  pc.ontrack = (ev) => {
    if (dnd) return; // best effort "no molestar"
    const [stream] = ev.streams;
    remoteEl.srcObject = stream;
  };

  // If we already have local stream, add it
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  const obj = { pc, callId: null, peerId };
  peers.set(peerId, obj);
  setPeersCount();
  return obj;
}

async function startCallTo(peerId){
  const peer = await ensurePeer(peerId);

  await ensureLocalAudio();
  // add tracks if needed
  if (peer.pc.getSenders().length === 0) localStream.getTracks().forEach(t => peer.pc.addTrack(t, localStream));

  const callDoc = await addDoc(callsCol(), { from: uid, to: peerId, createdAt: serverTimestamp() });
  peer.callId = callDoc.id;

  peer.pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    await addDoc(collection(db, "rooms", roomId, "calls", callDoc.id, "candidates"), {
      from: uid,
      candidate: e.candidate.toJSON(),
      createdAt: serverTimestamp()
    });
  };

  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);

  await updateDoc(doc(db, "rooms", roomId, "calls", callDoc.id), {
    offer: { type: offer.type, sdp: offer.sdp }
  });
}

async function answerCall(callId, callData){
  const peerId = callData.from;
  const peer = await ensurePeer(peerId);
  peer.callId = callId;

  await ensureLocalAudio();
  if (peer.pc.getSenders().length === 0) localStream.getTracks().forEach(t => peer.pc.addTrack(t, localStream));

  peer.pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    await addDoc(collection(db, "rooms", roomId, "calls", callId, "candidates"), {
      from: uid,
      candidate: e.candidate.toJSON(),
      createdAt: serverTimestamp()
    });
  };

  await peer.pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);

  await updateDoc(doc(db, "rooms", roomId, "calls", callId), {
    answer: { type: answer.type, sdp: answer.sdp }
  });
}

function listenCandidates(callId){
  const unsub = onSnapshot(
    collection(db, "rooms", roomId, "calls", callId, "candidates"),
    async (snap) => {
      for (const ch of snap.docChanges()){
        if (ch.type !== "added") continue;
        const data = ch.doc.data();
        if (data.from === uid) continue;
        try{
          const cand = new RTCIceCandidate(data.candidate);
          for (const [, obj] of peers){
            if (obj.callId === callId){
              await obj.pc.addIceCandidate(cand);
            }
          }
        } catch {}
      }
    }
  );
  unsubCalls.push(unsub);
}

function listenCalls(){
  const qToMe = query(callsCol(), where("to","==",uid));
  const unsub1 = onSnapshot(qToMe, async (snap) => {
    for (const ch of snap.docChanges()){
      if (ch.type !== "added") continue;
      const callId = ch.doc.id;
      const data = ch.doc.data();
      if (data.offer && !data.answer){
        await answerCall(callId, data);
        listenCandidates(callId);
      }
    }
  });

  const qFromMe = query(callsCol(), where("from","==",uid));
  const unsub2 = onSnapshot(qFromMe, async (snap) => {
    for (const ch of snap.docChanges()){
      const callId = ch.doc.id;
      const data = ch.doc.data();
      if (!data.answer) continue;

      for (const [, obj] of peers){
        if (obj.callId === callId){
          if (obj.pc.currentRemoteDescription) continue;
          try{
            await obj.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            listenCandidates(callId);
          } catch {}
        }
      }
    }
  });

  unsubCalls.push(unsub1, unsub2);
}

// ---------- JOIN / LEAVE ----------
async function joinRoom(){
  roomId = (roomInput.value || "").trim();
  if (!roomId) return;

  joined = true;
  setStatus("Conectando…");

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  pttBtn.disabled = false;
  dndBtn.disabled = false;
  pushBtn.disabled = false;

  await setDoc(roomRef(), { updatedAt: serverTimestamp() }, { merge:true });
  await upsertParticipant();

  updateQR();
  listenCalls();

  unsubPeers = onSnapshot(collection(db, "rooms", roomId, "participants"), async (snap) => {
    const ids = snap.docs.map(d => d.id).filter(id => id !== uid);

    // best effort cap for performance (1–5 recommended)
    // connect to new participants
    for (const id of ids){
      if (!peers.has(id)){
        // deterministic tie-break to avoid duplicate offers
        if (uid < id) await startCallTo(id);
        else await ensurePeer(id);
      }
    }

    // remove peers who left
    for (const [id, obj] of peers){
      if (!ids.includes(id)){
        try { obj.pc.close(); } catch {}
        peers.delete(id);
      }
    }
    setPeersCount();
  });

  setStatus("Conectado");
}

async function leaveRoom(){
  setStatus("Saliendo…");
  joined = false;

  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  pttBtn.disabled = true;
  dndBtn.disabled = true;
  pushBtn.disabled = true;

  setPTT(false);

  if (unsubPeers) { unsubPeers(); unsubPeers = null; }
  for (const u of unsubCalls) try{ u(); } catch {}
  unsubCalls = [];

  for (const [, obj] of peers){
    try{ obj.pc.close(); } catch {}
  }
  peers.clear();
  setPeersCount();

  await removeParticipant();

  setStatus("Listo");
}

joinBtn.addEventListener("click", joinRoom);
leaveBtn.addEventListener("click", leaveRoom);

newRoomBtn.addEventListener("click", () => {
  const r = makeRoomId();
  roomInput.value = r;
});

// DND
dndBtn.addEventListener("click", () => {
  dnd = !dnd;
  dndBtn.textContent = dnd ? "No molestar: ON" : "No molestar: OFF";
});

// Push button
pushBtn.addEventListener("click", async () => {
  if (!roomId) { setStatus("Entra a una sala primero"); return; }
  const ok = await ensurePush();
  setStatus(ok ? "Alertas activadas ✅" : "Alertas no activadas");
  setTimeout(() => setStatus(joined ? "Conectado" : "Listo"), 1200);
});

// PTT interactions
async function pttDown(e){
  e.preventDefault();
  if (!joined) return;
  await ensureLocalAudio();
  if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();

  setPTT(true);
  setStatus("Hablando…");
  if (navigator.vibrate) navigator.vibrate(15);

  // best-effort push alert
  await sendPushAlert();
}
function pttUp(e){
  e.preventDefault();
  if (!joined) return;
  setPTT(false);
  setStatus("Conectado");
  if (navigator.vibrate) navigator.vibrate(8);
}

pttBtn.addEventListener("pointerdown", pttDown);
window.addEventListener("pointerup", pttUp);
pttBtn.addEventListener("pointercancel", pttUp);

// auto-fill room from URL
const rFromUrl = currentRoomFromURL();
if (rFromUrl){
  roomInput.value = rFromUrl;
  roomId = rFromUrl;
  updateQR();
  roomId = "";
}

// keep alive presence
setInterval(async () => {
  if (!joined || !roomId) return;
  try{ await updateDoc(partRef(uid), { lastSeen: serverTimestamp() }); }catch{}
}, 15000);
