import {
  SECURITY_CONSTANTS,
  buildSecureHeaders,
  normalizeAndValidateUrl,
} from "../config/security";

export function debounce(fn, waitMs = 250) {
  let timerId = null;
  return (...args) => {
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(() => {
      fn(...args);
    }, waitMs);
  };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = SECURITY_CONSTANTS.REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timerId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, {
      ...options,
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

export async function checkBackendHealth(baseUrl, authToken = "") {
  const cleanUrl = normalizeAndValidateUrl(baseUrl, "");
  if (!cleanUrl) {
    return { ok: false, status: 0, message: "Invalid Backend URL" };
  }

  for (const healthPath of ["/health", "/api/v1/health"]) {
    try {
      const res = await fetchWithTimeout(
        `${cleanUrl}${healthPath}`,
        { method: "GET", headers: buildSecureHeaders({}, authToken) },
        SECURITY_CONSTANTS.HEALTH_TIMEOUT_MS
      );
      if (res.ok) {
        return { ok: true, status: res.status, message: "Backend Online" };
      }
      if (res.status !== 404) {
        return { ok: false, status: res.status, message: `Backend HTTP ${res.status}` };
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        return { ok: false, status: 0, message: "Backend Timeout (Waking up / Slow)" };
      }
    }
  }

  return { ok: false, status: 404, message: "Health endpoint not reachable" };
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

  async enqueue(item) {
    const queue = (await this.readQueue()) || [];
    const entry = {
      _queueId: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      _retries: 0,
      ...item,
    };
    const next = [entry, ...queue];
    await this.writeQueue(next);
    this.onStateChange({ pendingCount: next.length, isSyncing: this.isSyncing });
    return entry;
  }

  async flushQueue() {
    if (this.isSyncing) return { syncedCount: 0, remainingCount: ((await this.readQueue()) || []).length };
    this.isSyncing = true;
    const initialQueue = (await this.readQueue()) || [];
    this.onStateChange({ pendingCount: initialQueue.length, isSyncing: true });

    let syncedCount = 0;
    const remaining = [];

    for (const item of initialQueue) {
      try {
        await this.pushItem(item);
        syncedCount += 1;
      } catch {
        const nextRetries = (item._retries || 0) + 1;
        if (nextRetries <= SECURITY_CONSTANTS.MAX_RETRY_ATTEMPTS) {
          remaining.push({ ...item, _retries: nextRetries });
        }
      }
    }

    await this.writeQueue(remaining);
    this.isSyncing = false;
    this.onStateChange({ pendingCount: remaining.length, isSyncing: false });
    return { syncedCount, remainingCount: remaining.length };
  }
}