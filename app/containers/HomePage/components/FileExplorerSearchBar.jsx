import React, { PureComponent } from 'react';
import { withStyles } from '@material-ui/core/styles';
import InputBase from '@material-ui/core/InputBase';
import IconButton from '@material-ui/core/IconButton';
import Checkbox from '@material-ui/core/Checkbox';
import FormControlLabel from '@material-ui/core/FormControlLabel';
import Typography from '@material-ui/core/Typography';
import Tooltip from '@material-ui/core/Tooltip';
import CircularProgress from '@material-ui/core/CircularProgress';
import SearchIcon from '@material-ui/icons/Search';
import CloseIcon from '@material-ui/icons/Close';
import { styles } from '../styles/FileExplorerSearchBar';
import { getPluralText } from '../../../utils/funcs';
import { SEARCH_MAX_RESULTS } from '../../../data/file-explorer/services/backgroundWalker';

class FileExplorerSearchBar extends PureComponent {
  constructor(props) {
    super(props);

    this.inputRef = React.createRef();
  }

  componentDidMount() {
    this.focusInput();
  }

  componentDidUpdate(prevProps) {
    const { focusRequest } = this.props;

    if (prevProps.focusRequest !== focusRequest) {
      this.focusInput();
    }
  }

  focusInput = () => {
    if (this.inputRef.current) {
      this.inputRef.current.focus();
      this.inputRef.current.select();
    }
  };

  _handleKeyDown = (event) => {
    const { onClose } = this.props;

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  statusText = () => {
    const { search, visibleCount } = this.props;
    const { query, includeSubfolders, status, results, truncated } = search;

    if (query.trim() === '') {
      return null;
    }

    const count = includeSubfolders ? results.length : visibleCount;
    const resultsText = `${count} ${getPluralText('result', count)}`;

    if (!includeSubfolders) {
      return resultsText;
    }

    switch (status) {
      case 'searching':
        return `Searching… ${resultsText}`;

      case 'error':
        return `Couldn't search this folder`;

      case 'done':
        return truncated ? `First ${SEARCH_MAX_RESULTS} results` : resultsText;

      default:
        return null;
    }
  };

  render() {
    const {
      classes: styles,
      search,
      onQueryChange,
      onIncludeSubfoldersChange,
      onClose,
    } = this.props;
    const { query, includeSubfolders, status } = search;
    const statusText = this.statusText();
    const isSearching = includeSubfolders && status === 'searching';

    return (
      <div className={styles.root}>
        <SearchIcon className={styles.searchIcon} />
        <InputBase
          className={styles.input}
          placeholder={
            includeSubfolders
              ? 'Search this folder and subfolders'
              : 'Search this folder'
          }
          value={query}
          inputRef={this.inputRef}
          inputProps={{ 'aria-label': 'Search files and folders' }}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={this._handleKeyDown}
        />
        {isSearching && (
          <CircularProgress size={14} className={styles.progress} />
        )}
        {statusText && (
          <Typography
            variant="caption"
            className={styles.statusText}
            noWrap
            title={statusText}
          >
            {statusText}
          </Typography>
        )}
        <FormControlLabel
          className={styles.subfoldersLabel}
          control={
            <Checkbox
              size="small"
              checked={includeSubfolders}
              onChange={(event) =>
                onIncludeSubfoldersChange(event.target.checked)
              }
            />
          }
          label={<Typography variant="caption">Subfolders</Typography>}
        />
        <Tooltip title="Close search (Esc)">
          <IconButton
            size="small"
            aria-label="Close search"
            onClick={onClose}
            className={styles.closeBtn}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </div>
    );
  }
}

export default withStyles(styles)(FileExplorerSearchBar);
