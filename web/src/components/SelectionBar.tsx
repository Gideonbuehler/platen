import { IconArchive, IconClose, IconHeart, IconPlus, IconRestore, IconTrash } from './Icons';
import './SelectionBar.css';

interface SelectionBarProps {
  count: number;
  onClear: () => void;
  onFavorite?: () => void;
  onArchive?: () => void;
  onAddToAlbum?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
  /** Trash shows restore / delete-forever instead of the usual actions. */
  variant?: 'default' | 'trash';
}

/**
 * Floating action bar for multi-select.
 *
 * It sits over the grid rather than replacing the header so that the photos
 * behind stay visible — the user needs to see what they have selected while
 * deciding what to do with it.
 */
export function SelectionBar({
  count,
  onClear,
  onFavorite,
  onArchive,
  onAddToAlbum,
  onDelete,
  onRestore,
  onDeleteForever,
  variant = 'default',
}: SelectionBarProps) {
  if (count === 0) return null;

  return (
    <div className="selection-bar" role="toolbar" aria-label={`${count} selected`}>
      <button type="button" className="btn btn-icon selection-btn" onClick={onClear} aria-label="Clear selection">
        <IconClose size={18} />
      </button>

      <span className="selection-count">
        {count} selected
      </span>

      <div className="selection-actions">
        {variant === 'trash' ? (
          <>
            {onRestore && (
              <button type="button" className="btn selection-action" onClick={onRestore}>
                <IconRestore size={17} />
                Restore
              </button>
            )}
            {onDeleteForever && (
              <button
                type="button"
                className="btn selection-action is-danger"
                onClick={onDeleteForever}
              >
                <IconTrash size={17} />
                Delete forever
              </button>
            )}
          </>
        ) : (
          <>
            {onFavorite && (
              <button type="button" className="btn selection-action" onClick={onFavorite}>
                <IconHeart size={17} />
                <span className="selection-label">Favourite</span>
              </button>
            )}
            {onAddToAlbum && (
              <button type="button" className="btn selection-action" onClick={onAddToAlbum}>
                <IconPlus size={17} />
                <span className="selection-label">Add to album</span>
              </button>
            )}
            {onArchive && (
              <button type="button" className="btn selection-action" onClick={onArchive}>
                <IconArchive size={17} />
                <span className="selection-label">Archive</span>
              </button>
            )}
            {onDelete && (
              <button type="button" className="btn selection-action is-danger" onClick={onDelete}>
                <IconTrash size={17} />
                <span className="selection-label">Delete</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
