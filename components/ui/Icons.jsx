// Line icons used on post cards. Stroke-only, `currentColor`, so they follow
// the monochrome theme; `filled` is how an active like/dislike is shown.

const base = {
  className: 'ico',
  viewBox: '0 0 24 24',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
};

export function HeartIcon({ filled = false }) {
  return (
    <svg {...base} fill={filled ? 'currentColor' : 'none'}>
      <path d="M20.8 8.6c0 4.6-8.8 10-8.8 10s-8.8-5.4-8.8-10a4.8 4.8 0 0 1 8.8-2.7 4.8 4.8 0 0 1 8.8 2.7z" />
    </svg>
  );
}

export function DislikeIcon({ filled = false }) {
  return (
    <svg {...base} fill={filled ? 'currentColor' : 'none'}>
      <path d="M7 3h9.3a2 2 0 0 1 2 1.7l1.2 7.6a2 2 0 0 1-2 2.3H15l1 4.4a2.2 2.2 0 0 1-4.2 1.1L9 14.6H7z" />
      <path d="M3 3h4v11.6H3z" />
    </svg>
  );
}

export function CommentIcon() {
  return (
    <svg {...base} fill="none">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.5-.7L3 21l1.9-5.2A8.2 8.2 0 0 1 4 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4z" />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg {...base} fill="none">
      <path d="M10.6 13.4a4 4 0 0 0 6 .4l2.6-2.6a4 4 0 0 0-5.6-5.7l-1.5 1.5" />
      <path d="M13.4 10.6a4 4 0 0 0-6-.4L4.8 12.8a4 4 0 0 0 5.6 5.7l1.5-1.5" />
    </svg>
  );
}

export function FlagIcon() {
  return (
    <svg {...base} fill="none">
      <path d="M5 21V4" />
      <path d="M5 4.5h11.5l-1.8 4 1.8 4H5z" />
    </svg>
  );
}
