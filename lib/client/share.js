// Sharing a post link: the native share sheet where there is one, otherwise
// the clipboard.

/** Canonical public URL of a post. */
export function postUrl(postId) {
  return `${window.location.origin}/post/${postId}`;
}

/**
 * Shares a post. Resolves with a message to show the user, or null when the
 * native sheet handled it (the OS gives its own feedback).
 */
export async function sharePost(postId) {
  const url = postUrl(postId);
  if (navigator.share) {
    try { await navigator.share({ url, title: 'gg.share' }); } catch { /* dismissed */ }
    return null;
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'Link copied';
  } catch {
    return url;
  }
}
