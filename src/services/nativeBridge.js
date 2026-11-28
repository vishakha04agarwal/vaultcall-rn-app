import { Linking, NativeModules, PermissionsAndroid, Platform } from "react-native";

const { VaultBridge } = NativeModules;

export function isNativeBridgeAvailable() {
  return Platform.OS === "android" && Boolean(VaultBridge);
}

export async function getNativeDiagnostics() {
  if (Platform.OS !== "android") {
    return { bridge: false, overlay: false, contactsPerm: false, callLogPerm: false, phoneStatePerm: false, reason: "Not Android" };
  }
  if (!VaultBridge) {
    return {
      bridge: false,
      overlay: false,
      contactsPerm: false,
      callLogPerm: false,
      phoneStatePerm: false,
      reason: "VaultBridge missing (prebuild/APK rebuild needed)",
    };
  }
  const contactsPerm = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CONTACTS);
  const callLogPerm = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CALL_LOG);
  const phoneStatePerm = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE);
  let overlay = false;
  try {
    overlay = typeof VaultBridge.canDrawOverlays === "function" ? Boolean(await VaultBridge.canDrawOverlays()) : false;
  } catch {
    overlay = false;
  }
  return { bridge: true, overlay, contactsPerm, callLogPerm, phoneStatePerm, reason: "OK" };
}

export async function requestCallAndContactsPermissions() {
  if (Platform.OS !== "android") return {};
  const perms = [
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ];
  if (Platform.Version >= 33 && PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) {
    perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  return await PermissionsAndroid.requestMultiple(perms.filter(Boolean));
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
  try {
    VaultBridge.syncExtraContacts(JSON.stringify(Array.isArray(contacts) ? contacts : []), Boolean(autoRecord));
    return true;
  } catch {
    return false;
  }
}

export function triggerNativeCallerPopup(number = "", name = "Unknown Caller", notes = "", sourceLabel = "VaultCall DB") {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.showNativePopup !== "function") return false;
  try {
    VaultBridge.showNativePopup(
      String(number || ""),
      String(name || "Unknown Caller"),
      String(notes || ""),
      String(sourceLabel || "VaultCall DB")
    );
    return true;
  } catch {
    return false;
  }
}

export function dismissNativeCallerPopup() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.dismissNativePopup !== "function") return false;
  try { VaultBridge.dismissNativePopup(); return true; } catch { return false; }
}

export async function fetchDevicePhoneContacts() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getPhoneContacts !== "function") {
    return { contacts: [], error: "VaultBridge.getPhoneContacts unavailable" };
  }
  try {
    const list = await VaultBridge.getPhoneContacts();
    return { contacts: Array.isArray(list) ? list : [], error: null };
  } catch (err) {
    return { contacts: [], error: err?.message || "Failed to read phone contacts" };
  }
}

export async function fetchInternalCallLogs() {
  if (!isNativeBridgeAvailable() || typeof VaultBridge.getInternalCallLogs !== "function") {
    return { logs: [], error: "VaultBridge.getInternalCallLogs unavailable" };
  }
  try {
    const list = await VaultBridge.getInternalCallLogs();
    return { logs: Array.isArray(list) ? list : [], error: null };
  } catch (err) {
    return { logs: [], error: err?.message || "Failed to read call logs" };
  }
}