import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { PRODUCT_NAME } from "@/components/BrandMark";

/**
 * ── HOW THIS PLATFORM WORKS, the page there was no answer on ────────────────────────────────
 *
 * A "How it works" documentation link in the menu, explaining how the platform works,
 * visible to EVERY signed-in role (chosen deliberately over staff-only).
 *
 * ── ⚠ WHY EVERYONE AND NOT JUST STAFF ──
 *
 * The obvious instinct is to put documentation behind the staff gate with the other management screens. It
 * is the wrong instinct here: PARTICIPANTS are the people most likely to ask how this works. They install a
 * desktop app, work in phases they did not design, sync files to a place they cannot see, and are judged by
 * a process nobody has explained to them. Staff-only docs would leave the largest and least-informed
 * audience with nothing.
 *
 * ── ⚠ WHAT THIS PAGE IS *NOT* ──
 *
 * Not a feature tour, and not a list of screens. Both go stale the week after they are written, and neither
 * answers the questions people actually ask. What is written here is the MODEL, who does what, what is
 * fixed and why, where things are stored, and which rules will refuse you. Every section exists because it
 * corresponds to a rule enforced in code, so a change to the product is a change to a rule, and a stale
 * sentence here is a real inconsistency rather than a cosmetic one.
 *
 * ⚠ NUMBERS AND NAMES ARE NOT HARDCODED WHERE A CONSTANT EXISTS. The phase pipeline and the first-phase
 * word floor are imported, so this page cannot drift from the behaviour it describes, which is exactly how
 * "Add a description in Settings" ended up telling people to do something impossible.
 *
 * ── A SERVER COMPONENT, DELIBERATELY ──
 *
 * No hooks, no session read, no data. It is prose plus two imported constants, so it renders on the server
 * and ships no JavaScript of its own. The header and footer are the client components that already declare
 * themselves.
 */
import {
  FEEDBACK_MESSAGE_BOUNDS,
  FEEDBACK_SUBJECT_BOUNDS,
  FIXED_PHASE_PIPELINE,
  MIN_FIRST_PHASE_WORDS,
} from "@praimana/shared";

export const metadata = {
  title: `How it works · ${PRODUCT_NAME}`,
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

export default function HowItWorksPage() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <AppHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-bold text-ink">How it works</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          What {PRODUCT_NAME} is for, who does what, and the rules that will and won&apos;t let you
          proceed.
        </p>

        <Section title="The short version">
          <p>
            An <strong>experience</strong> is a time-boxed event. People join it in <strong>teams</strong>.
            Each team works through three phases with an AI assistant, produces files and a demo, and an{" "}
            <strong>executive</strong> on the team hands that work to <strong>judges</strong>, who score it.
            Places are published at the end.
          </p>
          <p>
            The point is not the software you ship. It is <em>how well you work with an AI assistant</em>,
            which is what the phases, the transcripts and the scoring are all shaped around.
          </p>
        </Section>

        <Section title="The five roles">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Participant</strong>: does the work. Uses the desktop app with their own AI
              assistant, writes phase notes, syncs files.
            </li>
            <li>
              <strong>Executive</strong>: is on a team and is the only person who can fill in and{" "}
              <strong>submit</strong> the team&apos;s demo. Also the only role besides a participant that
              can sign in to the desktop app.
            </li>
            <li>
              <strong>Judge</strong>: reads released submissions and scores them. Sees nothing before
              release.
            </li>
            <li>
              <strong>Facilitator</strong>: runs an experience: advances the phase everyone is on, invites
              people, publishes results.
            </li>
            <li>
              <strong>Admin</strong>: everything a facilitator can do, plus managing accounts across the
              platform.
            </li>
          </ul>
        </Section>

        <Section title="The three phases, and why you cannot change them">
          <p>Every experience runs the same pipeline:</p>
          <ol className="space-y-2">
            {FIXED_PHASE_PIPELINE.map((phase, i) => (
              <li key={phase.name} className="rounded-lg border bg-surface-1 p-3">
                <span className="text-xs text-ink-tertiary">Phase {i + 1}</span>
                <p className="font-medium text-ink">{phase.name}</p>
                <p className="text-sm text-ink-subtle">{phase.description}</p>
              </li>
            ))}
          </ol>
          <p>
            They are <strong>fixed</strong>: they cannot be renamed, reordered or removed, and that is
            deliberate rather than a limitation. Your team&apos;s notes are attached to a specific phase, and
            a released submission records the phases as they were at that moment; renaming one afterwards
            would detach work from the phase it belongs to.
          </p>
          <p>
            The phase everyone is <em>on</em> is set by the facilitator and moves for the whole experience at
            once. You can look ahead at a later phase at any time.
          </p>
          <p className="rounded-lg border border-warn-border bg-warn-bg p-3">
            <strong>One rule to know:</strong> the later phases stay read-only until{" "}
            {FIXED_PHASE_PIPELINE[0]?.name ?? "the first phase"} has at least {MIN_FIRST_PHASE_WORDS} words
            of notes. Think first, then build. The desktop app shows a live word count while you write.
          </p>
        </Section>

        <Section title="The desktop app, and who needs it">
          <p>
            The desktop app is where the work happens. It runs your own AI assistant on your own machine, so
            your code and your conversations stay local until you choose to share them, and it syncs the
            files you pick into your team&apos;s workspace.
          </p>
          <p>
            It is for <strong>participants and executives</strong>. Facilitators, judges and admins work
            entirely in the browser and cannot sign in to it; there would be nothing there for them.
          </p>
          <p>
            You do not have to install it. Everything your team produces is visible in the browser: the
            board, the transcripts, the phase notes and the files. The desktop app is how you produce it, not
            how you read it.
          </p>
        </Section>

        <Section title="Files: what gets shared, and what does not">
          <p>
            Nothing leaves your machine automatically. In the desktop app you choose files from your
            repository, or upload them by hand, and only those are stored.
          </p>
          <p>
            Every version is kept, so a file&apos;s history is visible to your team. Removing a file takes it
            off your team&apos;s list; the stored versions are retained, so a mistaken removal is
            recoverable.
          </p>
          <p>
            Your team&apos;s files and chat are <strong>member-only</strong>. A facilitator can see that your
            team exists and how active it is, but not read its content, and a judge sees only what your
            executive releases.
          </p>
        </Section>

        <Section title="Submitting: what has to be true first">
          <p>
            An <strong>executive on your team</strong> fills in the demo details and submits. Two things must
            be true before a submission can go to the judges, and both are checked when it happens:
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>At least one file has been uploaded.</strong> You will also find that the demo link
              cannot be saved before that, because the link is a claim that there is something to look at.
            </li>
            <li>
              <strong>A demo link starting with https://.</strong> It is handed to judges, so it has to be
              something they can open safely.
            </li>
          </ul>
          <p>
            Submitting takes a <strong>snapshot</strong>. Judges read your phase notes and file list as they
            were at that moment, so carrying on working afterwards cannot change what is being judged, and
            cannot be used to change it after a score has been given.
          </p>
        </Section>

        <Section title="Judging and results">
          <p>
            Judges score each released submission on five criteria (innovation, execution, AI usage, impact
            and presentation) from 1 to 10, weighted equally. A judge scoring the same team twice replaces
            their earlier score rather than adding a second one.
          </p>
          <p>
            Places are computed from the average and published by whoever runs the experience. Publishing is
            refused if the scores are uneven, for example if one team has been scored by three judges and
            another by one, because a ranking built on unequal coverage is not a ranking. A partial result
            is never shown.
          </p>
          <p className="text-ink-subtle">
            There is no leaderboard of individuals, and there never will be. Assessment is about the team and
            about how it worked, not about ranking teammates against each other.
          </p>
        </Section>

        <Section title="Something wrong, or an idea?">
          <p>
            Use <strong>Report a bug</strong> or <strong>Give feedback</strong> in the menu under your name.
            Reports go straight to the people running the platform, with the page you were on already
            attached, so you do not have to explain where you were.
          </p>
          {/*
            ⚠ THE FLOORS ARE DOCUMENTED, AND THE NUMBERS ARE IMPORTED. A minimum is the part of that form
            people meet unexpectedly, so saying it here as well as in the form costs nothing and answers the
            question before it is asked. Read from the shared bounds so this page cannot claim a limit the
            form does not enforce.
          */}
          <p>
            A report needs a subject of {FEEDBACK_SUBJECT_BOUNDS.minWords}–
            {FEEDBACK_SUBJECT_BOUNDS.maxWords} words and a description of{" "}
            {FEEDBACK_MESSAGE_BOUNDS.minWords}–{FEEDBACK_MESSAGE_BOUNDS.maxWords} words. The minimum is
            there because a one-line report usually costs somebody a reply asking what happened; say what
            you expected as well as what you saw and you will be past it without trying.
          </p>
        </Section>

        <p className="mt-10 text-sm">
          <Link href="/" className="text-brand-text hover:underline">
            ← Back to the platform
          </Link>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
