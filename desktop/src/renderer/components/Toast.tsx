import { createContext, useContext, useState, useCallback, useMemo, useRef, ReactNode } from "react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  /** Show a toast. Returns the toast id (useful for manual dismissal). */
  show: (message: string, kind?: ToastKind, durationMs?: number) => string;
  success: (message: string, durationMs?: number) => string;
  error: (message: string, durationMs?: number) => string;
  info: (message: string, durationMs?: number) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Consistent, non-blocking feedback for success/error/info. Replaces the mix of
 * silent failures and inline-only errors across the app. Wrap the app once in
 * <ToastProvider> and call useToast() anywhere below it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = "info", durationMs = 4000) => {
      const id = `t${++idRef.current}`;
      setToasts((prev) => [...prev, { id, kind, message }]);
      if (durationMs > 0) {
        setTimeout(() => dismiss(id), durationMs);
      }
      return id;
    },
    [dismiss]
  );

  const success = useCallback((m: string, d?: number) => show(m, "success", d), [show]);
  const error = useCallback((m: string, d?: number) => show(m, "error", d ?? 6000), [show]);
  const info = useCallback((m: string, d?: number) => show(m, "info", d), [show]);

  /**
   * MEMOISED, and the inline literal it replaces was a real bug rather than a style nit.
   *
   * `value={{ show, success, ... }}` builds a NEW object on every provider render, and this
   * provider re-renders whenever any toast anywhere appears or expires. So every consumer's
   * `useToast()` result changed identity on an unrelated toast — and any consumer listing it in a
   * dependency array re-ran that effect. The file tree found it the hard way: its mount effect
   * resets expanded folders, the cached listings and the cut/copy clipboard, so one background
   * toast would have collapsed the whole tree and dropped a pending cut.
   *
   * Every function here is already `useCallback`-stable, so the only thing that churned was the
   * wrapper. One `useMemo` fixes it for every consumer instead of each one holding a ref.
   */
  const value = useMemo(
    () => ({ show, success, error, info, dismiss }),
    [show, success, error, info, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

const KIND_STYLES: Record<ToastKind, { bar: string; icon: string }> = {
  success: { bar: "border-l-emerald-500", icon: "✓" },
  error: { bar: "border-l-rose-500", icon: "⚠" },
  info: { bar: "border-l-blue-500", icon: "ℹ" },
};

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => {
        const style = KIND_STYLES[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={`flex items-start gap-2.5 rounded-md border border-surface-line border-l-4 ${style.bar} bg-white px-3.5 py-2.5 shadow-lg animate-[fadeIn_0.15s_ease-out]`}
          >
            <span className="text-sm leading-5 flex-shrink-0 text-surface-faint">{style.icon}</span>
            <span className="text-sm text-surface-text leading-5 flex-1">{t.message}</span>
            <button
              onClick={() => onDismiss(t.id)}
              className="text-surface-muted hover:text-surface-muted text-sm leading-5 flex-shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
