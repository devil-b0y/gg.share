'use client';

// Transient status message at the bottom of the screen.
//
//   const toast = useToast();
//   toast('Posted');
//
// One toast at a time: a new message replaces the current one.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastContext = createContext(() => {});

const DEFAULT_DURATION_MS = 2600;

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null); // { id, message }
  const timer = useRef(null);

  const show = useCallback((message, ms = DEFAULT_DURATION_MS) => {
    clearTimeout(timer.current);
    // A fresh id restarts the entry animation even for a repeated message.
    setToast({ id: Date.now(), message });
    timer.current = setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <div key={toast.id} className="toast" role="status">{toast.message}</div>}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
