import { NativeModules, PermissionsAndroid, Platform } from "react-native";

const { VaultBridge } = NativeModules;

export function isNativeBridgeAvailable() {
  return Platform.OS === "android" && Boolean(VaultBridge);
}

export async function requestCallAndContactsPermissions() {
  if (Platform.OS !== "android") return false;
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
  if (!isNativeBridgeAvailable() || typeof VaultBridge.requestOverlayPermission !== "function") return false;
  try { VaultBridge.requestOverlayPermission(); return true; } catch { return false; }
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
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getPhoneContacts !== "function") return [];
  try { const list = await VaultBridge.getPhoneContacts(); return Array.isArray(list) ? list : []; } catch { return []; }
}

export async function fetchInternalCallLogs() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getInternalCallLogs !== "function") return [];
  try { const list = await VaultBridge.getInternalCallLogs(); return Array.isArray(list) ? list : []; } catch { return []; }
}