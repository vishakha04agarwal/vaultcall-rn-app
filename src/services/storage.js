import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_BACKEND_URL = "https://vault-backend-t9nu.onrender.com";

const KEYS = {
  API_URL: "@vaultcall_api_url",
  PROFILE: "@vaultcall_profile",
  CONTACTS: "@vaultcall_contacts",
  TRANSCRIPTS: "@vaultcall_transcripts",
  CALL_LOGS: "@vaultcall_call_logs",
  AUTO_RECORD: "@vaultcall_auto_record",
};

export function normalizePhone(raw = "") {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export async function getBackendUrl() {
  const saved = await AsyncStorage.getItem(KEYS.API_URL);
  if (!saved || !saved.trim() || saved.includes("localhost")) {
    return DEFAULT_BACKEND_URL;
  }
  return saved.trim().replace(/\/$/, "");
}

export async function setBackendUrl(url) {
  const clean = (url || DEFAULT_BACKEND_URL).trim().replace(/\/$/, "");
  await AsyncStorage.setItem(KEYS.API_URL, clean);
  return clean;
}

export async function getProfile() {
  const raw = await AsyncStorage.getItem(KEYS.PROFILE);
  if (!raw) return { name: "Me", lang: "hi-IN" };
  try {
    return { name: "Me", lang: "hi-IN", ...JSON.parse(raw) };
  } catch {
    return { name: "Me", lang: "hi-IN" };
  }
}

export async function saveProfile(profile) {
  await AsyncStorage.setItem(KEYS.PROFILE, JSON.stringify(profile));
}

export async function getAutoRecord() {
  const raw = await AsyncStorage.getItem(KEYS.AUTO_RECORD);
  return raw === "true";
}

export async function setAutoRecord(val) {
  await AsyncStorage.setItem(KEYS.AUTO_RECORD, val ? "true" : "false");
}

export async function getCachedContacts() {
  const raw = await AsyncStorage.getItem(KEYS.CONTACTS);
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveCachedContacts(list) {
  await AsyncStorage.setItem(KEYS.CONTACTS, JSON.stringify(list || []));
}

export async function getCachedTranscripts() {
  const raw = await AsyncStorage.getItem(KEYS.TRANSCRIPTS);
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveCachedTranscripts(list) {
  await AsyncStorage.setItem(KEYS.TRANSCRIPTS, JSON.stringify(list || []));
}

export async function getCallLogs() {
  const raw = await AsyncStorage.getItem(KEYS.CALL_LOGS);
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function appendCallLog(entry) {
  const current = await getCallLogs();
  const next = [entry, ...current].slice(0, 100);
  await AsyncStorage.setItem(KEYS.CALL_LOGS, JSON.stringify(next));
  return next;
}

export async function fetchContactsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`);
  if (!res.ok) throw new Error(`Contacts fetch failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function createContactRemote(baseUrl, contact) {
  const res = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contact),
  });
  if (!res.ok) throw new Error(`Contact save failed (${res.status})`);
  return res.json();
}

export async function fetchTranscriptsRemote(baseUrl) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`);
  if (!res.ok) throw new Error(`Transcripts fetch failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function createTranscriptRemote(baseUrl, transcript) {
  const res = await fetch(`${baseUrl}/api/v1/transcripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(transcript),
  });
  if (!res.ok) throw new Error(`Transcript save failed (${res.status})`);
  return res.json();
}
