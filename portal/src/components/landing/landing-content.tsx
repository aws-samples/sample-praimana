/**
 * ── THE LANDING PAGE'S CONTENT, SHARED BY TWO ROUTES ────────────────────────────────────────
 *
 * `/` and `/login` render the same hero and the same three pillars: the difference between them
 * is only whether the sign-in panel starts open. Before this file existed the markup lived in
 * `app/page.tsx`, so `/login` had no way to show it without a copy, and a copy of a hero is a
 * copy that goes stale the first time someone edits one of them.
 *
 * ⚠ NO "use client" HERE, DELIBERATELY. This is static copy and inline SVG. Keeping it out of
 * the client bundle means the hero is server-rendered on both routes and only the panel's
 * reveal logic ships as JavaScript.
 */

/**
 * ── ⚠ THE THREE PILLARS, AS DATA AND WITHOUT EMOJI ──────────────────────────────────────────
 *
 * These were three hand-repeated `<div>`s, each opening with an emoji in a `text-2xl` div: 🎯,
 * 🤖, 👥. Emoji are the wrong instrument for product iconography for reasons that have nothing
 * to do with taste:
 *
 *   1. THEY ARE FONT DATA, RENDERED BY THE OS. The same three characters are flat pictograms on
 *      Windows, glossy on macOS, outlined on Android, and a dotted box on a Linux server
 *      screenshot. A brand cannot be consistent through a glyph it does not ship.
 *   2. SCREEN READERS ANNOUNCE THEM. "direct hit", "robot face", "busts in silhouette" get read
 *      out before each heading, three pieces of noise, describing decoration.
 *   3. THEY DO NOT INHERIT. `currentColor`, stroke weight and optical size all pass an emoji by,
 *      so it cannot be tuned to sit with the type around it.
 *
 * Replaced with inline SVG at a single 1.5px stroke weight, drawn from `--ink-subtle` so the
 * marks recede behind the headings rather than competing with them. Inline rather than an icon
 * package because three glyphs do not justify a dependency, and the CSP here forbids remote
 * sprite sheets.
 */
const PILLARS = [
  {
    title: "Structured phases",
    body: "Problem, ideation, architecture, build, demo. Each phase has its own workspace and its own definition of done.",
    /** A route between waypoints: the phase progression, not a target. */
    icon: (
      <>
        <path d="M4 17.5c3-6 6.5-6 9-3s5 2 6-2" />
        <circle cx="4" cy="17.5" r="1.6" />
        <circle cx="19" cy="12.5" r="1.6" />
      </>
    ),
  },
  {
    title: "AI at every stage",
    body: "Bring your own assistant: Claude, Kiro, Codex and more. The platform captures what you build with it, rather than replacing it.",
    /** A spark, not a robot face. Assistance, not a machine. */
    icon: (
      <>
        <path d="M12 3.5v3.2M12 17.3v3.2M4.6 12h3.2M16.2 12h3.2" />
        <path d="M6.8 6.8l2.2 2.2M15 15l2.2 2.2M17.2 6.8L15 9M9 15l-2.2 2.2" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    ),
  },
  {
    /* "Work", not "Built".
       The page headline is "See how your teams actually work with AI" and the brand
       tagline is "Know how your team works with AI", both lead on the work itself, not
       on building. "Built as a team" breaks that voice: it is a past participle describing
       something that already happened to somebody else, which on a page whose whole job is
       to get a visitor to start is the wrong tense to end on. "Work as one team" is the
       same promise in the reader's own present, and it matches the card's body. */
    title: "Work as one team",
    body: "Chat, a shared board and live presence, so a cross-functional team of five works as one rather than five.",
    /** Three connected nodes: a team as a graph, not as a row of avatars. */
    icon: (
      <>
        <circle cx="12" cy="5.5" r="2.2" />
        <circle cx="5.5" cy="17" r="2.2" />
        <circle cx="18.5" cy="17" r="2.2" />
        <path d="M10.4 7.4 7.1 15.1M13.6 7.4l3.3 7.7M7.7 17h8.6" />
      </>
    ),
  },
] as const;

export function LandingHero() {
  return (
<div className="text-center">
      {/* ⚠ ONE eyebrow on the page, and this is it. The rule of thumb is at most one
          per three sections; this page has two sections, so the pillars below get
          none. */}
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-subtle">
        Praimana
      </p>

      {/* Sentence case, not Title Case. "See How Your Teams Actually Work With AI"
          would capitalise for emphasis and get none: Title Case flattens a
          sentence into a label. The tight tracking is doing the work instead, and at
          this size it is most of what separates a considered headline from default
          Inter. `text-balance` keeps the two lines close to even rather than leaving
          one word stranded. */}
      <h2 className="mt-2 text-4xl font-semibold tracking-display-tight text-balance sm:text-5xl">
        See how your teams actually work with AI
      </h2>

      {/* Capped at ~62 characters per line. The original ran the full container width,
          roughly 90 characters, well past the point where the eye loses the line it
          is returning to. */}
      <p className="w-full mx-auto mt-3 max-w-[34rem] text-lg leading-relaxed text-ink-subtle text-pretty">
        A workspace for the teams and a window for whoever is running it.
        Transcripts, artefacts, phase timings and consumption, kept per team, so a
        workshop becomes something you can review and repeat.
      </p>
    </div>
  );
}

export function LandingPillars() {
  return (
/* ⚠ NOT THREE EQUAL COLUMNS, AND ⚠ NOT A GRID WITH A HOLE IN IT EITHER.
       `sm:grid-cols-3` gave three identical cards of identical weight, the single most
       recognisable AI-generated layout, and it flattened the pillars into a list of
       peers when the first is the frame the other two operate inside.

       The first attempt at fixing that was a 3-column track with a `col-span-2` lead,
       which is 2 + 1 + 1 = FOUR cells in a three-wide grid: two rows, with the last
       cell empty. It rendered as a grey rectangle in the bottom-right corner, because
       the wrapper's hairline background shows through wherever no `<li>` covers it.

       Three items therefore want a TWO-column track: the lead spans both on row one,
       the remaining two sit side by side on row two. No empty cell is possible.

       MOBILE COLLAPSE: single column, spans reset, same hairline gaps. */
    <ul className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:mt-8 sm:grid-cols-2">
      {PILLARS.map((pillar, i) => (
        <li
          key={pillar.title}
          className={`bg-canvas p-4 sm:p-5 ${i === 0 ? "sm:col-span-2" : "sm:col-span-1"}`}
        >
          {/* `gap-px` on a hairline-coloured grid draws the dividers as the gaps
              themselves, so there is exactly one rule between any two cells and no
              doubled borders where cells meet. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-5 w-5 text-ink-subtle"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {pillar.icon}
          </svg>
          <h3 className="mt-3 font-medium tracking-title-tight">{pillar.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-subtle text-pretty">
            {pillar.body}
          </p>
        </li>
      ))}
    </ul>
  );
}
