const DEFAULT_TIMEOUT_MS = 12000;

export const SECURITY_CONSTANTS = Object.freeze({
  REQUEST_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS: 7000,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 1000,
  SYNC_INTERVAL_MS: 5 * 60 * 1000,
  PAGE_SIZE: 30,
  ALLOWED_PROTOCOLS: ["https:", "http:"],
});

export function normalizeAndValidateUrl(rawUrl, fallback = "https://vault-backend-t9nu.onrender.com") {
  const candidate = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!candidate || candidate.includes("localhost")) {
    return fallback;
  }
  try {
    const parsed = new URL(candidate);
    if (!SECURITY_CONSTANTS.ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return fallback;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function getEnvBackendUrl(fallback = "https://vault-backend-t9nu.onrender.com") {
  const envUrl =
    (typeof process !== "undefined" && process.env && (process.env.EXPO_PUBLIC_API_URL || process.env.API_BASE_URL)) ||
    "";
  return normalizeAndValidateUrl(envUrl, fallback);
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