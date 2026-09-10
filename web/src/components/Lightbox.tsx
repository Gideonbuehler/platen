import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '@aperture/shared';
import { assetDownloadUrl, assetOriginalUrl, assetPreviewUrl } from '../lib/api';
import { captureWallClock, formatCaptureTime } from '../lib/justified';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconDownload,
  IconHeart,
  IconInfo,
  IconSpinner,
  IconTrash,
} from './Icons';
import './Lightbox.css';

interface LightboxProps {
  assets: Asset[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onToggleFavorite?: (asset: Asset) => void;
  onDelete?: (asset: Asset) => void;
  /** Share pages swap in public URLs and hide the owner-only actions. */
  previewUrl?: (asset: Asset) => string;
  originalUrl?: (asset: Asset) => string;
  downloadUrl?: (asset: Asset) => string;
  readOnly?: boolean;
  allowDownload?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function Lightbox({
  assets,
  index,
  onIndexChange,
  onClose,
  onToggleFavorite,
  onDelete,
  previewUrl = (asset) => assetPreviewUrl(asset.id),
  originalUrl = (asset) => assetOriginalUrl(asset.id),
  downloadUrl = (asset) => assetDownloadUrl(asset.id),
  readOnly = false,
  allowDownload = true,
}: LightboxProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const asset = assets[index];

  // The neighbour prefetch below means the next preview is usually already in
  // cache, so its load event fires before React can attach a handler. Check
  // completeness whenever the displayed asset changes.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setLoaded(true);
  }, [index]);

  // An asset whose derivatives never generated has no preview to fetch. Showing
  // that up front beats a spinner that never resolves, which is what a missing
  // preview looked like before.
  const derivativesMissing = asset?.thumbStatus === 'failed' || asset?.thumbStatus === 'pending';

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= assets.length) return;
      setLoaded(false);
      setFailed(false);
      onIndexChange(next);
    },
    [assets.length, onIndexChange],
  );

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          goTo(index - 1);
          break;
        case 'ArrowRight':
          goTo(index + 1);
          break;
        case 'i':
          setShowInfo((v) => !v);
          break;
        case 'f':
          if (asset && onToggleFavorite) onToggleFavorite(asset);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, goTo, onClose, asset, onToggleFavorite]);

  // Lock the page behind the overlay, and restore the exact scroll position on
  // close — otherwise closing a lightbox halfway down a long timeline throws
  // the user back to the top.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // Warm the neighbours so arrowing through feels instant.
  useEffect(() => {
    for (const offset of [1, -1]) {
      const neighbour = assets[index + offset];
      if (neighbour && neighbour.type === 'image') {
        const image = new Image();
        image.src = previewUrl(neighbour);
      }
    }
  }, [index, assets, previewUrl]);

  if (!asset) return null;

  const wallClock = captureWallClock(asset.takenAt, asset.takenAtOffset);
  const dateLabel = wallClock.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={asset.originalFilename}>
      <div className="lightbox-backdrop" onClick={onClose} />

      <header className="lightbox-header">
        <button type="button" className="btn btn-icon lightbox-btn" onClick={onClose} aria-label="Close">
          <IconClose size={20} />
        </button>

        <div className="lightbox-title">
          <span className="lightbox-filename">{asset.originalFilename}</span>
          <span className="lightbox-position">
            {index + 1} of {assets.length}
          </span>
        </div>

        <div className="lightbox-actions">
          {!readOnly && onToggleFavorite && (
            <button
              type="button"
              className={`btn btn-icon lightbox-btn${asset.isFavorite ? ' is-active' : ''}`}
              onClick={() => onToggleFavorite(asset)}
              aria-label={asset.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
            >
              <IconHeart size={20} filled={asset.isFavorite} />
            </button>
          )}

          <button
            type="button"
            className={`btn btn-icon lightbox-btn${showInfo ? ' is-active' : ''}`}
            onClick={() => setShowInfo((v) => !v)}
            aria-label="Photo details"
          >
            <IconInfo size={20} />
          </button>

          {allowDownload && (
            <a
              className="btn btn-icon lightbox-btn"
              href={downloadUrl(asset)}
              download={asset.originalFilename}
              aria-label="Download original"
            >
              <IconDownload size={20} />
            </a>
          )}

          {!readOnly && onDelete && (
            <button
              type="button"
              className="btn btn-icon lightbox-btn"
              onClick={() => onDelete(asset)}
              aria-label="Move to trash"
            >
              <IconTrash size={20} />
            </button>
          )}
        </div>
      </header>

      <div className="lightbox-stage">
        {index > 0 && (
          <button
            type="button"
            className="lightbox-nav lightbox-nav-prev"
            onClick={() => goTo(index - 1)}
            aria-label="Previous"
          >
            <IconChevronLeft size={26} />
          </button>
        )}

        <div className="lightbox-media">
          {asset.type === 'video' ? (
            <video
              key={asset.id}
              src={originalUrl(asset)}
              poster={previewUrl(asset)}
              controls
              autoPlay
              playsInline
              onLoadedData={() => setLoaded(true)}
            />
          ) : (
            <>
              {!loaded && !failed && !derivativesMissing && (
                <div className="lightbox-loading">
                  <IconSpinner size={30} />
                </div>
              )}

              {failed || derivativesMissing ? (
                <div className="lightbox-unavailable">
                  <h3>
                    {asset.thumbStatus === 'pending'
                      ? 'Still processing'
                      : 'No preview available'}
                  </h3>
                  <p>
                    {asset.thumbStatus === 'pending'
                      ? 'This photo is still being processed. It will appear shortly.'
                      : 'A preview could not be generated for this file, but the original is stored safely and can still be downloaded.'}
                  </p>
                  {allowDownload && (
                    <a className="btn btn-secondary" href={downloadUrl(asset)} download={asset.originalFilename}>
                      <IconDownload size={17} />
                      Download original
                    </a>
                  )}
                </div>
              ) : (
                <img
                  key={asset.id}
                  ref={imageRef}
                  src={previewUrl(asset)}
                  alt={asset.originalFilename}
                  className={loaded ? 'is-loaded' : ''}
                  onLoad={() => setLoaded(true)}
                  onError={() => setFailed(true)}
                  draggable={false}
                />
              )}
            </>
          )}
        </div>

        {index < assets.length - 1 && (
          <button
            type="button"
            className="lightbox-nav lightbox-nav-next"
            onClick={() => goTo(index + 1)}
            aria-label="Next"
          >
            <IconChevronRight size={26} />
          </button>
        )}
      </div>

      {showInfo && (
        <aside className="lightbox-info">
          <h3>Details</h3>

          <dl>
            <div>
              <dt>Taken</dt>
              <dd>
                {dateLabel}
                <br />
                <span className="lightbox-muted">
                  {formatCaptureTime(asset.takenAt, asset.takenAtOffset)}
                  {asset.takenAtOffset ? ` (UTC${asset.takenAtOffset})` : ''}
                </span>
              </dd>
            </div>

            <div>
              <dt>File</dt>
              <dd>
                {asset.originalFilename}
                <br />
                <span className="lightbox-muted">
                  {formatBytes(asset.fileSize)}
                  {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}
                </span>
              </dd>
            </div>

            {asset.exif?.make && (
              <div>
                <dt>Camera</dt>
                <dd>
                  {asset.exif.make} {asset.exif.model}
                  {asset.exif.lens && (
                    <>
                      <br />
                      <span className="lightbox-muted">{asset.exif.lens}</span>
                    </>
                  )}
                </dd>
              </div>
            )}

            {(asset.exif?.fNumber || asset.exif?.exposureTime || asset.exif?.iso) && (
              <div>
                <dt>Exposure</dt>
                <dd className="lightbox-exposure">
                  {asset.exif.fNumber && <span>ƒ/{asset.exif.fNumber}</span>}
                  {asset.exif.exposureTime && <span>{asset.exif.exposureTime}s</span>}
                  {asset.exif.iso && <span>ISO {asset.exif.iso}</span>}
                  {asset.exif.focalLength && <span>{Math.round(asset.exif.focalLength)}mm</span>}
                </dd>
              </div>
            )}

            {asset.exif?.latitude != null && asset.exif?.longitude != null && (
              <div>
                <dt>Location</dt>
                <dd>
                  {asset.exif.city ? `${asset.exif.city}, ` : ''}
                  {asset.exif.country ?? ''}
                  <br />
                  <a
                    className="lightbox-link"
                    href={`https://www.openstreetmap.org/?mlat=${asset.exif.latitude}&mlon=${asset.exif.longitude}#map=15/${asset.exif.latitude}/${asset.exif.longitude}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {asset.exif.latitude.toFixed(5)}, {asset.exif.longitude.toFixed(5)}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </aside>
      )}
    </div>
  );
}
