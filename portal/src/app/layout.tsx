import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { headers } from "next/headers";
import { Providers } from "@/components/providers";
import { NONCE_HEADER } from "@/lib/csp";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Praimana",
  description: "Know how your team works with AI. See how your teams actually work with the assistant they already use, kept per team so a workshop becomes something you can review and repeat.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/**
 * ── ⚠ THE CSP NONCE IS READ HERE AND THAT IS WHY THIS LAYOUT IS ASYNC ─────────────────────────
 *
 * `src/middleware.ts` generates a nonce per request, puts it in the response's
 * `Content-Security-Policy` and forwards it on a request header. Reading it here is what lets Next's
 * own inline scripts, the bootstrap and the streamed flight data, carry a matching `nonce`
 * attribute, which is the whole reason `'unsafe-inline'` could be dropped from `script-src`.
 *
 * ⚠ READING `headers()` OPTS THE LAYOUT INTO DYNAMIC RENDERING, and that is a real cost, accepted
 * deliberately: every page under it is rendered per request rather than statically. This app has no
 * statically-cacheable pages to lose, every route is behind authentication and reads the session
 * (which is itself dynamic), so in practice nothing becomes dynamic that was not already.
 *
 * ⚠ NEXT READS THE NONCE OFF THE CSP HEADER ITSELF for the scripts it injects, so there is no
 * `<Script nonce=…>` to add here, passing it to `<body>`'s children is unnecessary. What IS
 * necessary is that the header exists on the response, which is the middleware's job, and that this
 * request reached the middleware at all, which is what `middleware-matcher.test.ts` pins.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;

  return (
    <html lang="en">
      <body className={inter.className}>
        {/*
          The nonce is attached to a marker so a page can find it if it ever needs to inline a script
          of its own (none do today). Rendering it as a meta tag rather than threading it through
          React context keeps it out of every component's props, and it is not secret, it is in the
          response header the browser already read.
        */}
        {nonce ? <meta property="csp-nonce" nonce={nonce} content="" /> : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
