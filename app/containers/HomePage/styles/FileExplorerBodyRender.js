import { mixins } from '../../../styles/js';
import { SEARCH_BAR_HEIGHT } from './FileExplorerSearchBar';

export const styles = (theme) => ({
  root: {
    width: '100%',
    ...mixins({ theme }).noselect,
  },
  tableWrapper: {
    ...mixins({ theme }).noOutline,
    height: `calc(100vh - 120px)`,
    overflowY: 'auto',
    overflowX: 'auto',
    borderBottom: `solid 1px ${theme.palette.fileExplorerThinLineDividerColor}`,
    borderLeft: `solid 1px ${theme.palette.fileExplorerThinLineDividerColor}`,
    [`&.onHoverDropZone`]: {
      backgroundColor: theme.palette.fileDrop,
    },
    [`&.statusBarActive`]: {
      height: `calc(100vh - 150px) !important`,
    },
    [`&.searchBarActive`]: {
      height: `calc(100vh - ${120 + SEARCH_BAR_HEIGHT}px)`,
    },
    [`&.statusBarActive.searchBarActive`]: {
      height: `calc(100vh - ${150 + SEARCH_BAR_HEIGHT}px) !important`,
    },
  },
});
