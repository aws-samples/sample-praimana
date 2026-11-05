import Image from "next/image";
import Link from "next/link";

/**
 * The product name, in ONE place.
 *
 * Eight screens rendered this string inline, and the set had already drifted:
 * three type sizes, two colours, and, on the auth screens and the email layout -
 * a placeholder "A" tile standing in for a logo that exists. Every one of those
 * was a separate edit to keep in step, which is exactly why they weren't.
 */
export const PRODUCT_NAME = "Praimana";

/**
 * The tagline under the wordmark in the portal header.
 *
 * ⚠ IT SAYS WHAT THE PRODUCT IS FOR, WHICH THE NAME DOES NOT. "Praimana" is a coined name and names no
 * category at all; the point of this platform is that a team learns to work WITH an AI assistant, and that
 * the assessment is of the team rather than of individuals. Seven words is the ceiling that keeps
 * it from wrapping in the dense workspace header.
 */
export const PRODUCT_TAGLINE = "Know how your team works with AI";

/**
 * The canonical logo. `public/icon-192.png` is the 192px downscale of
 * `icons/icon_ai_human_collab.png`, the same artwork the desktop app icon and
 * every favicon size already use. Named once here so a re-brand is one edit and
 * cannot leave a screen behind.
 */
const MARK_SRC = "/icon-192.png";

/**
 * Fixed geometry, two sizes, no third.
 *
 * The pixel values live here rather than at the call sites for two reasons: every
 * mark in the product is then provably one of two sizes, and the <Image> always
 * gets an explicit width/height. A logo that has no reserved box reflows the
 * header the moment it decodes, a layout shift under a pointer that is already
 * travelling towards the button next to it.
 */
const SIZES = {
  // Dense app chrome (the team workspace top bar) and the auth card's brand line.
  sm: { px: 24, radius: "rounded-md", gap: "gap-2", wordmark: "text-base font-semibold", tagline: "text-[10px]" },
  // The standard page header.
  md: { px: 32, radius: "rounded-lg", gap: "gap-2.5", wordmark: "text-xl font-bold", tagline: "text-xs" },
} as const;

const TONES = {
  // What the seven page headers already used.
  brand: "text-brand-text",
  // The auth screens deliberately keep the brand line neutral so the card's own
  // <h1> ("Sign in", "Create your account") stays the loudest thing on screen.
  neutral: "text-ink",
} as const;

/**
 * The canonical brand mark: logo, optionally with the wordmark beside it.
 *
 * `alt` is decided in here and is NOT a prop, because the rule is easy to get
 * wrong in both directions. When the wordmark renders, the product name is
 * already in the accessible name and the image is purely decorative, so it takes
 * `alt=""` and drops out of the accessibility tree, rather than making a screen
 * reader announce "Praimana logo, Praimana". When
 * the wordmark is suppressed, the image is the only thing naming the product and
 * gets real alt text. Same component, opposite treatment, no call site left to
 * decide it.
 */
export function BrandMark({
  size = "md",
  wordmark = true,
  tagline = false,
  tone = "brand",
  as = "span",
  href,
  priority = false,
}: {
  size?: keyof typeof SIZES;
  /** Render the product name beside the logo. Drives the alt-text rule above. */
  wordmark?: boolean;
  /**
   * Render PRODUCT_TAGLINE under the wordmark. OFF by default, and opt-in rather than automatic for two
   * reasons: the auth screens deliberately keep the brand line quiet so the card's own <h1> stays the
   * loudest thing on screen, and a second line under a 24px mark in the dense workspace bar is a taller
   * header on the screen with the least room to spare.
   *
   * Requires `wordmark`, a tagline on its own is a fragment with nothing to qualify.
   */
  tagline?: boolean;
  tone?: keyof typeof TONES;
  /**
   * Element for the wordmark. Pass "h1" on the screens where the product name IS
   * the page heading, otherwise moving the wordmark into this component would
   * silently delete their <h1> and leave an <h2> as the first heading.
   */
  as?: "h1" | "span";
  /** When set, the whole mark becomes a link here (usually home). */
  href?: string;
  /** Above the fold. Every current call site is a page header, so all pass it. */
  priority?: boolean;
}) {
  const s = SIZES[size];
  const Wordmark = as;

  const content = (
    <>
      <Image
        src={MARK_SRC}
        alt={wordmark ? "" : PRODUCT_NAME}
        width={s.px}
        height={s.px}
        // shrink-0 so a wide wordmark, or a narrow viewport, can never squeeze the
        // logo's box and change its aspect ratio.
        className={`shrink-0 ${s.radius}`}
        priority={priority}
      />
      {wordmark &&
        (tagline ? (
          /**
           * ⚠ THE EXTRA COLUMN EXISTS ONLY WHEN THERE IS A TAGLINE. Wrapping the wordmark unconditionally
           * would be tidier code and a visual diff on all seven headers that do not use one, `leading-tight`
           * changes the wordmark's line box, so "no tagline" must keep rendering exactly what it rendered
           * before.
           */
          <span className="flex flex-col leading-tight">
            <Wordmark className={`${s.wordmark} ${TONES[tone]}`}>{PRODUCT_NAME}</Wordmark>
            {/*
              ⚠ `aria-hidden` IS LOAD-BEARING, and this is the non-obvious part of adding a tagline.

              When `href` is set the whole mark is a LINK, and a link's accessible name is its text content -
              so without this, every page header would announce "Praimana Know how your team works
              with AI, link". The tagline is decorative repetition of what the page already says; hiding it from
              the accessibility tree keeps the link's name the product name.

              `hidden sm:block` for the same reason in the visual dimension: on a narrow viewport the header
              has a brand and a profile menu to fit, and the tagline is the part that can go.
            */}
            <span aria-hidden="true" className={`hidden sm:block ${s.tagline} text-ink-subtle`}>
              {PRODUCT_TAGLINE}
            </span>
          </span>
        ) : (
          <Wordmark className={`${s.wordmark} ${TONES[tone]}`}>{PRODUCT_NAME}</Wordmark>
        ))}
    </>
  );

  const row = `flex items-center ${s.gap}`;

  // No aria-label on the link: the content already supplies its accessible name
  // (the wordmark text, or the image's alt when there is no wordmark). Adding one
  // would override that and give two sources of truth for the same string.
  return href ? (
    <Link href={href} className={row}>
      {content}
    </Link>
  ) : (
    <div className={row}>{content}</div>
  );
}
