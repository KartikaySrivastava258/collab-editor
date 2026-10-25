import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconX, IconAlert, IconCheck } from './icons.tsx';

export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }
type Push = (kind: Toast['kind'], text: string) => void;

const ToastCtx = createContext<Push>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const push = useCallback<Push>((kind, text) => {
    const id = nextId.current++;
    setToasts(t => [...t.slice(-3), { id, kind, text }]);
    if (kind !== 'error') setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-relevant="additions">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`} data-testid="toast">
            {t.kind === 'error' ? <IconAlert /> : <IconCheck />}
            <span className="toast-text">{t.text}</span>
            <button className="btn btn-ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss notification"><IconX size={14} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export interface ConfirmRequest { title: string; body: string; confirm: string; onConfirm: () => void }

/** Native <dialog> gives focus trapping, Esc to close and inert background. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (request && !d.open) d.showModal();
    if (!request && d.open) d.close();
  }, [request]);
  return (
    <dialog ref={ref} className="confirm" onClose={onClose} aria-labelledby="confirm-title">
      {request && (
        <>
          <h2 id="confirm-title">{request.title}</h2>
          <p>{request.body}</p>
          <div className="actions">
            <button className="btn" onClick={onClose} autoFocus>Cancel</button>
            <button className="btn btn-danger" onClick={() => { request.onConfirm(); onClose(); }}>{request.confirm}</button>
          </div>
        </>
      )}
    </dialog>
  );
}
