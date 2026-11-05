import { PRODUCT_NAME } from "./BrandMark";

/**
 * A fixed year, deliberately not `new Date().getFullYear()`.
 *
 * Every page that renders this footer is a client component, so the year would be
 * computed once on the server during prerender and again in the browser at
 * hydration. Those two evaluations disagree across a New Year boundary (and
 * whenever the two clocks straddle midnight in different zones), and React
 * reports that as a hydration mismatch, an error in the console and a re-render
 * of the tree, in exchange for a digit nobody reads. Matches the same decision in
 * the email templates (the notify service's `templates.ts` BRAND_YEAR); bump
 * both together.
 */
const BRAND_YEAR = "2026";

/**
 * The standard page footer: product name and copyright, nothing else.
 *
 * It is deliberately empty of links. A footer on an internal tool earns its space
 * by closing the page and naming the product, inventing a Privacy/Terms/Contact
 * row would put three dead links in front of a user, which is worse than no
 * footer at all. Add a link here only when there is a real destination for it.
 *
 * Takes no props on purpose: "standard" means every page's footer is byte-for-byte
 * the same footer, so a per-page override is the drift this component exists to
 * end.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-hairline px-6 py-5 text-center text-xs text-ink-subtle">
      {/* One text node, so there is no chance of the name and the year wrapping
          apart onto separate lines on a narrow viewport. */}
      <p>
        &copy; {BRAND_YEAR} {PRODUCT_NAME}
      </p>
    </footer>
  );
}
