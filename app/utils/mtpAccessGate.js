/**
 * Coordinates access to the MTP device between user-initiated (foreground)
 * calls and background work (folder size computation, recursive search).
 *
 * - Background calls run one at a time, and only while no foreground call is
 *   in flight. Background work lists one directory per call, so a foreground
 *   call waits for at most one directory listing.
 * - Foreground calls never wait for each other (preserving the existing
 *   behaviour) but do wait for an in-flight background call to finish so the
 *   device is never driven concurrently by the two.
 * - That wait is capped, measured from when the background call started, so a
 *   hung background call can never block the UI for long.
 */
const BACKGROUND_CALL_MAX_WAIT_MS = 20000;

class MtpAccessGate {
  constructor() {
    this.foregroundCount = 0;
    this.backgroundStartedAt = null;
    this.waiters = [];
  }

  get backgroundBusy() {
    return this.backgroundStartedAt !== null;
  }

  _notify() {
    const { waiters } = this;

    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  _waitForChange(timeoutMs = null) {
    return new Promise((resolve) => {
      this.waiters.push(resolve);

      if (timeoutMs !== null) {
        setTimeout(resolve, Math.max(0, timeoutMs));
      }
    });
  }

  async runForeground(fn) {
    this.foregroundCount += 1;

    try {
      while (this.backgroundBusy) {
        const remaining =
          this.backgroundStartedAt + BACKGROUND_CALL_MAX_WAIT_MS - Date.now();

        if (remaining <= 0) {
          break;
        }

        // eslint-disable-next-line no-await-in-loop
        await this._waitForChange(remaining);
      }

      return await fn();
    } finally {
      this.foregroundCount -= 1;
      this._notify();
    }
  }

  async runBackground(fn) {
    while (this.foregroundCount > 0 || this.backgroundBusy) {
      // eslint-disable-next-line no-await-in-loop
      await this._waitForChange();
    }

    this.backgroundStartedAt = Date.now();

    try {
      return await fn();
    } finally {
      this.backgroundStartedAt = null;
      this._notify();
    }
  }
}

export const mtpAccessGate = new MtpAccessGate();
