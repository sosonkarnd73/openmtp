import { MTP_ERROR } from '../../../enums/mtpError';

/**
 * Thrown by background walks when Kalam reports that a different phone is now
 * connected. Kalam reports this only once (it records the new device as it
 * does), so the caller must re-initialize MTP exactly like a user-initiated
 * call would; otherwise the app keeps using the previous phone's storages.
 */
export class DeviceChangedError extends Error {
  constructor() {
    super(MTP_ERROR.ErrorDeviceChanged);
    this.name = 'DeviceChangedError';
  }
}
