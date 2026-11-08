import path from 'path';
import { promisify } from 'node:util';
import junk from 'junk';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import macosVersion from 'macos-version';
import {
  readdir as fsReaddir,
  existsSync,
  statSync,
  lstatSync,
  rename as fsRename,
  readlink,
  realpathSync,
  promises as fsPromises,
} from 'fs';
import findLodash from 'lodash/find';
import { log } from '../../../utils/log';
import { isArray, isEmpty, undefinedOrNull } from '../../../utils/funcs';
import { pathUp } from '../../../utils/files';
import { appDateFormat } from '../../../utils/date';
import { checkIf } from '../../../utils/checkIf';
import { PATHS } from '../../../constants/paths';
import { NODE_MAC_PERMISSIONS_MIN_OS } from '../../../constants';

// macOS asks the user for permission the first time an app reads these folders.
// ~/Pictures is deliberately not listed: reading it needs no permission. Only
// the Photos app library inside it is protected (see PHOTOS_LIBRARY_PATTERN),
// and requesting Photos access opens System Settings whenever macOS reports it
// as denied, so background work must never request it.
const TCC_PROTECTED_ROOTS = [
  PATHS.desktopDir,
  PATHS.downloadsDir,
  PATHS.documentsDir,
];

// Photos app libraries: internal databases, protected by the Photos permission.
export const PHOTOS_LIBRARY_PATTERN = /\.photoslibrary$/i;

// Reading these in the background either triggers a macOS permission prompt
// ("access data from other apps", iCloud/cloud storage, network/removable
// volumes) or is extremely expensive, so background walks never enter them.
const BACKGROUND_SKIP_LIBRARY_DIRS = [
  'Containers',
  'Group Containers',
  'Mobile Documents',
  'CloudStorage',
];
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BACKGROUND_SKIP_PATTERNS = [
  new RegExp(
    `^/Users/[^/]+/Library/(${BACKGROUND_SKIP_LIBRARY_DIRS.join('|')})(/|$)`
  ),
  // the current user's home may live outside /Users
  new RegExp(
    `^${escapeRegExp(
      PATHS.homeDir
    )}/Library/(${BACKGROUND_SKIP_LIBRARY_DIRS.join('|')})(/|$)`
  ),
  /^\/(net|Network|dev)(\/|$)/,
];

// Max number of concurrent fs calls a single background walk issues. Kept low
// so foreground directory listings are not starved of libuv threadpool slots.
const BACKGROUND_FS_CONCURRENCY = 3;

const normalizeFirmlinkPath = (filePath) =>
  filePath.replace(/^\/System\/Volumes\/Data(?=\/)/, '');

const isPathWithin = (filePath, root) =>
  filePath === root || filePath.startsWith(`${root}${path.sep}`);

// '/Volumes/USB/foo' -> '/Volumes/USB'; '/Volumes' -> '/Volumes'; else null
const volumeOf = (filePath) => {
  const match = filePath.match(/^\/Volumes(\/[^/]+)?/);

  return match ? match[0] : null;
};

export class FileExplorerLocalDataSource {
  constructor() {
    this.readdir = promisify(fsReaddir);

    // protected roots the user granted access to during this session
    this.grantedProtectedRoots = new Set();
    this.tccNotApplicable = false;

    // background permission requests, so each protected root is asked about
    // at most once per session (even if denied): root -> Promise<boolean>
    this.backgroundPermissionRequests = new Map();
  }

  /**
   * description - request access to a protected root on behalf of a
   * background search, at most once per session per root
   *
   * @param {string} protectedRoot
   * @return {Promise<boolean>}
   */
  _requestUsageAccessOnce(protectedRoot) {
    if (!this.backgroundPermissionRequests.has(protectedRoot)) {
      this.backgroundPermissionRequests.set(
        protectedRoot,
        this._requestUsageAccess({ filePath: protectedRoot }).catch(() => false)
      );
    }

    return this.backgroundPermissionRequests.get(protectedRoot);
  }

  _protectedRootOf(filePath) {
    const normalized = normalizeFirmlinkPath(filePath);

    return TCC_PROTECTED_ROOTS.find((root) => isPathWithin(normalized, root));
  }

  /**
   * description - whether a background walk (folder size / search) may read
   * [filePath] without triggering a macOS permission prompt.
   *
   * @param {string} filePath
   * @param {string} walkRoot - the directory the walk started from
   * @return {boolean}
   */
  isSafeForBackgroundAccess({ filePath, walkRoot }) {
    const normalized = normalizeFirmlinkPath(filePath);

    if (BACKGROUND_SKIP_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    // Reading a mounted volume may trigger the "removable volume" prompt, so
    // only enter a volume if the user is already browsing inside that volume.
    const volume = volumeOf(normalized);

    if (volume && volume !== volumeOf(normalizeFirmlinkPath(walkRoot))) {
      return false;
    }

    if (this.tccNotApplicable) {
      return true;
    }

    const protectedRoot = this._protectedRootOf(filePath);

    return !protectedRoot || this.grantedProtectedRoots.has(protectedRoot);
  }

  /**
   * description - Lightweight directory listing used by background walks.
   * Does not follow symlinks. Never triggers a permission prompt unless
   * [allowPermissionPrompt] is set (used by user-initiated search), in which
   * case macOS may ask once per session for Desktop/Documents/Downloads.
   *
   * @param {string} filePath
   * @param {string} walkRoot
   * @param {boolean} allowPermissionPrompt
   * @return {Promise<{data: [{name: string, path: string, isFolder: boolean, size: number}]|null, error: *}>}
   */
  async listEntriesInBackground({
    filePath,
    walkRoot,
    allowPermissionPrompt = false,
  }) {
    if (!this.isSafeForBackgroundAccess({ filePath, walkRoot })) {
      const protectedRoot = this._protectedRootOf(filePath);
      const canPrompt =
        allowPermissionPrompt &&
        protectedRoot &&
        !BACKGROUND_SKIP_PATTERNS.some((pattern) =>
          pattern.test(normalizeFirmlinkPath(filePath))
        );

      if (!canPrompt) {
        return { data: null, error: 'skipped' };
      }

      const granted = await this._requestUsageAccessOnce(protectedRoot);

      if (!granted) {
        return { data: null, error: 'Permission denied' };
      }
    }

    let dirents;

    try {
      dirents = await fsPromises.readdir(filePath, { withFileTypes: true });
    } catch (e) {
      return { data: null, error: e };
    }

    const entries = new Array(dirents.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < dirents.length) {
        const index = cursor;

        cursor += 1;

        const dirent = dirents[index];
        const fullPath = path.join(filePath, dirent.name);
        const isFolder = dirent.isDirectory();
        let size = 0;

        if (dirent.isFile()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            ({ size } = await fsPromises.lstat(fullPath));
          } catch (e) {
            size = 0;
          }
        }

        entries[index] = {
          name: dirent.name,
          path: fullPath,
          isFolder,
          size,
        };
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(BACKGROUND_FS_CONCURRENCY, dirents.length) },
        worker
      )
    );

    return { data: entries, error: null };
  }

  /**
   * description - Build a full file explorer node (same shape as [listFiles])
   * for a single path. Used for search results.
   *
   * @param {string} fullPath
   * @return {Promise<object|null>}
   */
  async buildNode({ fullPath }) {
    try {
      const lstat = await fsPromises.lstat(fullPath);
      let isFolder = lstat.isDirectory();
      let symlink = null;

      if (lstat.isSymbolicLink()) {
        try {
          symlink = await fsPromises.realpath(fullPath);
          isFolder = (await fsPromises.stat(symlink)).isDirectory();
        } catch (e) {
          symlink = null;
        }
      }

      return {
        name: path.basename(fullPath),
        path: fullPath,
        extension: path.extname(fullPath),
        size: lstat.size,
        isFolder,
        dateAdded: appDateFormat(lstat.atime),
        symlink,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * description - make directory helper
   *
   */
  async _mkdir({ filePath }) {
    try {
      return new Promise((resolve) => {
        mkdirp(filePath)
          .then((data) => {
            resolve({ data, stderr: null, error: null });

            return data;
          })
          .catch((error) => {
            resolve({ data: null, stderr: error, error });
          });
      });
    } catch (e) {
      log.error(e);
    }
  }

  /**
   * description - Rename file helper
   *
   */
  _rename({ filePath, newFilename }) {
    try {
      const parentDir = pathUp(filePath);
      const newFilePath = path.join(parentDir, newFilename);

      return new Promise((resolve) => {
        fsRename(filePath, newFilePath, (error) => {
          return resolve({
            data: null,
            stderr: error,
            error,
          });
        });
      });
    } catch (e) {
      log.error(e);

      return {
        data: null,
        stderr: null,
        error: e,
      };
    }
  }

  /**
   * description - Delete file helper
   *
   */
  _delete = (file) => {
    try {
      return new Promise((resolve) => {
        rimraf(file, {}, (error) => {
          resolve({
            data: null,
            stderr: error,
            error,
          });
        });
      });
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  };

  /**
   * description - request the usage access of the protected directories in macos
   * @private
   *
   * @param filePath {string}
   * @return {Promise<boolean>}
   */
  _requestUsageAccess = async ({ filePath }) => {
    const doesCurrentOsSupportNodeMacPermission =
      macosVersion.isGreaterThanOrEqualTo(NODE_MAC_PERMISSIONS_MIN_OS);

    if (!doesCurrentOsSupportNodeMacPermission) {
      this.tccNotApplicable = true;

      return true;
    }

    const { askForFoldersAccess, askForPhotosAccess } = await import(
      // eslint-disable-next-line import/no-unresolved
      'node-mac-permissions'
    );

    checkIf(filePath, 'string');

    const isGrantedString = 'authorized';

    let result;

    if (filePath.startsWith(PATHS.desktopDir)) {
      result = await askForFoldersAccess('desktop');
    } else if (filePath.startsWith(PATHS.downloadsDir)) {
      result = await askForFoldersAccess('downloads');
    } else if (filePath.startsWith(PATHS.documentsDir)) {
      result = await askForFoldersAccess('documents');
    } else if (filePath.startsWith(PATHS.picturesDir)) {
      result = await askForPhotosAccess();
    }

    if (undefinedOrNull(result)) {
      return true;
    }

    const isGranted = result === isGrantedString;
    const protectedRoot = this._protectedRootOf(filePath);

    if (isGranted && protectedRoot) {
      this.grantedProtectedRoots.add(protectedRoot);
    }

    return isGranted;
  };

  /**
   *
   * description - returns file info needed for navigating through symlinks
   * @private
   *
   * @param fullPath
   * @returns {Promise<{isFolder: boolean, symlink: string|null}>}
   * @private
   */
  _getSymlinkInfo = async ({ fullPath }) => {
    const symlink = await new Promise((resolve) => {
      try {
        readlink(fullPath, (err, lnk) => {
          if (err) {
            return resolve(null);
          }

          if (!undefinedOrNull(lnk) && existsSync(lnk)) {
            return resolve(realpathSync(lnk));
          }

          return resolve(null);
        });
      } catch (e) {
        return resolve(null);
      }
    });

    const isFolder = lstatSync(symlink ?? fullPath).isDirectory();

    return {
      isFolder,
      symlink,
    };
  };

  /**
   * description - Fetch local files in the path
   *
   * @param filePath
   * @param ignoreHidden
   * @return {Promise<{data: array|null, error: string|null, stderr: string|null}>}
   */
  async listFiles({ filePath, ignoreHidden }) {
    try {
      const _accessGranted = await this._requestUsageAccess({ filePath });

      if (!_accessGranted) {
        return {
          data: null,
          error: 'Permission denied',
        };
      }

      const response = [];
      const { error, data } = await this.readdir(filePath, 'utf8')
        .then((res) => {
          return {
            data: res,
            error: null,
          };
        })
        .catch((e) => {
          return {
            data: null,
            error: e,
          };
        });

      if (error) {
        log.error(error, `FileExplorerLocalDataSource.listFiles`);

        return { error, data: null };
      }

      let files = data;

      files = data.filter(junk.not);
      if (ignoreHidden) {
        // eslint-disable-next-line no-useless-escape
        files = data.filter((item) => !/(^|\/)\.[^\/\.]/g.test(item));
      }

      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];

        const fullPath = path.resolve(filePath, file);

        // eslint-disable-next-line no-await-in-loop
        const { isFolder, symlink } = await this._getSymlinkInfo({
          fullPath,
        });

        if (!existsSync(fullPath)) {
          continue; // eslint-disable-line no-continue
        }

        const stat = statSync(fullPath);
        const extension = path.extname(fullPath);
        const { size, atime: dateTime } = stat;

        if (findLodash(response, { path: fullPath })) {
          continue; // eslint-disable-line no-continue
        }

        response.push({
          name: file,
          path: fullPath,
          extension,
          size,
          isFolder,
          dateAdded: appDateFormat(dateTime),
          symlink,
        });
      }

      return { error, data: response };
    } catch (e) {
      log.error(e);

      return { error: e, data: null };
    }
  }

  /**
   * description - Rename a local file
   *
   * @param filePath
   * @param newFilename
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async renameFile({ filePath, newFilename }) {
    try {
      if (undefinedOrNull(filePath) || undefinedOrNull(newFilename)) {
        return { error: `No files selected.`, stderr: null, data: null };
      }

      const _accessGranted = await this._requestUsageAccess({ filePath });

      if (!_accessGranted) {
        return {
          data: null,
          error: 'Permission denied',
        };
      }

      const { error } = await this._rename({ filePath, newFilename });

      if (error) {
        log.error(
          `${error}`,
          `FileExplorerLocalDataSource.renameFile -> mv error`
        );

        return { error, stderr: null, data: false };
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  }

  /**
   * description - Delete a local file
   *
   * @param fileList
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async deleteFiles({ fileList }) {
    try {
      if (!fileList || fileList.length < 1) {
        return { error: `No files selected.`, stderr: null, data: null };
      }

      for (let i = 0; i < fileList.length; i += 1) {
        const filePath = fileList[i];

        // eslint-disable-next-line no-await-in-loop
        const _accessGranted = await this._requestUsageAccess({ filePath });

        if (!_accessGranted) {
          return {
            data: null,
            error: 'Permission denied',
          };
        }

        // eslint-disable-next-line no-await-in-loop
        const { error } = await this._delete(filePath);

        if (error) {
          log.error(
            `${error}`,
            `FileExplorerLocalDataSource.deleteFiles -> rm error`
          );

          return { error, stderr: null, data: false };
        }
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  }

  /**
   * description - Create a local directory
   *
   * @param {string} filePath
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async makeDirectory({ filePath }) {
    try {
      if (undefinedOrNull(filePath)) {
        return { error: `Invalid path.`, stderr: null, data: null };
      }

      // eslint-disable-next-line no-await-in-loop
      const _accessGranted = await this._requestUsageAccess({
        filePath,
      });

      if (!_accessGranted) {
        return {
          data: null,
          error: 'Permission denied',
        };
      }

      const { error } = await this._mkdir({ filePath });

      if (error) {
        log.error(
          `${error}`,
          `FileExplorerLocalDataSource.makeDirectory -> mkdir error`
        );

        return { error, stderr: null, data: false };
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  }

  /**
   * description - Check if files exist in the local disk
   *
   * @param {[string]} fileList
   * @return {Promise<boolean>}
   */
  async filesExist({ fileList }) {
    try {
      if (!isArray(fileList)) {
        return false;
      }

      if (isEmpty(fileList)) {
        return false;
      }

      for (let i = 0; i < fileList.length; i += 1) {
        const item = fileList[i];
        const fullPath = path.resolve(item);

        // eslint-disable-next-line no-await-in-loop
        const _accessGranted = await this._requestUsageAccess({
          filePath: fullPath,
        });

        if (!_accessGranted) {
          return {
            data: null,
            error: 'Permission denied',
          };
        }

        // eslint-disable-next-line no-await-in-loop
        if (await existsSync(fullPath)) {
          return true;
        }
      }

      return false;
    } catch (e) {
      log.error(e);

      return false;
    }
  }
}
