import prefixer from '../../helpers/reducerPrefixer';
import { throwAlert } from '../Alerts/actions';
import {
  processMtpBuffer,
  processLocalBuffer,
} from '../../helpers/processBufferOutput';
import { isArraysEqual, isEmpty, undefinedOrNull } from '../../utils/funcs';
import { DEVICE_TYPE, MTP_MODE } from '../../enums';
import { log } from '../../utils/log';
import fileExplorerController from '../../data/file-explorer/controllers/FileExplorerController';
import { checkIf } from '../../utils/checkIf';
import { MTP_ERROR } from '../../enums/mtpError';
import { DEVICES_DEFAULT_PATH } from '../../constants';
import { analyticsService } from '../../services/analytics';
import {
  CancelToken,
  computeFolderSize,
  searchFiles,
  DeviceChangedError,
} from '../../data/file-explorer/services/backgroundWalker';
import { folderSizeCache } from '../../data/file-explorer/services/folderSizeCache';

const prefix = '@@Home';
const actionTypesList = [
  'SET_FOCUSSED_FILE_EXPLORER_DEVICE_TYPE',
  'SET_CURRENT_BROWSE_PATH',
  'SET_SORTING_DIR_LISTS',
  'SET_SELECTED_DIR_LISTS',
  'LIST_DIRECTORY',
  'SET_MTP_ERRORS',
  'SET_MTP_STATUS',
  'CHANGE_MTP_STORAGE',
  'SET_FILE_TRANSFER_CLIPBOARD',
  'SET_FILE_TRANSFER_PROGRESS',
  'CLEAR_FILE_TRANSFER',
  'SET_FILES_DRAG',
  'CLEAR_FILES_DRAG',
  'SET_SEARCH',
  'APPEND_SEARCH_RESULTS',
  'RESET_FOLDER_SIZES',
  'UPDATE_FOLDER_SIZES',
];

export const actionTypes = prefixer(prefix, actionTypesList);

export function setFocussedFileExplorerDeviceType(data) {
  return {
    type: actionTypes.SET_FOCUSSED_FILE_EXPLORER_DEVICE_TYPE,
    payload: {
      ...data,
    },
  };
}

export function setSortingDirLists(data, deviceType) {
  return {
    type: actionTypes.SET_SORTING_DIR_LISTS,
    deviceType,
    payload: {
      ...data,
    },
  };
}

export function actionSetSelectedDirLists(data, deviceType) {
  return {
    type: actionTypes.SET_SELECTED_DIR_LISTS,
    deviceType,
    payload: {
      ...data,
    },
  };
}

export function setCurrentBrowsePath(path, deviceType) {
  return {
    type: actionTypes.SET_CURRENT_BROWSE_PATH,
    deviceType,
    payload: path,
  };
}

function actionListDirectory(data, deviceType, _) {
  return {
    type: actionTypes.LIST_DIRECTORY,
    deviceType,
    payload: {
      nodes: data ?? [],
      isLoaded: true,
    },
  };
}

export function getSelectedStorageIdFromState(state) {
  const selectedStorage = getSelectedStorage(state.mtpStoragesList);

  if (isEmpty(selectedStorage?.id)) {
    return null;
  }

  return parseInt(selectedStorage.id, 10);
}

export function getSelectedStorage(mtpStoragesList) {
  checkIf(mtpStoragesList, 'object');

  if (isEmpty(mtpStoragesList)) {
    return null;
  }

  const mtpStoragesListKeys = Object.keys(mtpStoragesList);

  for (let i = 0; i < mtpStoragesListKeys.length; i += 1) {
    const itemKey = mtpStoragesListKeys[i];

    if (mtpStoragesList[itemKey].selected) {
      return { id: itemKey, data: mtpStoragesList[itemKey] };
    }
  }

  return null;
}

export function initializeMtp(
  {
    filePath,
    ignoreHidden,
    changeLegacyMtpStorageOnlyOnDeviceChange,
    deviceType,
  },
  getState
) {
  checkIf(deviceType, 'string');
  checkIf(filePath, 'string');
  checkIf(ignoreHidden, 'boolean');
  checkIf(changeLegacyMtpStorageOnlyOnDeviceChange, 'boolean');
  checkIf(getState, 'function');

  const { mtpStoragesList } = getState().Home;
  const { mtpMode } = getState().Settings;

  return async (dispatch) => {
    try {
      switch (mtpMode) {
        case MTP_MODE.kalam:
          return dispatch(
            initKalamMtp(
              {
                filePath,
                ignoreHidden,
                deviceType,
              },
              getState
            )
          );

        case MTP_MODE.legacy:
          return dispatch(
            initLegacyMtp(
              {
                filePath,
                ignoreHidden,
                deviceType,
                mtpStoragesList,
                changeLegacyMtpStorageOnlyOnDeviceChange,
              },
              getState
            )
          );

        default:
          return;
      }
    } catch (e) {
      log.error(e);
    }
  };
}

export function disposeMtp({ deviceType, onSuccess, onError }, getState) {
  return async (dispatch) => {
    const { mtpMode } = getState().Settings;

    checkIf(deviceType, 'string');
    checkIf(onSuccess, 'function');
    checkIf(onError, 'function');
    checkIf(mtpMode, 'string');

    dispatch(cancelBackgroundJobs(deviceType));

    try {
      switch (mtpMode) {
        case MTP_MODE.kalam:
          // eslint-disable-next-line no-case-declarations
          const { error, stderr, data } = await fileExplorerController.dispose({
            deviceType,
          });

          await new Promise((resolve) => {
            dispatch(
              churnMtpBuffer({
                deviceType,
                error,
                stderr,
                data,
                mtpMode,
                onSuccess: ({ _, __, data }) => {
                  dispatch(
                    actionSetMtpStatus({ info: {}, isAvailable: false })
                  );
                  dispatch(actionListDirectory([], deviceType));
                  dispatch(
                    actionSetSelectedDirLists({ selected: [] }, deviceType)
                  );
                  dispatch(actionChangeMtpStorage({}));

                  const _return = {
                    error: null,
                    stderr: null,
                    data,
                  };

                  onSuccess(_return);

                  return resolve(_return);
                },
                onError: ({ _, __, ___ }) => {
                  const _return = {
                    error,
                    stderr,
                    data: null,
                  };

                  onError(_return);

                  return resolve(_return);
                },
              })
            );
          });

          return;

        default:
          return;
      }
    } catch (e) {
      log.error(e);
    }
  };
}

function initKalamMtp({ filePath, ignoreHidden, deviceType }, getState) {
  return async (dispatch) => {
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');
    checkIf(deviceType, 'string');

    try {
      const { mtpMode } = getState().Settings;
      const { mtpDevice: preInitMtpDevice } = getState().Home;

      checkIf(preInitMtpDevice, 'object');

      dispatch(
        actionSetMtpStatus({
          isLoading: true,
        })
      );

      // if the app was expecting the user to allow access to mtp storage
      // then don't reinitialize mtp
      const { error, stderr, data } = await fileExplorerController.initialize({
        deviceType,
      });

      await new Promise((resolve) => {
        dispatch(
          churnMtpBuffer({
            deviceType,
            error,
            stderr,
            data,
            mtpMode,
            onSuccess: ({ _, __, data }) => {
              dispatch(actionSetMtpStatus({ info: data }));

              analyticsService.sendDeviceInfo();

              return resolve({
                error: null,
                stderr: null,
                data,
              });
            },
            onError: ({ _, __, ___ }) => {
              return resolve({
                error,
                stderr,
                data: null,
              });
            },
          })
        );
      });

      const { mtpDevice: postInitMtpDevice } = getState().Home;

      checkIf(postInitMtpDevice, 'object');

      if (!postInitMtpDevice.isAvailable) {
        return;
      }

      let _filePath = filePath;

      if (
        !undefinedOrNull(preInitMtpDevice?.info?.mtpDeviceInfo?.SerialNumber) &&
        !undefinedOrNull(
          postInitMtpDevice?.info?.mtpDeviceInfo?.SerialNumber
        ) &&
        preInitMtpDevice?.info?.mtpDeviceInfo?.SerialNumber !==
          postInitMtpDevice?.info?.mtpDeviceInfo?.SerialNumber
      ) {
        _filePath = DEVICES_DEFAULT_PATH[deviceType];
        dispatch(actionChangeMtpStorage({}));
      }

      dispatch(
        actionSetMtpStatus({
          isLoading: true,
        })
      );

      await new Promise((resolve) => {
        dispatch(
          listKalamStorages(
            {
              filePath,
              ignoreHidden,
              deviceType,
              onSuccess: () => {
                resolve();
              },
              onError: () => {
                resolve();
              },
            },
            getState
          )
        );
      });

      const { mtpDevice: postStorageAccessMtpDevice } = getState().Home;

      checkIf(postStorageAccessMtpDevice, 'object');

      if (!postStorageAccessMtpDevice.isAvailable) {
        return;
      }

      dispatch(
        actionSetMtpStatus({
          isLoading: true,
        })
      );

      dispatch(
        reloadDirList(
          { filePath: _filePath, ignoreHidden, deviceType },
          getState
        )
      );
    } catch (e) {
      log.error(e);
    }
  };
}

function listKalamStorages(
  { filePath, ignoreHidden, deviceType, onSuccess, onError },
  getState
) {
  return async (dispatch) => {
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');
    checkIf(deviceType, 'string');
    checkIf(onSuccess, 'function');
    checkIf(onError, 'function');

    try {
      const { mtpMode } = getState().Settings;

      checkIf(mtpMode, 'string');

      const { error, stderr, data } = await fileExplorerController.listStorages(
        {
          deviceType,
        }
      );

      return new Promise((resolve) => {
        dispatch(
          churnMtpBuffer({
            deviceType,
            error,
            stderr,
            data,
            mtpMode,
            onSuccess: async () => {
              dispatch(actionChangeMtpStorage({ ...data }));

              onSuccess();

              return resolve({
                error: null,
                stderr: null,
                data,
              });
            },
            onError: async () => {
              onError();

              return resolve({
                error,
                stderr,
                data: null,
              });
            },
          })
        );
      });
    } catch (e) {
      log.error(e);
    }
  };
}

function initLegacyMtp(
  {
    filePath,
    ignoreHidden,
    deviceType,
    mtpStoragesList,
    changeLegacyMtpStorageOnlyOnDeviceChange,
  },
  getState
) {
  return async (dispatch) => {
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');
    checkIf(deviceType, 'string');
    checkIf(mtpStoragesList, 'object');
    checkIf(changeLegacyMtpStorageOnlyOnDeviceChange, 'boolean');

    const { mtpMode } = getState().Settings;

    try {
      const { error, stderr, data } = await fileExplorerController.listStorages(
        {
          deviceType,
        }
      );

      dispatch(
        churnMtpBuffer({
          deviceType,
          error,
          stderr,
          data,
          mtpMode,
          onSuccess: () => {
            let updateMtpStorage = true;

            if (
              changeLegacyMtpStorageOnlyOnDeviceChange &&
              !isEmpty(mtpStoragesList) &&
              isArraysEqual(Object.keys(data), Object.keys(mtpStoragesList))
            ) {
              updateMtpStorage = false;
            }

            if (updateMtpStorage) {
              dispatch(actionChangeMtpStorage({ ...data }));
            }

            dispatch(
              listDirectory(
                {
                  filePath,
                  ignoreHidden,
                },
                deviceType,
                getState
              )
            );
          },
        })
      );
    } catch (e) {
      log.error(e);
    }
  };
}

export function actionChangeMtpStorage({ ...data }) {
  return {
    type: actionTypes.CHANGE_MTP_STORAGE,
    payload: data,
  };
}

/**
 *
 * @param args {isAvailable, error, isLoading, info}
 * @return {{payload: {}, type: *}}
 */
export function actionSetMtpStatus({ ...args }) {
  return {
    type: actionTypes.SET_MTP_STATUS,
    payload: args,
  };
}

// This is the main entry point of data received from the MTP kernel.
// The data received here undergoes processing and the neccessary actions are taken accordingly
export function churnMtpBuffer({
  deviceType,
  error,
  stderr,
  data,
  mtpMode,
  onSuccess,
  onError,
}) {
  checkIf(onSuccess, 'function');
  checkIf(mtpMode, 'string');

  return async (dispatch) => {
    try {
      const {
        mtpStatus,
        error: mtpError,
        throwAlert: mtpThrowAlert,
        logError: mtpLogError,
        reportError: mtpReportError,
      } = await processMtpBuffer({ error, stderr, mtpMode });

      dispatch(
        actionSetMtpStatus({
          isAvailable: mtpStatus,
          error: mtpMode === MTP_MODE.kalam ? stderr : error,
          isLoading: false,
        })
      );

      if (!mtpStatus) {
        dispatch(cancelBackgroundJobs(deviceType));
        dispatch(actionListDirectory([], deviceType));
        dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));

        if (onError) {
          onError({ error, stderr, data: null });
        }
      }

      if (mtpError) {
        log.error(
          mtpError,
          'churnMtpBuffer.mtpError',
          mtpLogError,
          true,
          mtpReportError === true,
          false
        );
        log.error(error, 'churnMtpBuffer.error', true, true, false);
        log.error(stderr, 'churnMtpBuffer.stderr', true, true, false);

        if (mtpThrowAlert) {
          dispatch(throwAlert({ message: mtpError.toString() }));
        }

        return;
      }

      return onSuccess({ error: null, stderr: null, data });
    } catch (e) {
      log.error(e);
    }
  };
}

// this is the main entry point of data received from the local disk file actions.
// the data received here undergoes processing and the neccessary actions are taken accordingly
export function churnLocalBuffer({
  _,
  error,
  stderr,
  data,
  onSuccess,
  onError,
}) {
  return (dispatch) => {
    try {
      const {
        error: localError,
        throwAlert: localThrowAlert,
        logError: localLogError,
      } = processLocalBuffer({ error, stderr });

      if (localError) {
        log.error(localError, 'churnLocalBuffer', localLogError);

        if (localThrowAlert) {
          dispatch(throwAlert({ message: localError.toString() }));
        }

        if (onError) {
          onError({ error, stderr, data: null });
        }

        return false;
      }

      checkIf(onSuccess, 'function');

      onSuccess({ error: null, stderr: null, data });
    } catch (e) {
      log.error(e);
    }
  };
}

export function listDirectory(
  { filePath, ignoreHidden, onError, onSuccess },
  deviceType,
  getState
) {
  checkIf(filePath, 'string');
  checkIf(ignoreHidden, 'boolean');
  checkIf(getState, 'function');

  const { mtpMode } = getState().Settings;

  try {
    switch (deviceType) {
      case DEVICE_TYPE.local:
        return async (dispatch) => {
          const {
            error: localError,
            stderr: localStderr,
            data: localData,
          } = await fileExplorerController.listFiles({
            deviceType,
            filePath,
            ignoreHidden,
            storageId: null,
          });

          if (localError) {
            log.error(localError, 'listDirectory -> listFiles');

            dispatch(
              churnLocalBuffer({
                deviceType,
                error: localError,
                stderr: localStderr,
                data: localData,
                onSuccess: () => {},
              })
            );

            return;
          }

          const prevPath = getState().Home.currentBrowsePath[deviceType];

          dispatch(actionListDirectory(localData, deviceType), getState);
          dispatch(setCurrentBrowsePath(filePath, deviceType));
          dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));
          dispatch(onDirectoryListed({ deviceType, prevPath, filePath }));
        };

      case DEVICE_TYPE.mtp:
        return async (dispatch) => {
          const storageId = getSelectedStorageIdFromState(getState().Home);

          if (undefinedOrNull(storageId)) {
            return;
          }

          const { error, stderr, data } =
            await fileExplorerController.listFiles({
              deviceType,
              filePath,
              ignoreHidden,
              storageId,
            });

          dispatch(
            churnMtpBuffer({
              deviceType,
              error,
              stderr,
              data,
              mtpMode,
              onSuccess: ({ error, stderr, data }) => {
                const prevPath = getState().Home.currentBrowsePath[deviceType];

                dispatch(actionListDirectory(data, deviceType), getState);
                dispatch(
                  actionSetSelectedDirLists({ selected: [] }, deviceType)
                );
                dispatch(setCurrentBrowsePath(filePath, deviceType));
                dispatch(onDirectoryListed({ deviceType, prevPath, filePath }));

                if (onSuccess) {
                  onSuccess({ error, stderr, data });
                }
              },

              onError: ({ error, stderr, data }) => {
                if (onError) {
                  onError({ error, stderr, data });
                }
              },
            })
          );
        };

      default:
        break;
    }
  } catch (e) {
    log.error(e);
  }
}

export function reloadDirList(
  { filePath, ignoreHidden, deviceType },
  getState
) {
  checkIf(deviceType, 'inObjectValues', DEVICE_TYPE);
  checkIf(filePath, 'string');
  checkIf(ignoreHidden, 'boolean');
  checkIf(getState, 'function');

  const { mtpMode, mtpDevice } = getState().Home;

  checkIf(mtpDevice, 'object');

  return (dispatch) => {
    // an explicit reload should never show stale folder sizes
    folderSizeCache.invalidate(deviceType);

    switch (deviceType) {
      case DEVICE_TYPE.local:
        return dispatch(
          listDirectory({ filePath, ignoreHidden }, deviceType, getState)
        );

      case DEVICE_TYPE.mtp:
        switch (mtpMode) {
          case MTP_MODE.legacy:
            return dispatch(
              initializeMtp(
                {
                  filePath,
                  ignoreHidden,
                  changeLegacyMtpStorageOnlyOnDeviceChange: true,
                  deviceType,
                },
                getState
              )
            );

          case MTP_MODE.kalam:
          default:
            dispatch(
              actionSetMtpStatus({
                isLoading: true,
              })
            );

            // if mtpdevice is available then list directory
            if (mtpDevice.isAvailable) {
              return dispatch(
                listDirectory(
                  {
                    filePath,
                    ignoreHidden,
                    onError: ({ stderr }) => {
                      // if device was changed then reinitialize the mtp
                      if (stderr === MTP_ERROR.ErrorDeviceChanged) {
                        dispatch(
                          initializeMtp(
                            {
                              filePath,
                              ignoreHidden,
                              changeLegacyMtpStorageOnlyOnDeviceChange: true,
                              deviceType,
                            },
                            getState
                          )
                        );
                      }
                    },
                    onSuccess: () => {},
                  },
                  deviceType,
                  getState
                )
              );
            }

            // if the mtp was not previously initialized then initialize it
            return dispatch(
              initializeMtp(
                {
                  filePath,
                  ignoreHidden,
                  changeLegacyMtpStorageOnlyOnDeviceChange: true,
                  deviceType,
                },
                getState
              )
            );
        }

      default:
        break;
    }
  };
}

export function setFileTransferClipboard({ ...data }) {
  return {
    type: actionTypes.SET_FILE_TRANSFER_CLIPBOARD,
    payload: {
      ...data,
    },
  };
}

export function setFileTransferProgress({ ...data }) {
  return {
    type: actionTypes.SET_FILE_TRANSFER_PROGRESS,
    payload: {
      ...data,
    },
  };
}

export function clearFileTransfer() {
  return {
    type: actionTypes.CLEAR_FILE_TRANSFER,
  };
}

export function setFilesDrag({ ...data }) {
  return {
    type: actionTypes.SET_FILES_DRAG,
    payload: {
      ...data,
    },
  };
}

export function clearFilesDrag() {
  return {
    type: actionTypes.CLEAR_FILES_DRAG,
  };
}

/**
 * ---------------------------------------------------------------------------
 * Search and folder sizes
 *
 * Both run in the background on top of `backgroundWalker`. Each device pane
 * has at most one folder size job and one recursive search job; starting a new
 * one cancels the previous one.
 * ---------------------------------------------------------------------------
 */

const BACKGROUND_FLUSH_INTERVAL_MS = 300;

// how long to wait after the last keystroke before re-running a recursive search
const SEARCH_DEBOUNCE_MS = {
  [DEVICE_TYPE.local]: 400,
  [DEVICE_TYPE.mtp]: 800,
};

// number of folders sized in parallel
const FOLDER_SIZE_CONCURRENCY = {
  [DEVICE_TYPE.local]: 2,
  [DEVICE_TYPE.mtp]: 1,
};

const backgroundJobs = {
  folderSizes: {},
  search: {},
  searchDebounce: {},

  // MTP only: folder sizes are paused while a recursive search uses the device
  folderSizesPausedForSearch: {},
};

const searchResetPayload = {
  status: 'idle',
  rootPath: null,
  results: [],
  truncated: false,
};

function actionSetSearch(data, deviceType) {
  return {
    type: actionTypes.SET_SEARCH,
    deviceType,
    payload: { ...data },
  };
}

function actionAppendSearchResults(results, deviceType) {
  return {
    type: actionTypes.APPEND_SEARCH_RESULTS,
    deviceType,
    payload: results,
  };
}

function actionResetFolderSizes(data, deviceType) {
  return {
    type: actionTypes.RESET_FOLDER_SIZES,
    deviceType,
    payload: data,
  };
}

function actionUpdateFolderSizes(data, deviceType) {
  return {
    type: actionTypes.UPDATE_FOLDER_SIZES,
    deviceType,
    payload: data,
  };
}

const getStorageIdForDevice = (deviceType, homeState) =>
  deviceType === DEVICE_TYPE.mtp
    ? getSelectedStorageIdFromState(homeState)
    : null;

// path of [filePath]'s parent, relative to [rootPath] ('' if directly inside)
const relativeParentPath = (rootPath, filePath) => {
  const parent = filePath.slice(0, filePath.lastIndexOf('/'));
  const root = rootPath.replace(/\/+$/, '');

  if (!parent.startsWith(root)) {
    return parent;
  }

  return parent.slice(root.length).replace(/^\/+/, '');
};

const isRecursiveSearchActive = (search) =>
  search.isOpen && search.includeSubfolders && search.query.trim() !== '';

function cancelSearchJob(deviceType) {
  clearTimeout(backgroundJobs.searchDebounce[deviceType]);
  backgroundJobs.searchDebounce[deviceType] = null;

  if (backgroundJobs.search[deviceType]) {
    backgroundJobs.search[deviceType].cancel();
    backgroundJobs.search[deviceType] = null;
  }
}

function cancelFolderSizeJob(deviceType) {
  if (backgroundJobs.folderSizes[deviceType]) {
    backgroundJobs.folderSizes[deviceType].cancel();
    backgroundJobs.folderSizes[deviceType] = null;
  }
}

/**
 * description - stop all background work for a device pane and drop its
 * search results and folder sizes (eg: the device was disconnected)
 */
export function cancelBackgroundJobs(deviceType) {
  return (dispatch) => {
    cancelSearchJob(deviceType);
    cancelFolderSizeJob(deviceType);
    backgroundJobs.folderSizesPausedForSearch[deviceType] = false;

    dispatch(actionSetSearch(searchResetPayload, deviceType));
    dispatch(actionResetFolderSizes({}, deviceType));
  };
}

/**
 * description - a background listing found that a different phone is now
 * connected. Kalam reports this only once, so re-initialize MTP here exactly
 * like [reloadDirList] does for a user-initiated listing; otherwise the app
 * would keep using the previous phone's storages.
 */
function onBackgroundDeviceChanged(deviceType) {
  return (dispatch, getState) => {
    // results and sizes belong to the previous phone
    dispatch(cancelBackgroundJobs(deviceType));

    const { Home: homeState, Settings: settingsState } = getState();

    dispatch(
      initializeMtp(
        {
          filePath: homeState.currentBrowsePath[deviceType],
          ignoreHidden: settingsState.hideHiddenFiles[deviceType],
          changeLegacyMtpStorageOnlyOnDeviceChange: true,
          deviceType,
        },
        getState
      )
    );
  };
}

/**
 * description - compute recursive sizes of all folders in the current
 * listing of [deviceType] in the background
 */
export function startFolderSizeJob(deviceType) {
  return async (dispatch, getState) => {
    cancelFolderSizeJob(deviceType);
    backgroundJobs.folderSizesPausedForSearch[deviceType] = false;

    const { Home: homeState, Settings: settingsState } = getState();
    const nodes = homeState.directoryLists[deviceType].nodes ?? [];
    const browsePath = homeState.currentBrowsePath[deviceType];
    const storageId = getStorageIdForDevice(deviceType, homeState);

    // the legacy MTP kernel doesn't report file sizes
    const isUnsupported =
      deviceType === DEVICE_TYPE.mtp &&
      (settingsState.mtpMode === MTP_MODE.legacy ||
        undefinedOrNull(storageId) ||
        !homeState.mtpDevice.isAvailable);

    if (isUnsupported) {
      dispatch(actionResetFolderSizes({}, deviceType));

      return;
    }

    const token = new CancelToken();

    backgroundJobs.folderSizes[deviceType] = token;

    const initialSizes = {};
    const pendingFolders = [];

    nodes.forEach((node) => {
      if (!node.isFolder) {
        return;
      }

      // eg: '/Volumes/Macintosh HD' -> '/'
      if (node.symlink) {
        initialSizes[node.path] = { status: 'unavailable' };

        return;
      }

      const cached = folderSizeCache.get({
        deviceType,
        storageId,
        filePath: node.path,
      });

      if (cached === undefined) {
        initialSizes[node.path] = { status: 'loading' };
        pendingFolders.push(node.path);

        return;
      }

      initialSizes[node.path] = { status: 'done', size: cached };
    });

    dispatch(actionResetFolderSizes(initialSizes, deviceType));

    if (pendingFolders.length < 1) {
      return;
    }

    let buffer = {};
    let flushTimer = null;

    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = null;

      if (token.cancelled || isEmpty(buffer)) {
        return;
      }

      dispatch(actionUpdateFolderSizes(buffer, deviceType));
      buffer = {};
    };

    let cursor = 0;

    const worker = async () => {
      while (cursor < pendingFolders.length && !token.cancelled) {
        const folderPath = pendingFolders[cursor];

        cursor += 1;

        // eslint-disable-next-line no-await-in-loop
        const size = await computeFolderSize({
          deviceType,
          storageId,
          folderPath,
          browsePath,
          token,
        });

        if (size === undefined || token.cancelled) {
          return;
        }

        buffer[folderPath] =
          size === null ? { status: 'unavailable' } : { status: 'done', size };

        if (!flushTimer) {
          flushTimer = setTimeout(flush, BACKGROUND_FLUSH_INTERVAL_MS);
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: FOLDER_SIZE_CONCURRENCY[deviceType] }, worker)
      );
    } catch (e) {
      if (e instanceof DeviceChangedError) {
        dispatch(onBackgroundDeviceChanged(deviceType));
      } else {
        log.error(e, 'startFolderSizeJob');
      }
    }

    flush();

    if (backgroundJobs.folderSizes[deviceType] === token) {
      backgroundJobs.folderSizes[deviceType] = null;
    }
  };
}

/**
 * description - run the recursive (include subfolders) search for
 * [deviceType] from the current browse path
 */
export function runRecursiveSearch(deviceType) {
  return async (dispatch, getState) => {
    cancelSearchJob(deviceType);

    const { Home: homeState, Settings: settingsState } = getState();
    const search = homeState.search[deviceType];

    if (!isRecursiveSearchActive(search)) {
      dispatch(actionSetSearch(searchResetPayload, deviceType));

      return;
    }

    const storageId = getStorageIdForDevice(deviceType, homeState);

    if (
      deviceType === DEVICE_TYPE.mtp &&
      (undefinedOrNull(storageId) || !homeState.mtpDevice.isAvailable)
    ) {
      return;
    }

    const token = new CancelToken();

    backgroundJobs.search[deviceType] = token;

    // MTP devices serve one request at a time; give the search the device
    if (deviceType === DEVICE_TYPE.mtp) {
      cancelFolderSizeJob(deviceType);
      backgroundJobs.folderSizesPausedForSearch[deviceType] = true;
    }

    const rootPath = homeState.currentBrowsePath[deviceType];

    dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));
    dispatch(
      actionSetSearch(
        { ...searchResetPayload, status: 'searching', rootPath },
        deviceType
      )
    );

    let buffer = [];
    let flushTimer = null;

    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = null;

      if (token.cancelled || buffer.length < 1) {
        return;
      }

      dispatch(actionAppendSearchResults(buffer, deviceType));
      buffer = [];
    };

    let result = { truncated: false, rootFailed: true };

    try {
      result = await searchFiles({
        deviceType,
        storageId,
        rootPath,
        query: search.query,
        ignoreHidden: settingsState.hideHiddenFiles[deviceType],
        token,
        onResults: (nodes) => {
          nodes.forEach((node) => {
            buffer.push({
              ...node,
              searchParent: relativeParentPath(rootPath, node.path),
            });
          });

          if (!flushTimer) {
            flushTimer = setTimeout(flush, BACKGROUND_FLUSH_INTERVAL_MS);
          }
        },
      });
    } catch (e) {
      if (e instanceof DeviceChangedError) {
        dispatch(onBackgroundDeviceChanged(deviceType));
      } else {
        log.error(e, 'runRecursiveSearch');
      }
    }

    if (token.cancelled) {
      clearTimeout(flushTimer);

      return;
    }

    flush();
    backgroundJobs.search[deviceType] = null;

    dispatch(
      actionSetSearch(
        {
          status: result.rootFailed ? 'error' : 'done',
          truncated: result.truncated,
        },
        deviceType
      )
    );

    dispatch(resumePausedFolderSizes(deviceType));
  };
}

// restart the MTP folder size job if a recursive search paused it
function resumePausedFolderSizes(deviceType) {
  return (dispatch) => {
    if (!backgroundJobs.folderSizesPausedForSearch[deviceType]) {
      return;
    }

    dispatch(startFolderSizeJob(deviceType));
  };
}

function scheduleRecursiveSearch(deviceType) {
  return (dispatch) => {
    cancelSearchJob(deviceType);

    backgroundJobs.searchDebounce[deviceType] = setTimeout(() => {
      backgroundJobs.searchDebounce[deviceType] = null;
      dispatch(runRecursiveSearch(deviceType));
    }, SEARCH_DEBOUNCE_MS[deviceType]);
  };
}

/**
 * description - leave recursive search mode: drop its results and, on MTP,
 * resume folder sizes that were paused for the search
 */
function stopRecursiveSearch(deviceType) {
  return (dispatch) => {
    cancelSearchJob(deviceType);
    dispatch(actionSetSearch(searchResetPayload, deviceType));
    dispatch(resumePausedFolderSizes(deviceType));
  };
}

/**
 * description - open or close the search bar of a pane. Closing clears the
 * query and any results.
 */
export function toggleSearch(isOpen, deviceType) {
  return (dispatch, getState) => {
    const search = getState().Home.search[deviceType];

    if (search.isOpen === isOpen) {
      return;
    }

    if (!isOpen) {
      dispatch(stopRecursiveSearch(deviceType));

      if (search.query !== '') {
        dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));
      }
    }

    dispatch(
      actionSetSearch(
        isOpen ? { isOpen } : { isOpen, query: '', ...searchResetPayload },
        deviceType
      )
    );
  };
}

export function setSearchQuery(query, deviceType) {
  return (dispatch, getState) => {
    checkIf(query, 'string');

    dispatch(actionSetSearch({ query }, deviceType));
    // never keep hidden items selected: actions like delete act on the selection
    dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));

    const search = getState().Home.search[deviceType];

    if (isRecursiveSearchActive(search)) {
      // until the new results come in, filter the current folder instead
      cancelSearchJob(deviceType);
      dispatch(actionSetSearch(searchResetPayload, deviceType));
      dispatch(scheduleRecursiveSearch(deviceType));

      return;
    }

    dispatch(stopRecursiveSearch(deviceType));
  };
}

export function setSearchIncludeSubfolders(includeSubfolders, deviceType) {
  return (dispatch, getState) => {
    checkIf(includeSubfolders, 'boolean');

    dispatch(actionSetSearch({ includeSubfolders }, deviceType));
    dispatch(actionSetSelectedDirLists({ selected: [] }, deviceType));

    const search = getState().Home.search[deviceType];

    if (isRecursiveSearchActive(search)) {
      dispatch(runRecursiveSearch(deviceType));

      return;
    }

    dispatch(stopRecursiveSearch(deviceType));
  };
}

/**
 * description - called whenever a directory listing was loaded successfully.
 * Keeps the search in sync with the listing and starts computing folder sizes.
 *
 * @param {string} deviceType
 * @param {string} prevPath - browse path before this listing
 * @param {string} filePath - path that was listed
 */
function onDirectoryListed({ deviceType, prevPath, filePath }) {
  return (dispatch, getState) => {
    const search = getState().Home.search[deviceType];

    if (prevPath !== filePath) {
      // navigated somewhere else: start with a fresh search
      cancelSearchJob(deviceType);

      if (search.query !== '' || search.rootPath !== null) {
        dispatch(
          actionSetSearch({ query: '', ...searchResetPayload }, deviceType)
        );
      }
    } else if (isRecursiveSearchActive(search)) {
      // same folder reloaded (refresh, delete, rename, ...): refresh results
      dispatch(runRecursiveSearch(deviceType));

      if (deviceType === DEVICE_TYPE.mtp) {
        // the search resumes folder sizes once it finishes
        return;
      }
    }

    dispatch(startFolderSizeJob(deviceType));
  };
}
