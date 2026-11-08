/**
 * Coordinates access to the MTP device between user-initiated (foreground)
 * calls and background work (folder size computation, recursive search).
 *
 * - Background calls run one at a time, and only while no foreground call is
 *   in flight. Background work lists one directory per call, so a foreground
 *   call waits for at most one directory listing.
 * - Foreground calls never wait for each other (preserving the existing
 *   behaviour) but always wait for an in-flight background call to finish, so
 *   the device is never driven concurrently by the two. There is deliberately
 *   no timeout: proceeding while a background call is still running would
 *   overlap device access. A call that never returns means the device itself
 *   is stuck, in which case the foreground call couldn't succeed either.
 * - While a foreground call is waiting, no new background call can start.
 */
class MtpAccessGate {
  constructor() {
    this.foregroundCount = 0;
    this.backgroundBusy = false;
    this.waiters = [];
  }

  _notify() {
    const { waiters } = this;

    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  _waitForChange() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async runForeground(fn) {
    this.foregroundCount += 1;

    try {
      while (this.backgroundBusy) {
        // eslint-disable-next-line no-await-in-loop
        await this._waitForChange();
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

    this.backgroundBusy = true;

    try {
      return await fn();
    } finally {
      this.backgroundBusy = false;
      this._notify();
    }
  }
}

export const mtpAccessGate = new MtpAccessGate();
