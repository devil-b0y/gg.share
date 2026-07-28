// TruthRank -- the trending score.
//
// Ranking on raw likes alone is trivially gamed: mint a hundred identities,
// like your own post, done. This blends several signals that are harder to
// fake simultaneously, and weights each voter by how much history their
// address actually has on the platform.
//
// Everything here is computed from this app's own tables. There is no
// external reputation oracle and no on-chain data -- "reputation" means
// "what this address has actually done here".
'use strict';

const db = require('../db');

// How fast a post's score decays. Gravity 1.6 over hours is the classic
// Hacker News curve: a post stays competitive for roughly a day.
const GRAVITY = 1.6;

const WEIGHTS = {
  like: 1.0,
  dislike: -1.4,     // a dislike costs more than a like earns
  comment: 1.6,      // conversation is the strongest positive signal
  reporter: -3.0,    // unresolved reports suppress hard
  blacklisted: -50   // effectively removes it from trending
};

/** An address's voting weight, from its own track record. New addresses
 * count for little, which is what makes bulk identity creation ineffective:
 * a hundred fresh keys carry less weight than a handful of real ones. */
function voterWeightExpr(alias) {
  return `
    (
      0.25
      + MIN(0.75, (SELECT COUNT(*) FROM posts vp WHERE vp.addr = ${alias} AND vp.status = 'live') * 0.25)
      + MIN(0.50, (SELECT COUNT(*) FROM comments vc WHERE vc.addr = ${alias} AND vc.status = 'live') * 0.10)
      - MIN(0.90, (SELECT COUNT(*) FROM posts bp WHERE bp.addr = ${alias} AND bp.status = 'blacklisted') * 0.45)
    )
  `;
}

/** SQL fragment producing the TruthRank score for the post aliased `p`.
 * Weighted engagement over an age-decay curve. */
function scoreExpr(p = 'p') {
  const weightedLikes = `
    COALESCE((
      SELECT SUM(${voterWeightExpr('l.addr')}) FROM likes l WHERE l.post_id = ${p}.id
    ), 0)`;
  const weightedDislikes = `
    COALESCE((
      SELECT SUM(${voterWeightExpr('d.addr')}) FROM dislikes d WHERE d.post_id = ${p}.id
    ), 0)`;
  const weightedComments = `
    COALESCE((
      SELECT SUM(${voterWeightExpr('c.addr')})
      FROM comments c WHERE c.post_id = ${p}.id AND c.status = 'live'
    ), 0)`;
  const openReports = `
    COALESCE((
      SELECT COUNT(*) FROM reports r WHERE r.post_id = ${p}.id AND r.resolved = 0
    ), 0)`;

  const raw = `(
    ${weightedLikes} * ${WEIGHTS.like}
    + ${weightedDislikes} * ${WEIGHTS.dislike}
    + ${weightedComments} * ${WEIGHTS.comment}
    + ${openReports} * ${WEIGHTS.reporter}
    + (CASE WHEN ${p}.status = 'blacklisted' THEN ${WEIGHTS.blacklisted} ELSE 0 END)
  )`;

  // Age in hours, +2 so a brand-new post doesn't divide by ~0 and dominate.
  const ageHours = `((? - ${p}.created_at) / 3600000.0)`;
  return `(${raw}) / POWER(${ageHours} + 2.0, ${GRAVITY})`;
}

/** Explains a single post's score, for the admin panel. */
function explain(postId) {
  const row = db.prepare(`
    SELECT p.id, p.created_at, p.status,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
      (SELECT COUNT(*) FROM dislikes d WHERE d.post_id = p.id) AS dislikes,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'live') AS comments,
      (SELECT COUNT(*) FROM reports r WHERE r.post_id = p.id AND r.resolved = 0) AS openReports,
      ${scoreExpr('p')} AS score
    FROM posts p WHERE p.id = ?
  `).get(Date.now(), postId);
  if (!row) return null;
  return {
    ...row,
    ageHours: (Date.now() - row.created_at) / 3600000,
    weights: WEIGHTS,
    gravity: GRAVITY
  };
}

module.exports = { scoreExpr, explain, WEIGHTS, GRAVITY };
