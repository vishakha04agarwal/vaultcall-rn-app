import {
  SECURITY_CONSTANTS,
  getBackendBaseUrl,
  buildSecureHeaders,
} from "../config/security";

// Debounce helper to avoid rapid repeated calls & UI lag
export function debounce(fn, waitMs = 300) {
  let timerId = null;
  return (...args) => {
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(() => {
      fn(...args);
    }, waitMs);
  };
}

// Fetch with timeout & AbortController so slow/dead network doesn't hang UI
export async function fetchWithTimeout(url, options = {}, timeoutMs = SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

export async function checkBackendHealth(authToken = "") {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      reason: "MISSING_BACKEND_URL",
      message: "EXPO_PUBLIC_API_URL set nahi hai.",
    };
  }

  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, {
      method: "GET",
      headers: buildSecureHeaders({}, authToken),
    }, 6000);

    return {
      ok: res.ok,
      status: res.status,
      message: res.ok ? "Backend connected" : `Backend error (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      message: err?.message || "Backend se connect nahi ho pa raha.",
    };
  }
}

export class OfflineSyncEngine {
  constructor({ readQueue, writeQueue, pushItem, onStateChange }) {
    this.readQueue = readQueue;
    this.writeQueue = writeQueue;
    this.pushItem = pushItem;
    this.onStateChange = onStateChange || (() => {});
    this.isSyncing = false;
    this.timer = null;
  }

  startAutoSync(intervalMs = SECURITY_CONSTANTS.SYNC_INTERVAL_MS) {
    this.stopAutoSync();
    this.timer = setInterval(() => {
      this.flushQueue().catch(() => {});
    }, intervalMs);
  }

  stopAutoSync() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async enqueue(action) {
    const queue = (await this.readQueue()) || [];
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      retries: 0,
      status: "pending",
      ...action,
    };
    queue.push(entry);
    await this.writeQueue(queue);
    this.onStateChange({ pendingCount: queue.length, isSyncing: this.isSyncing });

    // Try immediate background flush without blocking UI
    this.flushQueue().catch(() => {});
    return entry;
  }

  async flushQueue() {
    if (this.isSyncing) return;
    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) return;

    this.isSyncing = true;
    let queue = (await this.readQueue()) || [];
    this.onStateChange({ pendingCount: queue.length, isSyncing: true });

    const remaining = [];
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        await this.pushItem(baseUrl, item);
      } catch {
        const nextRetries = (item.retries || 0) + 1;
        if (nextRetries <= SECURITY_CONSTANTS.MAX_RETRY_ATTEMPTS) {
          remaining.push({ ...item, retries: nextRetries, status: "failed" });
        } else {
          remaining.push({ ...item, retries: nextRetries, status: "dead_letter" });
        }
      }
    }

    await this.writeQueue(remaining);
    this.isSyncing = false;
    this.onStateChange({ pendingCount: remaining.length, isSyncing: false });
  }
}