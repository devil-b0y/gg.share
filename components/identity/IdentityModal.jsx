'use client';

// "Your identity" sheet: shows the nickname and address, and moves the key
// between devices via a recovery string.
import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { getIdentity } from '@/lib/client/identity';

export default function IdentityModal({ open, onClose, addr, nick }) {
  const [message, setMessage] = useState('');

  async function exportKey() {
    const key = await getIdentity().exportRecovery();
    try {
      await navigator.clipboard.writeText(key);
      setMessage('Recovery key copied. Store it somewhere safe — anyone holding it can post as you.');
    } catch {
      // Clipboard can be blocked (permissions, insecure context); show the
      // key so it can still be copied by hand.
      setMessage(key);
    }
  }

  async function importKey() {
    const value = window.prompt('Paste your recovery key:');
    if (!value) return;
    try {
      await getIdentity().importRecovery(value.trim());
      // Every component holds the old address; a reload is the simplest way
      // to make them all pick up the new one.
      window.location.reload();
    } catch (e) {
      setMessage(`That key could not be read: ${e.message}`);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Your identity" titleId="identityTitle">
      <p className="hint-text" style={{ marginTop: 0 }}>
        Your keypair was generated in this browser and never leaves it. The address below
        is derived from your public key, so posts and comments are provably yours without
        revealing who you are.
      </p>

      <div className="field">
        <label className="label" htmlFor="idNick">Display name</label>
        <input type="text" id="idNick" readOnly value={nick} />
      </div>
      <div className="field">
        <label className="label" htmlFor="idAddr">Address</label>
        <input type="text" id="idAddr" readOnly value={addr} />
      </div>

      <button className="btn btn-quiet btn-block" type="button" onClick={exportKey} style={{ marginBottom: 8 }}>
        Copy recovery key
      </button>
      <button className="btn btn-outline btn-block" type="button" onClick={importKey}>
        Restore from recovery key
      </button>
      <p className="hint-text" style={{ margin: '12px 0 0', overflowWrap: 'anywhere' }}>{message}</p>
    </Modal>
  );
}
