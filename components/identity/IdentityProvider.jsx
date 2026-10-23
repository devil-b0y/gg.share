'use client';

// Makes the browser's keypair identity available to every component:
//
//   const { ready, addr, nick, sign, openIdentity } = useIdentity();
//
// The identity lives in localStorage, so it can only be loaded after mount.
// Until then `ready` is false and `addr` is '' -- components that need the
// address (the feed, to request vote state) wait for `ready`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getIdentity } from '@/lib/client/identity';
import { nicknameFromAddr } from '@/lib/client/nickname';
import IdentityModal from './IdentityModal';

const IdentityContext = createContext(null);

export function IdentityProvider({ children }) {
  const [state, setState] = useState({ ready: false, addr: '', nick: '…', error: null });
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const identity = getIdentity();
    identity.ready
      .then(() => {
        if (!cancelled) setState({ ready: true, addr: identity.addr, nick: nicknameFromAddr(identity.addr), error: null });
      })
      .catch((error) => {
        if (!cancelled) setState((s) => ({ ...s, error }));
      });
    return () => { cancelled = true; };
  }, []);

  /** Signs a payload; resolves with the { addr, pubkey, signature, payload }
   * envelope every signed endpoint expects. */
  const sign = useCallback((payload) => getIdentity().signPayload(payload), []);
  const openIdentity = useCallback(() => setModalOpen(true), []);

  const value = useMemo(() => ({ ...state, sign, openIdentity }), [state, sign, openIdentity]);

  return (
    <IdentityContext.Provider value={value}>
      {children}
      <IdentityModal open={modalOpen} onClose={() => setModalOpen(false)} addr={state.addr} nick={state.nick} />
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity() must be used inside <IdentityProvider>');
  return ctx;
}
