// Display formatting helpers: relative times, sizes, identicons.

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function timeAgo(ts, now = Date.now()) {
  const s = Math.floor((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Full local date-time, or an em dash for a missing value. */
export function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

/** 1536 -> "1.5 KB". */
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Monochrome identicon: a deterministic 5x5 mirrored bitmap derived from the
 * address, as an SVG data URL. Colour would break the black/grey/white
 * scheme, so identity is carried by pattern instead of hue.
 */
export function identicon(addr, size = 40) {
  let h = 2166136261;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const tone = 18 + (h % 26); // 18%–43% lightness ground, stays neutral
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (h >>> ((y * 3 + x) % 30)) & 1;
      if (!bit) continue;
      cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      if (x < 2) cells += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-0.6 -0.6 6.2 6.2" shape-rendering="crispEdges">` +
    `<rect x="-0.6" y="-0.6" width="6.2" height="6.2" fill="hsl(0 0% ${tone}%)"/>` +
    `<g fill="hsl(0 0% ${tone + 52}%)">${cells}</g></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}
