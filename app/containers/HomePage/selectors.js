import { createSelector } from 'reselect';
import { initialState } from './reducers';
import { getSelectedStorageIdFromState } from './actions';

const make = (state, __) => (state ? state.Home : {});

export const makeFocussedFileExplorerDeviceType = createSelector(
  make,
  (state) =>
    state
      ? state.focussedFileExplorerDeviceType
      : initialState.focussedFileExplorerDeviceType
);

export const makeToolbarList = createSelector(make, (state) =>
  state ? state.toolbarList : initialState.toolbarList
);

export const makeSidebarFavouriteList = createSelector(make, (state) =>
  state ? state.sidebarFavouriteList : initialState.sidebarFavouriteList
);

export const makeCurrentBrowsePath = createSelector(make, (state) =>
  state ? state.currentBrowsePath : initialState.currentBrowsePath
);

export const makeDirectoryLists = createSelector(make, (state) =>
  state ? state.directoryLists : initialState.directoryLists
);

export const makeMtpDevice = createSelector(make, (state) =>
  state ? state.mtpDevice : initialState.mtpDevice
);

export const makeContextMenuList = createSelector(make, (state) =>
  state ? state.contextMenuList : initialState.contextMenuList
);

export const makeMtpStoragesList = createSelector(make, (state) =>
  state ? state.mtpStoragesList : initialState.mtpStoragesList
);

export const makeStorageId = createSelector(make, (state) =>
  state ? getSelectedStorageIdFromState(state) : {}
);

export const makeFileTransferClipboard = createSelector(make, (state) =>
  state ? state.fileTransfer.clipboard : initialState.fileTransfer.clipboard
);

export const makeFileTransferProgess = createSelector(make, (state) =>
  state ? state.fileTransfer.progress : initialState.fileTransfer.progress
);

export const makeFilesDrag = createSelector(make, (state) =>
  state ? state.filesDrag : initialState.filesDrag
);

export const makeSearch = createSelector(make, (state) =>
  state ? state.search : initialState.search
);

export const makeFolderSizes = createSelector(make, (state) =>
  state ? state.folderSizes : initialState.folderSizes
);

/**
 * Nodes to display for one device pane: the listing (or recursive search
 * results), filtered by the search query, with computed folder sizes merged
 * in as `dirSize` / `dirSizeStatus`.
 */
const deriveVisibleNodes = (nodes, search, folderSizes) => {
  let visibleNodes = nodes;
  const query = search.isOpen ? search.query.trim().toLowerCase() : '';

  if (query !== '') {
    if (search.includeSubfolders && search.rootPath !== null) {
      visibleNodes = search.results;
    } else {
      visibleNodes = nodes.filter((node) =>
        `${node.name}`.toLowerCase().includes(query)
      );
    }
  }

  if (!folderSizes || Object.keys(folderSizes).length < 1) {
    return visibleNodes;
  }

  return visibleNodes.map((node) => {
    const folderSize = node.isFolder ? folderSizes[node.path] : null;

    if (!folderSize) {
      return node;
    }

    return {
      ...node,
      dirSize: folderSize.size,
      dirSizeStatus: folderSize.status,
    };
  });
};

// per device memoization: only recompute when that pane's inputs change, and
// keep `nodes` referentially stable when only the selection changes
const createDeviceMemo = () => {
  let lastNodesInputs = null;
  let lastNodes = null;
  let lastList = null;
  let lastListInputs = null;

  return (directoryList, search, folderSizes) => {
    const nodesInputs = [
      directoryList.nodes,
      search.isOpen,
      search.query,
      search.includeSubfolders,
      search.rootPath,
      search.results,
      folderSizes,
    ];

    if (
      !lastNodesInputs ||
      nodesInputs.some((value, index) => value !== lastNodesInputs[index])
    ) {
      lastNodes = deriveVisibleNodes(directoryList.nodes, search, folderSizes);
      lastNodesInputs = nodesInputs;
    }

    if (
      !lastListInputs ||
      lastListInputs[0] !== directoryList ||
      lastListInputs[1] !== lastNodes
    ) {
      lastList =
        lastNodes === directoryList.nodes
          ? directoryList
          : { ...directoryList, nodes: lastNodes };
      lastListInputs = [directoryList, lastNodes];
    }

    return lastList;
  };
};

const visibleDirectoryListsMemos = {};

export const makeVisibleDirectoryLists = createSelector(
  makeDirectoryLists,
  makeSearch,
  makeFolderSizes,
  (directoryLists, search, folderSizes) => {
    const result = {};

    Object.keys(directoryLists).forEach((deviceType) => {
      if (!visibleDirectoryListsMemos[deviceType]) {
        visibleDirectoryListsMemos[deviceType] = createDeviceMemo();
      }

      result[deviceType] = visibleDirectoryListsMemos[deviceType](
        directoryLists[deviceType],
        search[deviceType] ?? initialState.search[deviceType],
        folderSizes[deviceType]
      );
    });

    return result;
  }
);
