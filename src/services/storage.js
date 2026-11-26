import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  SECURITY_CONSTANTS,
  buildSecureHeaders,
  getEnvBackendUrl,
  normalizeAndValidateUrl,
} from "../config/security";
import { fetchWithTimeout } from "./syncManager";

export const DEFAULT_BACKEND_URL = getEnvBackendUrl("https://vault-backend-t9nu.onrender.com");

const KEYS = {
  API_URL: "@vaultcall_api_url",
  PROFILE: "@vaultcall_profile",
  CONTACTS: "@vaultcall_contacts",
  TRANSCRIPTS: "@vaultcall_transcripts",
  CALL_LOGS: "@vaultcall_call_logs",
  AUTO_RECORD: "@vaultcall_auto_record",
  PENDING_CONTACTS: "@vaultcall_pending_contacts",
  PENDING_TRANSCRIPTS: "@vaultcall_pending_transcripts",
};

export function normalizePhone(raw = "") {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function extractListPayload(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.contacts)) return data.contacts;
  if (data && Array.isArray(data.transcripts)) return data.transcripts;
  return [];
}

export async function getBackendUrl() {
  const saved = await AsyncStorage.getItem(KEYS.API_URL);
  return normalizeAndValidateUrl(saved, DEFAULT_BACKEND_URL);
}

export async function setBackendUrl(url) {
  const clean = normalizeAndValidateUrl(url, DEFAULT_BACKEND_URL);
  await AsyncStorage.setItem(KEYS.API_URL, clean);
  return clean;
}

export async function getProfile() {
  const raw = await AsyncStorage.getItem(KEYS.PROFILE);
  if (!raw) return { name: "Me", lang: "hi-IN" };
  try {
    const p = JSON.parse(raw);
    return {
      name: typeof p?.name === "string" && p.name.trim() ? p.name.trim() : "Me",
      lang: p?.lang === "en-US" ? "en-US" : "hi-IN",
    };
  } catch {
    return { name: "Me", lang: "hi-IN" };
  }
}

export async function saveProfile(profile) {
  const clean = {
    name: typeof profile?.name === "string" && profile.name.trim() ? profile.name.trim() : "Me",
    lang: profile?.lang === "en-US" ? "en-US" : "hi-IN",
  };
  await AsyncStorage.setItem(KEYS.PROFILE, JSON.stringify(clean));
  return clean;
}

export async function getAutoRecord() {
  return (await AsyncStorage.getItem(KEYS.AUTO_RECORD)) === "true";
}

export async function setAutoRecord(val) {
  await AsyncStorage.setItem(KEYS.AUTO_RECORD, val ? "true" : "false");
}

async function readArr(key) {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

async function writeArr(key, arr) {
  await AsyncStorage.setItem(key, JSON.stringify(Array.isArray(arr) ? arr : []));
}

export const getCachedContacts = () => readArr(KEYS.CONTACTS);
export const saveCachedContacts = (list) => writeArr(KEYS.CONTACTS, list);
export const getCachedTranscripts = () => readArr(KEYS.TRANSCRIPTS);
export const saveCachedTranscripts = (list) => writeArr(KEYS.TRANSCRIPTS, list);
export const getCallLogs = () => readArr(KEYS.CALL_LOGS);
export const saveCallLogs = (list) => writeArr(KEYS.CALL_LOGS, (Array.isArray(list) ? list : []).slice(0, 150));

export async function appendCallLog(entry) {
  const next = [entry, ...(await getCallLogs())].slice(0, 150);
  await saveCallLogs(next);
  return next;
}

export const getPendingContacts = () => readArr(KEYS.PENDING_CONTACTS);
export const savePendingContacts = (list) => writeArr(KEYS.PENDING_CONTACTS, list);
export async function queuePendingContact(c) {
  const { _queueId, _retries, ...clean } = c || {};
  const next = [clean, ...(await getPendingContacts())];
  await savePendingContacts(next);
  return next;
}

export const getPendingTranscripts = () => readArr(KEYS.PENDING_TRANSCRIPTS);
export const savePendingTranscripts = (list) => writeArr(KEYS.PENDING_TRANSCRIPTS, list);
export async function queuePendingTranscript(t) {
  const { _queueId, _retries, ...clean } = t || {};
  const next = [clean, ...(await getPendingTranscripts())];
  await savePendingTranscripts(next);
  return next;
}

export async function fetchContactsRemote(baseUrl) {
  const clean = normalizeAndValidateUrl(baseUrl, DEFAULT_BACKEND_URL);
  const res = await fetchWithTimeout(
    `${clean}/api/v1/contacts`,
    { method: "GET", headers: buildSecureHeaders() },
    SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Contacts fetch failed (${res.status})`);
  return extractListPayload(await res.json());
}

export async function createContactRemote(baseUrl, contact) {
  const clean = normalizeAndValidateUrl(baseUrl, DEFAULT_BACKEND_URL);
  const { _queueId, _retries, ...payload } = contact || {};
  const res = await fetchWithTimeout(
    `${clean}/api/v1/contacts`,
    {
      method: "POST",
      headers: buildSecureHeaders(),
      body: JSON.stringify(payload),
    },
    SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Contact save failed (${res.status})`);
  const d = await res.json();
  return d && d.data && !Array.isArray(d.data) ? d.data : d;
}

export async function fetchTranscriptsRemote(baseUrl) {
  const clean = normalizeAndValidateUrl(baseUrl, DEFAULT_BACKEND_URL);
  const res = await fetchWithTimeout(
    `${clean}/api/v1/transcripts`,
    { method: "GET", headers: buildSecureHeaders() },
    SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Transcripts fetch failed (${res.status})`);
  return extractListPayload(await res.json());
}

export async function createTranscriptRemote(baseUrl, transcript) {
  const clean = normalizeAndValidateUrl(baseUrl, DEFAULT_BACKEND_URL);
  const { _queueId, _retries, ...payload } = transcript || {};
  const res = await fetchWithTimeout(
    `${clean}/api/v1/transcripts`,
    {
      method: "POST",
      headers: buildSecureHeaders(),
      body: JSON.stringify(payload),
    },
    SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Transcript save failed (${res.status})`);
  const d = await res.json();
  return d && d.data && !Array.isArray(d.data) ? d.data : d;
}

export async function flushPendingQueue(baseUrl) {
  const clean = normalizeAndValidateUrl(baseUrl, DEFAULT_BACKEND_URL);
  const pendingC = await getPendingContacts();
  const remC = [];
  let syncedC = 0;
  for (const item of pendingC) {
    try { await createContactRemote(clean, item); syncedC += 1; } catch { remC.push(item); }
  }
  await savePendingContacts(remC);

  const pendingT = await getPendingTranscripts();
  const remT = [];
  let syncedT = 0;
  for (const tx of pendingT) {
    try { await createTranscriptRemote(clean, tx); syncedT += 1; } catch { remT.push(tx); }
  }
  await savePendingTranscripts(remT);

  return { syncedContactsCount: syncedC, syncedTranscriptsCount: syncedT };
}