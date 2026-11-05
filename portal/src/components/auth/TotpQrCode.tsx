"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The QR code for TOTP enrolment, rendered client-side from the `otpauth://` URI.
 *
 * Rendered locally rather than fetched from an image service on purpose: the URI
 * contains the account's TOTP SHARED SECRET. Sending it to a third-party chart API
 * (the widespread `chart.googleapis.com/chart?cht=qr&chl=...` pattern) would hand
 * that secret, and with it the ability to generate valid MFA codes, to another
 * party and log it in their access logs. It never leaves the browser here.
 *
 * The manual-entry secret is shown alongside because a QR code is useless to
 * someone using a password manager on the same device, or a screen reader.
 */
export function TotpQrCode({
  setupUri,
  secret,
}: {
  setupUri: string;
  secret: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(setupUri, { width: 200, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        // A failed render must not block enrolment, the manual secret below is a
        // complete alternative path, so this degrades instead of dead-ending.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setupUri]);

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied or unavailable (non-HTTPS, permissions).
      // The secret is on screen and selectable, so there's nothing to recover.
    }
  }

  return (
    <div>
      <div className="flex justify-center">
        {dataUrl ? (
          // next/image can do nothing useful here: the source is an in-memory data
          // URL generated this render, so there is no remote asset to optimise,
          // resize, or cache, and routing it through the image optimiser would send
          // the TOTP secret to the server. A plain <img> is the correct element.
          //
          // The directive below must stay on the line immediately above <img>: it
          // covers exactly one line, so any prose has to go ABOVE it rather than
          // after it, or the suppression lands on a comment and does nothing.
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={dataUrl}
            // Describes the purpose, not the image: reading out a QR code's
            // contents would be meaningless, and the manual secret below is the
            // accessible path.
            alt="QR code for setting up two-factor authentication. If you can't scan it, use the setup key below."
            className="rounded-lg border border-hairline p-2 bg-surface-3"
            width={200}
            height={200}
          />
        ) : (
          <div
            className="h-[200px] w-[200px] rounded-lg border border-hairline bg-surface-1 grid place-items-center text-xs text-ink-subtle text-center px-4"
            aria-hidden={!failed}
          >
            {failed
              ? "Couldn't draw the QR code, use the setup key below instead."
              : "Preparing QR code…"}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-md bg-surface-1 border border-hairline p-3">
        <p className="text-xs font-medium text-ink-muted">
          Can&apos;t scan it? Enter this key manually:
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 break-all font-mono text-xs text-ink-muted select-all">
            {revealed ? secret : "•".repeat(Math.min(secret.length, 32))}
          </code>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="text-xs font-medium text-brand-text hover:text-brand-text-strong"
          >
            {revealed ? "Hide" : "Show"} key
          </button>
          <button
            type="button"
            onClick={copySecret}
            className="text-xs font-medium text-brand-text hover:text-brand-text-strong"
          >
            {copied ? "Copied" : "Copy key"}
          </button>
        </div>
      </div>
    </div>
  );
}
