'use client';

// Bottom-sheet dialog used for compose, identity and report.
//
// Closes on Escape, on the ✕ button, and on a press on the backdrop (mousedown,
// not click, so a text selection that ends outside the sheet doesn't close
// it). While open it locks page scroll and moves focus into the sheet.
import { useEffect, useRef } from 'react';

export default function Modal({ open, onClose, title, titleId, children }) {
  const sheetRef = useRef(null);
  // The latest onClose, so the effect below doesn't re-run (and re-focus)
  // every time the parent re-renders with a new function.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    sheetRef.current?.querySelector('input, textarea, button')?.focus({ preventScroll: true });

    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef}>
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button className="x" type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
