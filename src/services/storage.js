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
  try {
    const val = await AsyncStorage.getItem(KEYS.BACKEND_URL);
    return val && val.trim() ? val.trim() : DEFAULT_BACKEND_URL;
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

export async function setBackendUrl(url) {
  const clean = (url || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
  await AsyncStorage.setItem(KEYS.BACKEND_URL, clean);
  return clean;
}

export async function getProfile() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.PROFILE);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      name: parsed?.name || "Me",
      lang: parsed?.lang || "hi-IN",
    };
  } catch {
    return { name: "Me", lang: "hi-IN" };
  }
}

export async function saveProfile(profile) {
  const clean = {
    name: (profile?.name || "Me").trim() || "Me",
    lang: profile?.lang || "hi-IN",
  };
  await AsyncStorage.setItem(KEYS.PROFILE, JSON.stringify(clean));
  return clean;
}

export async function getAutoRecord() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.AUTO_RECORD);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

export async function setAutoRecord(val) {
  await AsyncStorage.setItem(KEYS.AUTO_RECORD, val ? "true" : "false");
}

export async function getCachedContacts() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.CACHED_CONTACTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveCachedContacts(list) {
  await AsyncStorage.setItem(KEYS.CACHED_CONTACTS, JSON.stringify(Array.isArray(list) ? list : []));
}

export async function getCachedTranscripts() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.CACHED_TRANSCRIPTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveCachedTranscripts(list) {
  await AsyncStorage.setItem(KEYS.CACHED_TRANSCRIPTS, JSON.stringify(Array.isArray(list) ? list : []));
}

export async function getCallLogs() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.CALL_LOGS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveCallLogs(list) {
  await AsyncStorage.setItem(KEYS.CALL_LOGS, JSON.stringify(Array.isArray(list) ? list : []));
}

export async function appendCallLog(entry) {
  const current = await getCallLogs();
  const next = [entry, ...current].slice(0, 150);
  await saveCallLogs(next);
  return next;
}

export async function getPendingContacts() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.PENDING_CONTACTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function savePendingContacts(list) {
  await AsyncStorage.setItem(KEYS.PENDING_CONTACTS, JSON.stringify(Array.isArray(list) ? list : []));
}

export async function queuePendingContact(item) {
  const list = await getPendingContacts();
  list.push(item);
  await savePendingContacts(list);
}

export async function getPendingTranscripts() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.PENDING_TRANSCRIPTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function savePendingTranscripts(list) {
  await AsyncStorage.setItem(KEYS.PENDING_TRANSCRIPTS, JSON.stringify(Array.isArray(list) ? list : []));
}

export async function queuePendingTranscript(item) {
  const list = await getPendingTranscripts();
  list.push(item);
  await savePendingTranscripts(list);
}

export async function fetchContactsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`);
  if (!res.ok) throw new Error(`Contacts HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function createContactRemote(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Create contact HTTP ${res.status}`);
  return await res.json();
}

export async function syncPhoneContactsToDatabase(baseUrl, phoneContacts = []) {
  const cleanList = (Array.isArray(phoneContacts) ? phoneContacts : [])
    .filter((c) => c && c.name && normalizePhone(c.phone).length >= 5)
    .slice(0, 1000)
    .map((c) => ({
      name: String(c.name).trim(),
      phone: String(c.phone).trim(),
      tag: "Phone Book",
      notes: "From your phone contacts",
    }));

  if (!cleanList.length) return { ok: true, savedCount: 0 };
  const res = await fetch(`${baseUrl}/api/v1/contacts/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: cleanList }),
  });
  if (!res.ok) throw new Error(`Bulk contacts HTTP ${res.status}`);
  return await res.json();
}

export async function fetchCallLogsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/call-logs`);
  if (!res.ok) throw new Error(`Call logs HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function syncCallLogsToDatabase(baseUrl, logs = []) {
  const cleanLogs = (Array.isArray(logs) ? logs : []).slice(0, 150).map((l) => ({
    number: l?.number || "Unknown",
    name: l?.name || "Unknown Caller",
    source: l?.source || "Phone Book",
    notes: l?.notes || "",
    callType: l?.callType || "Call",
    createdAt: l?.createdAt || "",
  }));
  const res = await fetch(`${baseUrl}/api/v1/call-logs/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logs: cleanLogs }),
  });
  if (!res.ok) throw new Error(`Bulk call logs HTTP ${res.status}`);
  return await res.json();
}

export async function fetchTranscriptsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`);
  if (!res.ok) throw new Error(`Transcripts HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function createTranscriptRemote(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Create transcript HTTP ${res.status}`);
  return await res.json();
}

export async function flushPendingQueue(baseUrl) {
  let syncedContactsCount = 0;
  let syncedTranscriptsCount = 0;

  const pendingC = await getPendingContacts();
  if (pendingC.length) {
    const remainingC = [];
    for (const c of pendingC) {
      try {
        await createContactRemote(baseUrl, c);
        syncedContactsCount += 1;
      } catch {
        remainingC.push(c);
      }
    }
    await savePendingContacts(remainingC);
  }

  const pendingT = await getPendingTranscripts();
  if (pendingT.length) {
    const remainingT = [];
    for (const t of pendingT) {
      try {
        await createTranscriptRemote(baseUrl, t);
        syncedTranscriptsCount += 1;
      } catch {
        remainingT.push(t);
      }
    }
    await savePendingTranscripts(remainingT);
  }

  return { syncedContactsCount, syncedTranscriptsCount };
}