// Hashtag parsing for display.
//
// Same pattern the server uses to index tags (lib/server/content/text.js):
// "#" plus letters/digits/underscore, not preceded by a word character or
// another "#", so "c#" and "abc#def" are not tags.

const TAG_PATTERN = /(^|[^0-9A-Za-z_#])#([0-9A-Za-z_]{1,50})/g;

/**
 * Splits text into plain-text and tag segments, for rendering tags as links
 * without ever building HTML from user content:
 *   "hi #cats" -> [{ text: 'hi ' }, { tag: 'cats', label: '#cats' }]
 * Tags are lowercased for the filter value; the label keeps the original case.
 */
export function splitTags(text) {
  const source = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const m of source.matchAll(TAG_PATTERN)) {
    const [, lead, tag] = m;
    const tagStart = m.index + lead.length;
    if (tagStart > last) parts.push({ text: source.slice(last, tagStart) });
    parts.push({ tag: tag.toLowerCase(), label: `#${tag}` });
    last = tagStart + 1 + tag.length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}
