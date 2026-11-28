import { Linking, NativeModules, PermissionsAndroid, Platform } from "react-native";
import * as Contacts from "expo-contacts";

const { VaultBridge } = NativeModules;

export function isNativeBridgeAvailable() {
  return Platform.OS === "android" && Boolean(VaultBridge);
}

export async function requestCallAndContactsPermissions() {
  if (Platform.OS !== "android") return false;
  try {
    await Contacts.requestPermissionsAsync();
  } catch {}
  const perms = [
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ];
  if (Platform.Version >= 33 && PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) {
    perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  const res = await PermissionsAndroid.requestMultiple(perms.filter(Boolean));
  return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

export async function checkOverlayPermission() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.canDrawOverlays !== "function") return false;
  try { return Boolean(await VaultBridge.canDrawOverlays()); } catch { return false; }
}

export function openOverlayPermissionSettings() {
  if (isNativeBridgeAvailable() && typeof VaultBridge.requestOverlayPermission === "function") {
    try { VaultBridge.requestOverlayPermission(); return true; } catch {}
  }
  Linking.openSettings().catch(() => {});
  return false;
}

export function openPhoneAppDetailsSettings() {
  if (isNativeBridgeAvailable() && typeof VaultBridge.openAppSettings === "function") {
    try { VaultBridge.openAppSettings(); return true; } catch {}
  }
  Linking.openSettings().catch(() => {});
  return true;
}

export function syncVaultExtraContactsToNative(contacts = [], autoRecord = false) {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.syncExtraContacts !== "function") return false;
  try { VaultBridge.syncExtraContacts(JSON.stringify(Array.isArray(contacts) ? contacts : []), Boolean(autoRecord)); return true; }
  catch { return false; }
}

export function triggerNativeCallerPopup(number = "", name = "Unknown Caller", notes = "", sourceLabel = "VaultCall DB") {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.showNativePopup !== "function") return false;
  try { VaultBridge.showNativePopup(String(number || ""), String(name || "Unknown Caller"), String(notes || ""), String(sourceLabel || "VaultCall DB")); return true; }
  catch { return false; }
}

export function dismissNativeCallerPopup() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.dismissNativePopup !== "function") return false;
  try { VaultBridge.dismissNativePopup(); return true; } catch { return false; }
}

export async function fetchDevicePhoneContacts() {
  if (isNativeBridgeAvailable() && typeof VaultBridge.getPhoneContacts === "function") {
    try {
      const list = await VaultBridge.getPhoneContacts();
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {}
  }
  try {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== "granted") return [];
    const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
    const out = [];
    const seen = new Set();
    for (const c of data || []) {
      const name = (c?.name || "").trim();
      for (const p of c?.phoneNumbers || []) {
        const phone = (p?.number || "").trim();
        const key = `${name}|${phone}`;
        if (phone && !seen.has(key)) {
          seen.add(key);
          out.push({ name: name || phone, phone });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchInternalCallLogs() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getInternalCallLogs !== "function") return [];
  try { const list = await VaultBridge.getInternalCallLogs(); return Array.isArray(list) ? list : []; } catch { return []; }
}