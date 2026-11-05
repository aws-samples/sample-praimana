"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Shared body for App Router `error.tsx` segment boundaries. Renders a styled
 * failure state with a retry (segment `reset()`) and a link home, instead of
 * the unstyled Next.js default a thrown render/server-component error would
 * otherwise surface for an operator console (D4).
 *
 * ⚠ SANITIZATION: This component is the last line of defense before an error
 * message reaches the user's screen. It applies a client-side heuristic to
 * avoid rendering messages that look like they contain infrastructure details.
 * The primary sanitization happens server-side in `sanitize-error.ts`, but
 * this component guards against edge cases where an unsanitized message slips
 * through (e.g. a client-side error that was never routed through the server
 * sanitizer).
 */

const FALLBACK_MESSAGE = "An unexpected error occurred. Please try again later.";

/**
 * Lightweight client-side check for obviously sensitive content.
 * This is NOT the primary sanitization (that lives server-side in sanitize-error.ts),
 * but a last-resort guard for the rendering layer.
 */
function isSafeForDisplay(message: string): boolean {
  if (!message) return false;
  // ARN pattern
  if (/arn:[a-z0-9-]*:[a-z0-9-]*:/.test(message)) return false;
  // AWS account ID in context
  if (/\b\d{12}\b/.test(message) && /arn:|account/i.test(message)) return false;
  // Internal hostnames
  if (/\b[a-z0-9-]+\.(internal|local|amazonaws\.com)\b/.test(message)) return false;
  // Stack traces
  if (/\bat\s+\S+\s+\([^)]*:\d+:\d+\)/.test(message)) return false;
  // Filesystem paths
  if (/\/(usr|var|opt|etc|home|tmp)\/[^\s]+/.test(message)) return false;
  if (/webpack-internal:\/\//.test(message)) return false;
  // Very long messages are likely raw error dumps
  if (message.length > 300) return false;
  return true;
}

export function RouteError({
  error,
  reset,
  title = "Something went wrong",
  homeHref = "/experiences",
  homeLabel = "Back to experiences",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  useEffect(() => {
    // Surface the error for diagnostics; a real deployment would forward this
    // to structured logging / an error tracker (see review H5).
    console.error(error);
  }, [error]);

  const displayMessage =
    error.message && isSafeForDisplay(error.message)
      ? error.message
      : FALLBACK_MESSAGE;

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full rounded-lg border border-danger-border bg-danger-bg p-6 text-center">
        <h1 className="text-lg font-semibold text-danger-text">{title}</h1>
        <p className="mt-2 text-sm text-danger-text">
          {displayMessage}
        </p>
        {error.digest && (
          <p className="mt-1 text-xs text-danger-text">Reference: {error.digest}</p>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-md bg-danger-text-strong px-4 py-2 text-sm font-medium text-brand-ink hover:bg-danger-text-strong transition-colors"
          >
            Try again
          </button>
          <Link
            href={homeHref}
            className="rounded-md border border-danger-field-border px-4 py-2 text-sm font-medium text-danger-text hover:bg-danger-bg transition-colors"
          >
            {homeLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
