import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_BACKEND_URL = "https://vault-backend-t9nu.onrender.com";

const KEYS = {
  BACKEND_URL: "@vaultcall_backend_url",
  PROFILE: "@vaultcall_profile",
  AUTO_RECORD: "@vaultcall_auto_record",
  CACHED_CONTACTS: "@vaultcall_cached_contacts",
  CACHED_TRANSCRIPTS: "@vaultcall_cached_transcripts",
  CALL_LOGS: "@vaultcall_call_logs",
  PENDING_CONTACTS: "@vaultcall_pending_contacts",
  PENDING_TRANSCRIPTS: "@vaultcall_pending_transcripts",
};

export function normalizePhone(raw = "") {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export async function getBackendUrl() {
  try { return (await AsyncStorage.getItem(KEYS.BACKEND_URL))?.trim() || DEFAULT_BACKEND_URL; }
  catch { return DEFAULT_BACKEND_URL; }
}

export async function setBackendUrl(url) {
  const clean = (url || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
  await AsyncStorage.setItem(KEYS.BACKEND_URL, clean);
  return clean;
}

export async function getProfile() {
  try {
    const p = JSON.parse((await AsyncStorage.getItem(KEYS.PROFILE)) || "null");
    return { name: p?.name || "Me", lang: p?.lang || "hi-IN" };
  } catch { return { name: "Me", lang: "hi-IN" }; }
}

export async function saveProfile(profile) {
  const clean = { name: (profile?.name || "Me").trim() || "Me", lang: profile?.lang || "hi-IN" };
  await AsyncStorage.setItem(KEYS.PROFILE, JSON.stringify(clean));
  return clean;
}

export async function getAutoRecord() {
  try { const v = await AsyncStorage.getItem(KEYS.AUTO_RECORD); return v === null ? true : v === "true"; }
  catch { return true; }
}

export async function setAutoRecord(val) {
  await AsyncStorage.setItem(KEYS.AUTO_RECORD, val ? "true" : "false");
}

async function getList(key) {
  try { const d = JSON.parse((await AsyncStorage.getItem(key)) || "[]"); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

export const getCachedContacts = () => getList(KEYS.CACHED_CONTACTS);
export const saveCachedContacts = (v) => AsyncStorage.setItem(KEYS.CACHED_CONTACTS, JSON.stringify(v || []));
export const getCachedTranscripts = () => getList(KEYS.CACHED_TRANSCRIPTS);
export const saveCachedTranscripts = (v) => AsyncStorage.setItem(KEYS.CACHED_TRANSCRIPTS, JSON.stringify(v || []));
export const getCallLogs = () => getList(KEYS.CALL_LOGS);
export const saveCallLogs = (v) => AsyncStorage.setItem(KEYS.CALL_LOGS, JSON.stringify(v || []));
export const getPendingContacts = () => getList(KEYS.PENDING_CONTACTS);
export const savePendingContacts = (v) => AsyncStorage.setItem(KEYS.PENDING_CONTACTS, JSON.stringify(v || []));
export const getPendingTranscripts = () => getList(KEYS.PENDING_TRANSCRIPTS);
export const savePendingTranscripts = (v) => AsyncStorage.setItem(KEYS.PENDING_TRANSCRIPTS, JSON.stringify(v || []));

export async function appendCallLog(entry) {
  const next = [entry, ...(await getCallLogs())].slice(0, 150);
  await saveCallLogs(next);
  return next;
}

export async function queuePendingContact(item) {
  const list = await getPendingContacts(); list.push(item); await savePendingContacts(list);
}

export async function queuePendingTranscript(item) {
  const list = await getPendingTranscripts(); list.push(item); await savePendingTranscripts(list);
}

export async function fetchContactsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

export async function createContactRemote(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function syncPhoneContactsToDatabase(baseUrl, phoneContacts = []) {
  const contacts = (phoneContacts || [])
    .filter((c) => c && c.name && normalizePhone(c.phone).length >= 5)
    .slice(0, 1000)
    .map((c) => ({ name: String(c.name).trim(), phone: String(c.phone).trim(), tag: "Phone Book", notes: "From your phone contacts" }));
  if (!contacts.length) return { ok: true, savedCount: 0 };
  const res = await fetch(`${baseUrl}/api/v1/contacts/bulk`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contacts }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function fetchCallLogsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/call-logs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

export async function syncCallLogsToDatabase(baseUrl, logs = []) {
  const clean = (logs || []).slice(0, 150).map((l) => ({
    number: l?.number || "Unknown", name: l?.name || "Unknown Caller",
    source: l?.source || "Phone Book", notes: l?.notes || "",
    callType: l?.callType || "Call", createdAt: l?.createdAt || "",
  }));
  const res = await fetch(`${baseUrl}/api/v1/call-logs/bulk`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logs: clean }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function fetchTranscriptsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

export async function createTranscriptRemote(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function flushPendingQueue(baseUrl) {
  let syncedContactsCount = 0, syncedTranscriptsCount = 0;
  const pc = await getPendingContacts();
  if (pc.length) {
    const rem = [];
    for (const c of pc) { try { await createContactRemote(baseUrl, c); syncedContactsCount += 1; } catch { rem.push(c); } }
    await savePendingContacts(rem);
  }
  const pt = await getPendingTranscripts();
  if (pt.length) {
    const rem = [];
    for (const t of pt) { try { await createTranscriptRemote(baseUrl, t); syncedTranscriptsCount += 1; } catch { rem.push(t); } }
    await savePendingTranscripts(rem);
  }
  return { syncedContactsCount, syncedTranscriptsCount };
}