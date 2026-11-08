export const SEARCH_BAR_HEIGHT = 40;

export const styles = (theme) => ({
  root: {
    display: 'flex',
    alignItems: 'center',
    height: SEARCH_BAR_HEIGHT,
    boxSizing: 'border-box',
    paddingLeft: 10,
    paddingRight: 5,
    borderLeft: `solid 1px ${theme.palette.fileExplorerThinLineDividerColor}`,
    borderBottom: `solid 1px ${theme.palette.fileExplorerThinLineDividerColor}`,
  },
  searchIcon: {
    fontSize: 20,
    opacity: 0.6,
    marginRight: 8,
  },
  input: {
    flex: 1,
    minWidth: 60,
    fontSize: 13,
    // the file explorer pane disables text selection
    userSelect: 'text',
    '& input': {
      userSelect: 'text',
    },
  },
  progress: {
    marginLeft: 8,
    marginRight: 6,
    flexShrink: 0,
  },
  statusText: {
    opacity: 0.7,
    marginLeft: 4,
    marginRight: 8,
    maxWidth: 170,
    flexShrink: 1,
  },
  subfoldersLabel: {
    marginLeft: 0,
    marginRight: 4,
    flexShrink: 0,
  },
  closeBtn: {
    flexShrink: 0,
  },
});
