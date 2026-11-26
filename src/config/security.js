// Central security & backend configuration for VaultCall

const DEFAULT_TIMEOUT_MS = 12000;

export const SECURITY_CONSTANTS = Object.freeze({
  REQUEST_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 1000,
  SYNC_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes auto background sync
  PAGE_SIZE: 25,
  CACHE_TTL_MS: 2 * 60 * 1000,
  ALLOWED_PROTOCOLS: ["https:", "http:"],
});

export function getBackendBaseUrl() {
  const rawUrl =
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.API_BASE_URL ||
    "";

  const trimmed = String(rawUrl).trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!SECURITY_CONSTANTS.ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function buildSecureHeaders(extraHeaders = {}, authToken = "") {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Client-Platform": "vaultcall-rn-expo",
    ...extraHeaders,
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}