import junk from 'junk';
import fileExplorerController from '../controllers/FileExplorerController';
import { folderSizeCache } from './folderSizeCache';
import { DEVICE_TYPE } from '../../../enums';
import { MTP_ERROR } from '../../../enums/mtpError';
import { PHOTOS_LIBRARY_PATTERN } from '../data-sources/FileExplorerLocalDataSource';
import { DeviceChangedError } from './DeviceChangedError';

export { DeviceChangedError };

export const SEARCH_MAX_RESULTS = 1000;

// number of directories listed in parallel by a single walk
const WALK_CONCURRENCY = {
  [DEVICE_TYPE.local]: 2,
  // MTP devices can only serve one request at a time
  [DEVICE_TYPE.mtp]: 1,
};

// Photos app libraries are internal databases protected by the Photos
// permission. Background work never goes inside them (search lists the
// library itself as a match; folder sizes show it as unavailable).
const isPhotosLibrary = (deviceType, name) =>
  deviceType === DEVICE_TYPE.local && PHOTOS_LIBRARY_PATTERN.test(name);

/**
 * A cancellation token shared by a background job and the code that started
 * it. Cancelling stops the walk before its next directory listing.
 */
export class CancelToken {
  constructor() {
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }
}

/**
 * Breadth-first walk of [rootPath]. [listDir] lists one directory and
 * [onDirectory] is called with each successfully listed directory's entries.
 * Symlinked directories are never descended into, nor are directories for
 * which the optional [shouldDescend] returns false.
 *
 * @throws {DeviceChangedError} if a listing reports that the phone changed
 * @return {Promise<{cancelled: boolean, rootFailed: boolean}>}
 */
const walkTree = async ({
  rootPath,
  listDir,
  onDirectory,
  token,
  concurrency,
  shouldDescend = () => true,
}) => {
  const queue = [rootPath];
  let head = 0;
  let active = 0;
  let rootFailed = false;
  let deviceChanged = false;
  let waiters = [];

  const notify = () => {
    const _waiters = waiters;

    waiters = [];
    _waiters.forEach((resolve) => resolve());
  };

  const waitForProgress = () =>
    new Promise((resolve) => {
      waiters.push(resolve);
    });

  const worker = async () => {
    for (;;) {
      if (token.cancelled || deviceChanged) {
        return;
      }

      if (head >= queue.length) {
        if (active === 0) {
          notify();

          return;
        }

        // another worker may still discover more directories
        // eslint-disable-next-line no-await-in-loop
        await waitForProgress();

        continue; // eslint-disable-line no-continue
      }

      const dir = queue[head];

      head += 1;

      // drop the consumed prefix now and then to keep memory flat
      if (head > 4096) {
        queue.splice(0, head);
        head = 0;
      }

      active += 1;

      try {
        // eslint-disable-next-line no-await-in-loop
        const { data, error, stderr } = await listDir(dir);

        // (local listings never carry a stderr)
        if (stderr && stderr === MTP_ERROR.ErrorDeviceChanged) {
          // stop every worker; reported to the caller below
          deviceChanged = true;
        } else if (error || !data) {
          if (dir === rootPath) {
            rootFailed = true;
          }
        } else if (!token.cancelled) {
          data.forEach((entry) => {
            if (entry.isFolder && !entry.symlink && shouldDescend(entry)) {
              queue.push(entry.path);
            }
          });

          // eslint-disable-next-line no-await-in-loop
          await onDirectory(dir, data);
        }
      } catch (e) {
        if (dir === rootPath) {
          rootFailed = true;
        }
      } finally {
        active -= 1;
        notify();
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (deviceChanged && !token.cancelled) {
    throw new DeviceChangedError();
  }

  return { cancelled: token.cancelled, rootFailed };
};

/**
 * description - Recursively compute the total size of all files inside
 * [folderPath], including hidden files.
 *
 * @param {string} deviceType
 * @param {number|null} storageId
 * @param {string} folderPath
 * @param {string} browsePath - the directory the user is currently browsing
 * @param {CancelToken} token
 * @throws {DeviceChangedError}
 * @return {Promise<number|null|undefined>} size in bytes; null if the folder
 * couldn't be read (or is a Photos library); undefined if cancelled.
 */
export const computeFolderSize = async ({
  deviceType,
  storageId,
  folderPath,
  browsePath,
  token,
}) => {
  const cacheArgs = { deviceType, storageId, filePath: folderPath };
  const cached = folderSizeCache.get(cacheArgs);

  if (cached !== undefined) {
    return cached;
  }

  if (isPhotosLibrary(deviceType, folderPath.split('/').pop())) {
    return null;
  }

  const generation = folderSizeCache.generation(deviceType);
  let total = 0;

  const { cancelled, rootFailed } = await walkTree({
    rootPath: folderPath,
    token,
    concurrency: WALK_CONCURRENCY[deviceType],
    shouldDescend: (entry) => !isPhotosLibrary(deviceType, entry.name),
    listDir: (dir) =>
      fileExplorerController.listFilesInBackground({
        deviceType,
        filePath: dir,
        ignoreHidden: false,
        storageId,
        walkRoot: browsePath,
      }),
    onDirectory: (_, entries) => {
      entries.forEach((entry) => {
        if (!entry.isFolder) {
          total += Number(entry.size) || 0;
        }
      });
    },
  });

  if (cancelled) {
    return undefined;
  }

  if (rootFailed) {
    return null;
  }

  folderSizeCache.set(cacheArgs, total, generation);

  return total;
};

/**
 * description - Recursively search [rootPath] for files and folders whose name
 * contains [query] (case-insensitive). Results are streamed through
 * [onResults] in batches.
 *
 * @throws {DeviceChangedError}
 * @return {Promise<{cancelled: boolean, truncated: boolean, rootFailed: boolean}>}
 */
export const searchFiles = async ({
  deviceType,
  storageId,
  rootPath,
  query,
  ignoreHidden,
  token,
  onResults,
  maxResults = SEARCH_MAX_RESULTS,
}) => {
  const needle = query.trim().toLowerCase();
  let found = 0;
  // stop the walk once enough results were found
  const walkToken = {
    get cancelled() {
      return token.cancelled || found >= maxResults;
    },
  };

  const { rootFailed } = await walkTree({
    rootPath,
    token: walkToken,
    concurrency: WALK_CONCURRENCY[deviceType],
    shouldDescend: (entry) => !isPhotosLibrary(deviceType, entry.name),
    listDir: (dir) =>
      fileExplorerController.listFilesInBackground({
        deviceType,
        filePath: dir,
        ignoreHidden,
        storageId,
        walkRoot: rootPath,
        allowPermissionPrompt: true,
      }),
    onDirectory: async (_, entries) => {
      const matches = entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(needle) &&
          (deviceType !== DEVICE_TYPE.local || junk.not(entry.name))
      );

      if (matches.length < 1 || walkToken.cancelled) {
        return;
      }

      // Reserve result slots synchronously, before any await, so concurrent
      // workers can't each see the same free slots and exceed [maxResults].
      const reserved = Math.min(matches.length, maxResults - found);

      if (reserved < 1) {
        return;
      }

      found += reserved;

      let nodes = matches.slice(0, reserved);

      if (deviceType === DEVICE_TYPE.local) {
        // background listings are minimal; build full nodes for display
        nodes = (
          await Promise.all(
            nodes.map((entry) =>
              fileExplorerController.buildLocalNode({ fullPath: entry.path })
            )
          )
        ).filter(Boolean);
      }

      if (token.cancelled) {
        return;
      }

      // release the slots of entries that disappeared before being read
      found -= reserved - nodes.length;
      onResults(nodes);
    },
  });

  return {
    cancelled: token.cancelled,
    truncated: !token.cancelled && found >= maxResults,
    rootFailed,
  };
};
