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
  const res = await PermissionsAndroid.requestMultiple(perms);
  return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

export async function checkOverlayPermission() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.canDrawOverlays !== "function") {
    return false;
  }
  return VaultBridge.canDrawOverlays();
}

export function openOverlayPermissionSettings() {
  if (isNativeBridgeAvailable() && typeof VaultBridge.requestOverlayPermission === "function") {
    VaultBridge.requestOverlayPermission();
  }
}

export function syncVaultExtraContactsToNative(extraContacts = [], autoRecord = false) {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.syncExtraContacts !== "function") return;
  try {
    VaultBridge.syncExtraContacts(JSON.stringify(extraContacts || []), Boolean(autoRecord));
  } catch {}
}

export function triggerNativeCallerPopup(number = "", name = "Unknown Caller", notes = "", sourceLabel = "VaultCall") {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.showNativePopup !== "function") return false;
  VaultBridge.showNativePopup(
    String(number || ""),
    String(name || "Unknown Caller"),
    String(notes || ""),
    String(sourceLabel || "VaultCall")
  );
  return true;
}

export async function fetchDevicePhoneContacts() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getPhoneContacts !== "function") {
    return [];
  }
  const list = await VaultBridge.getPhoneContacts();
  return Array.isArray(list) ? list : [];
}

export async function fetchInternalCallLogs() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getInternalCallLogs !== "function") {
    return [];
  }
  const list = await VaultBridge.getInternalCallLogs();
  return Array.isArray(list) ? list : [];
}