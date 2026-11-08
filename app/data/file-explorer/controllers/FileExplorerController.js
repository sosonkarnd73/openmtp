import { FileExplorerRepository } from '../repositories/FileExplorerRepository';
import { checkIf } from '../../../utils/checkIf';
import { analyticsService } from '../../../services/analytics';
import { EVENT_TYPE } from '../../../enums/events';
import {
  processLocalBuffer,
  processMtpBuffer,
} from '../../../helpers/processBufferOutput';
import { getMtpModeSetting } from '../../../helpers/settings';
import { DEVICE_TYPE } from '../../../enums';
import { unixTimestampNow } from '../../../utils/date';
import { mtpAccessGate } from '../../../utils/mtpAccessGate';
import { folderSizeCache } from '../services/folderSizeCache';

class FileExplorerController {
  constructor() {
    this.repository = new FileExplorerRepository();
  }

  /**
   * MTP calls go through [mtpAccessGate] so that background work (folder
   * sizes, recursive search) never drives the device concurrently with
   * user-initiated actions.
   */
  _foreground(deviceType, fn) {
    if (deviceType === DEVICE_TYPE.mtp) {
      return mtpAccessGate.runForeground(fn);
    }

    return fn();
  }

  async _sentEvent({ result, deviceType, eventKey, attachData = false }) {
    checkIf(eventKey, 'string');
    checkIf(attachData, 'boolean');
    checkIf(deviceType, 'inObjectValues', DEVICE_TYPE);

    // events related to local disk actions
    if (deviceType === DEVICE_TYPE.local) {
      const { error: localError } = await processLocalBuffer({
        error: result?.error,
        stderr: result?.stderr,
      });

      if (localError) {
        const _eventKey = `${EVENT_TYPE[`LOCAL_${eventKey}_ERROR`]}`;

        // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
        if (!_eventKey) {
          return;
        }

        // send out an error event
        await analyticsService.sendEvent(_eventKey, {
          time: unixTimestampNow(),
          stderr: result?.stderr,
          error: result?.error,
        });

        return;
      }

      const _eventKey = `${EVENT_TYPE[`LOCAL_${eventKey}_SUCCESS`]}`;

      // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
      if (!_eventKey) {
        return;
      }

      // send a success event
      let data = {};

      if (attachData) {
        data = {
          data: result?.data,
        };
      }

      await analyticsService.sendEvent(_eventKey, {
        time: unixTimestampNow(),
        ...data,
      });

      return;
    }

    // events related to mtp actions
    const mtpMode = getMtpModeSetting();
    const { mtpStatus, error: mtpError } = await processMtpBuffer({
      error: result?.error,
      stderr: result?.stderr,
      mtpMode,
    });

    if (mtpError) {
      const _eventKey = `${EVENT_TYPE[`MTP_${eventKey}_ERROR`]}`;

      // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
      if (!_eventKey) {
        return;
      }

      // send out an error event
      await analyticsService.sendEvent(_eventKey, {
        time: unixTimestampNow(),
        'MTP Status': mtpStatus,
        'MTP Mode': mtpMode,
        stderr: result?.stderr,
        error: result?.error,
      });

      return;
    }

    const _eventKey = `${EVENT_TYPE[`MTP_${eventKey}_SUCCESS`]}`;

    // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
    if (!_eventKey) {
      return;
    }

    // send a success event
    let data = {};

    if (attachData) {
      data = {
        data: result?.data,
      };
    }

    await analyticsService.sendEvent(_eventKey, {
      time: unixTimestampNow(),
      'MTP Status': mtpStatus,
      'MTP Mode': mtpMode,
      ...data,
    });
  }

  /**
   * description - Initialize
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  async initialize({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.initialize({ deviceType })
    );

    this._sentEvent({ result, deviceType, eventKey: 'INITIALIZE' });

    return result;
  }

  /**
   * description - Dispose
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  async dispose({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.dispose({ deviceType })
    );

    this._sentEvent({ result, deviceType, eventKey: 'DISPOSE' });

    return result;
  }

  /**
   * description - Fetch storages
   *
   * @return {Promise<{data: object|boolean, error: string|null, stderr: string|null}>}
   */
  async listStorages({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.listStorages({ deviceType })
    );

    this._sentEvent({
      result,
      deviceType,
      eventKey: 'LIST_STORAGES',
      attachData: true,
    });

    return result;
  }

  /**
   * description - Fetch files in the path
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} ignoreHidden
   * @param {string} storageId
   * @return {Promise<{data: array|null, error: string|null, stderr: string|null}>}
   */
  async listFiles({ deviceType, filePath, ignoreHidden, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');

    const result = await this._foreground(deviceType, () =>
      this.repository.listFiles({
        deviceType,
        filePath,
        ignoreHidden,
        storageId,
      })
    );

    this._sentEvent({ result, deviceType, eventKey: 'LIST_FILES' });

    return result;
  }

  /**
   * description - Rename a file
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} newFilename
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async renameFile({ deviceType, filePath, newFilename, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');
    checkIf(newFilename, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.renameFile({
        deviceType,
        filePath,
        newFilename,
        storageId,
      })
    );

    folderSizeCache.invalidate(deviceType);

    this._sentEvent({ result, deviceType, eventKey: 'RENAME_FILE' });

    return result;
  }

  /**
   * description - Delete files
   *
   * @param {string} deviceType
   * @param {[string]} fileList
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async deleteFiles({ deviceType, fileList, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(fileList, 'array');

    const result = await this._foreground(deviceType, () =>
      this.repository.deleteFiles({
        deviceType,
        fileList,
        storageId,
      })
    );

    folderSizeCache.invalidate(deviceType);

    this._sentEvent({ result, deviceType, eventKey: 'DELETE_FILE' });

    return result;
  }

  /**
   * description - Create a directory
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async makeDirectory({ deviceType, filePath, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.makeDirectory({
        deviceType,
        filePath,
        storageId,
      })
    );

    folderSizeCache.invalidate(deviceType);

    this._sentEvent({ result, deviceType, eventKey: 'NEW_FOLDER' });

    return result;
  }

  /**
   * description - Check if files exist
   *
   * @param {string} deviceType
   * @param {[string]} fileList
   * @param {string} storageId
   * @return {Promise<boolean>}
   */
  async filesExist({ deviceType, fileList, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(fileList, 'array');

    const result = await this._foreground(deviceType, () =>
      this.repository.filesExist({
        deviceType,
        fileList,
        storageId,
      })
    );

    this._sentEvent({ result, deviceType, eventKey: 'FILES_EXIST' });

    return result;
  }

  /**
   * description - Upload or download files from MTP device to local or vice versa
   *
   * @param {string} deviceType
   * @param {string} destination
   * @param {'upload'|'download'} direction
   * @param {[string]} fileList
   * @param {string} storageId
   * @param {errorCallback} onError
   * @param {preprocessCallback} onPreprocess
   * @param {progressCallback} onProgress
   * @param {completedCallback} onCompleted
   *
   * @return
   */
  transferFiles = async ({
    deviceType,
    destination,
    fileList,
    direction,
    storageId,
    onError,
    onPreprocess,
    onProgress,
    onCompleted,
  }) => {
    checkIf(deviceType, 'string');
    checkIf(destination, 'string');
    checkIf(direction, 'string');
    checkIf(fileList, 'array');
    checkIf(onError, 'function');
    checkIf(onPreprocess, 'function');
    checkIf(onProgress, 'function');
    checkIf(onCompleted, 'function');

    // A transfer changes the contents of both sides. The data sources call
    // [onCompleted]/[onError] *before* the returned promise resolves, and the
    // UI re-lists the destination from those callbacks, so the folder size
    // cache has to be invalidated inside them, not only after the await.
    let callbackFired = false;
    const invalidateFolderSizes = () => {
      folderSizeCache.invalidate(DEVICE_TYPE.local);
      folderSizeCache.invalidate(DEVICE_TYPE.mtp);
    };

    invalidateFolderSizes();

    const result = await this._foreground(deviceType, () =>
      this.repository.transferFiles({
        deviceType,
        destination,
        fileList,
        direction,
        storageId,
        onError: (...args) => {
          // a failed transfer may still have copied some of the files
          callbackFired = true;
          invalidateFolderSizes();

          return onError(...args);
        },
        onProgress,
        onCompleted: (...args) => {
          callbackFired = true;
          invalidateFolderSizes();

          return onCompleted(...args);
        },
        onPreprocess,
      })
    );

    // Some failures resolve without calling either callback. Otherwise don't
    // invalidate again: that would discard the fresh sizes the post-transfer
    // listing (started from the callback) is computing right now.
    if (!callbackFired) {
      invalidateFolderSizes();
    }

    this._sentEvent({ result, deviceType, eventKey: 'TRANSFER_FILES' });

    return result;
  };

  /**
   * description - List a single directory for background work (folder sizes,
   * recursive search). No analytics, no alerts; MTP calls yield to any
   * user-initiated MTP call.
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {boolean} ignoreHidden
   * @param {number|null} storageId
   * @param {string} walkRoot
   * @param {boolean} allowPermissionPrompt
   * @return {Promise<{data: array|null, error: *}>}
   */
  listFilesInBackground({
    deviceType,
    filePath,
    ignoreHidden,
    storageId,
    walkRoot,
    allowPermissionPrompt = false,
  }) {
    checkIf(deviceType, 'inObjectValues', DEVICE_TYPE);
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');

    const run = () =>
      this.repository.listFilesInBackground({
        deviceType,
        filePath,
        ignoreHidden,
        storageId,
        walkRoot,
        allowPermissionPrompt,
      });

    if (deviceType === DEVICE_TYPE.mtp) {
      return mtpAccessGate.runBackground(run);
    }

    return run();
  }

  /**
   * description - Build a full local file explorer node for a path
   *
   * @param {string} fullPath
   * @return {Promise<object|null>}
   */
  buildLocalNode({ fullPath }) {
    return this.repository.buildLocalNode({ fullPath });
  }

  /**
   * description: fetch the data for generating bug/error reports
   *
   * @param {string} deviceType
   * @return {Promise<{data: string|null, error: string|null, stderr: string|null}>}
   */
  async fetchDebugReport({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this._foreground(deviceType, () =>
      this.repository.fetchDebugReport({ deviceType })
    );

    this._sentEvent({ result, deviceType, eventKey: 'FETCH_DEBUG_REPORT' });

    return result;
  }
}

const fileExplorerController = new FileExplorerController();

export default fileExplorerController;
