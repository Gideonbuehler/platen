/**
 * Inline icon set.
 *
 * One geometry for all of them — 24px box, 1.6 stroke, round caps and joins —
 * so the chrome reads as a single system. Bundling an icon library would ship
 * far more than the two dozen glyphs this app actually uses.
 */

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({
  size = 20,
  className,
  strokeWidth = 1.6,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconPhotos = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15.5 16.5 11 6 21" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

export const IconAlbums = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="15" rx="2.5" />
    <path d="M6 3h12M4.5 6h15" />
  </Svg>
);

export const IconHeart = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M12 20.5C7 17 3.5 14 3.5 10.2A4.7 4.7 0 0 1 12 7.4a4.7 4.7 0 0 1 8.5 2.8c0 3.8-3.5 6.8-8.5 10.3Z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
);

export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
    <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" />
    <path d="M10 12h4" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4M8 8l4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v12M8 12l4 4 4-4" />
    <path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

export const IconShare = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p} strokeWidth={p.strokeWidth ?? 2.2}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l11-6.5Z" fill="currentColor" />
  </Svg>
);

export const IconRestore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3" />
    <path d="M16 16l4-4-4-4M20 12H9" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6 6 0 0 0-2.5-4.9" />
  </Svg>
);

export const IconSpinner = ({ size = 20, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    style={{ animation: 'spin 0.8s linear infinite' }}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);

/** The wordmark: an platen blade ring. */
/**
 * The Platen mark: a plate with a split P knocked out of it, a bar for the
 * plate and a frame for the film pressed against it.
 *
 * Filled with currentColor so each page's CSS decides the colour, which is
 * var(--accent) everywhere it appears today. The path is copied from
 * branding/render.mjs; change it there and regenerate, then update this.
 */
export const IconLogo = ({ size = 26, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="192 192 640 640"
    className={className}
    aria-hidden="true"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M340 192 H684 A148 148 0 0 1 832 340 V684 A148 148 0 0 1 684 832 H340 A148 148 0 0 1 192 684 V340 A148 148 0 0 1 340 192 Z M313 300 H349 A22 22 0 0 1 371 322 V702 A22 22 0 0 1 349 724 H313 A22 22 0 0 1 291 702 V322 A22 22 0 0 1 313 300 Z M465 300 H643 A66 66 0 0 1 709 366 V494 A66 66 0 0 1 643 560 H465 A66 66 0 0 1 399 494 V366 A66 66 0 0 1 465 300 Z M489 380 H619 A10 10 0 0 1 629 390 V470 A10 10 0 0 1 619 480 H489 A10 10 0 0 1 479 470 V390 A10 10 0 0 1 489 380 Z"
    />
  </svg>
);
