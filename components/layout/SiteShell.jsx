'use client';

// The public site's frame: desktop rail on the left, mobile top bar, and the
// centred content column. Used by both the feed and the post detail page.
//
// Slots:
//   onNewPost  shows a "New post" rail link when given (feed only)
//   railExtra  content under the nav, e.g. trending tags
//   railFooter content under the identity card, e.g. the ledger status
import Link from 'next/link';
import Avatar from '@/components/ui/Avatar';
import { useIdentity } from '@/components/identity/IdentityProvider';

function Brand() {
  return (
    <>
      <span className="lamp" />gg<span className="tld">.share</span>
    </>
  );
}

export default function SiteShell({ active, onNewPost, railExtra, railFooter, children }) {
  const { addr, nick, openIdentity } = useIdentity();

  return (
    <div className="shell">
      {/* Desktop rail */}
      <aside className="rail">
        <div className="brand"><Brand /></div>

        <nav className="rail-nav">
          <Link href="/" className={active === 'feed' ? 'is-active' : undefined}>
            <span className="glyph">▤</span> Feed
          </Link>
          {onNewPost && (
            <a href="#" onClick={(e) => { e.preventDefault(); onNewPost(); }}>
              <span className="glyph">＋</span> New post
            </a>
          )}
          <a href="#" onClick={(e) => { e.preventDefault(); openIdentity(); }}>
            <span className="glyph">◈</span> Identity
          </a>
        </nav>

        {railExtra}

        <div className="rail-foot">
          <button className="id-card" type="button" onClick={openIdentity}>
            <span className="row">
              <Avatar addr={addr} />
              <span>
                <span className="nick">{nick}</span>
                <span className="label" style={{ display: 'block' }}>You</span>
              </span>
            </span>
            <span className="addr">{addr}</span>
          </button>
          {railFooter}
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="topbar">
        <Link href="/" className="brand"><Brand /></Link>
        <button className="chip" type="button" onClick={openIdentity}>
          <Avatar addr={addr} />
          <span>{nick}</span>
        </button>
      </header>

      <main className="feed-col">{children}</main>
    </div>
  );
}
