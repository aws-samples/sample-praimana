import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ROLE_PRECEDENCE DRIFT GATE. Six copies, one contract.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The single-role precedence order is duplicated in FIVE code locations plus the
 * Cognito group `Precedence` numbers in infra/aws/app/platform-identity.yaml. All six
 * must agree or authorization drifts, and the dangerous direction is TOWARD MORE
 * PRIVILEGE: swap JUDGE and FACILITATOR in one copy and a subject holding both groups
 * resolves to FACILITATOR at one edge and JUDGE at another. Nothing crashes. Nothing
 * logs. One edge simply hands out a privilege the other refuses.
 *
 * ⚠ WHY THIS FILE LIVES IN cognito-postconfirmation, AND IT IS NOT ARBITRARY.
 *
 *  1. This package's copy is the one that calls AdminAddUserToGroup, i.e. the one that
 *     decides which group a new account actually lands in — the highest-stakes copy,
 *     and the one with no other tests watching it.
 *  2. The other files are read as TEXT, not imported, so where this test lives is
 *     free — this package takes no dependency on `@praimana/shared`, on the team
 *     service, or on user-access, and this test adds none. It reads bytes off disk.
 *
 * ⚠ IT IS A FULL-SUITE GATE. No single package depends on all six locations, so a test
 * run scoped to "packages affected by this change" can miss an edit to one of the other
 * five files (and always misses a template-only edit). Run the whole services suite
 * before deploying.
 *
 * ⚠ NO SEVENTH COPY OF THE ARRAY IN THIS FILE. The expectation is DERIVED from one
 * designated source of truth (shared/types/user.ts) and every other
 * copy is compared to it. A literal array here would just be the drift wearing a
 * test's clothes: it would have to be edited in lockstep too, and the day someone
 * forgot, the gate would pass while the system disagreed with itself.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
/**
 * SERVICES_ROOT is `join(HERE, "..", "..")` — src/ → cognito-postconfirmation/ → services/ — and
 * every code path below is relative to it.
 *
 * ⚠ THE CODE-COPY SCAN IS SCOPED TO services/. It asserts the copies that live in this package
 * tree; portal/ and desktop/ each vendor their own `shared/types/user.ts`, which this scan does not
 * walk. So the count test below catches a NEW copy added under services/, not one added elsewhere.
 */
const SERVICES_ROOT = join(HERE, "..", "..");
/** The repository root, one level above services/ — where infra/ lives. */
const REPO_ROOT = join(SERVICES_ROOT, "..");

/** services-relative path → absolute, so failure messages read as the paths a human greps. */
const at = (p: string) => join(SERVICES_ROOT, ...p.split("/"));
/** Repository-relative path → absolute, for the CloudFormation templates under infra/. */
const atRepo = (p: string) => join(REPO_ROOT, ...p.split("/"));

/**
 * THE DESIGNATED SOURCE OF TRUTH. Chosen deliberately: it is the only copy that is
 * EXPORTED, TYPED against the `UserRole` union, and consumed by more than one
 * workspace (the portal and the desktop app both import it). The four others are
 * private constants inside bundled Lambdas. If this list is ever wrong, it is wrong
 * in the place most likely to be noticed first.
 */
const SOURCE_OF_TRUTH = {
  path: "shared/types/user.ts",
  identifier: "ROLE_PRECEDENCE",
} as const;

/**
 * The four DUPLICATES. Deliberate copies, not accidents: these are bundled Lambdas
 * that take no dependency on `@praimana/shared` (see each file's comment), so
 * the constant is re-declared rather than imported. That constraint is what makes a
 * test the remedy instead of a refactor.
 */
const DUPLICATES: readonly { path: string; identifier: string }[] = [
  {
    path: "user-access/src/domain.ts",
    identifier: "ROLE_PRECEDENCE",
  },
  {
    path: "cognito-postconfirmation/src/handler.ts",
    identifier: "ROLE_PRECEDENCE",
  },
  {
    path: "service-shared/src/edge-identity.ts",
    identifier: "ROLE_PRECEDENCE",
  },
  {
    path: "team/src/routes.ts",
    identifier: "PLATFORM_ROLE_PRECEDENCE",
  },
];

/** The template that declares the Cognito groups and their `Precedence` numbers. */
const COGNITO_TEMPLATE = "infra/aws/app/platform-identity.yaml";
/** Every template that declares a `ReleaseVersion` parameter with a default. */
const RELEASE_TEMPLATES = [
  "infra/aws/app/platform-api.yaml",
  "infra/aws/app/platform-identity.yaml",
] as const;

/** Read a repository-relative file (infra/...) as UTF-8. */
const readRepo = (path: string) => readFileSync(atRepo(path), "utf8");

/**
 * ⚠ THE INFRASTRUCTURE TEMPLATES LIVE OUTSIDE services/, under infra/aws/app/. If services/ is used
 * on its own without the infra/ folder beside it, these assertions are gated: present ⇒ assert,
 * absent ⇒ a todo naming what was missing. Never a silent pass, and never a red suite on a services
 * checkout that legitimately has no infra/.
 */
const INFRA_PRESENT = (() => {
  try {
    for (const t of new Set([COGNITO_TEMPLATE, ...RELEASE_TEMPLATES])) readRepo(t);
    return true;
  } catch {
    return false;
  }
})();


/**
 * Every code location that is expected to declare a precedence list. Used by the
 * COUNT test below: exactly these five, no more.
 */
const ALL_CODE_COPIES = [SOURCE_OF_TRUTH, ...DUPLICATES] as const;

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Matches a DECLARATION of a precedence constant, never a reference to one.
 *
 * Anchored on `const <name> ... = [` so `ROLE_PRECEDENCE.indexOf(r)`,
 * `[...ROLE_PRECEDENCE]` and prose in a comment do not match. The `[^=;]*` between
 * name and `=` absorbs a type annotation (`: readonly UserRole[]`) without being
 * able to run past a statement boundary.
 *
 * The name is `<anything>ROLE_PRECEDENCE<anything>`, with BOTH affixes optional —
 * the first draft of this pattern required a leading character and so matched
 * `PLATFORM_ROLE_PRECEDENCE` while missing all four bare `ROLE_PRECEDENCE`
 * declarations, reporting 1 copy instead of 5. Keep both quantifiers `*`.
 */
const DECLARATION =
  /(?:export\s+)?const\s+([A-Za-z0-9_]*ROLE_PRECEDENCE[A-Za-z0-9_]*)\b[^=;]*=\s*\[/g;

/**
 * The ordered role names in `identifier`'s array literal, read out of `source`.
 *
 * Throws rather than returning a fallback when the declaration is absent or
 * unparseable: a silent empty array would make two broken copies compare EQUAL and
 * turn this gate green on exactly the failure it exists to catch.
 */
function extractPrecedence(
  source: string,
  identifier: string,
  path: string
): string[] {
  const anchor = new RegExp(  // nosemgrep: detect-non-literal-regexp
    `(?:export\\s+)?const\\s+${identifier}\\b[^=;]*=\\s*\\[`
  );
  const match = anchor.exec(source);
  if (!match) {
    throw new Error(
      `${path}: no declaration of \`${identifier}\` found. Either the constant was ` +
        `renamed or the copy was removed — update ALL_CODE_COPIES in this test.`
    );
  }

  const open = match.index + match[0].length - 1;
  const close = source.indexOf("]", open);
  if (close === -1) {
    throw new Error(`${path}: \`${identifier}\` array literal is unterminated.`);
  }

  const body = source.slice(open + 1, close);
  const roles = [...body.matchAll(/["'`]([A-Z][A-Z0-9_]*)["'`]/g)].map(
    (m) => m[1]
  );
  if (roles.length === 0) {
    throw new Error(
      `${path}: \`${identifier}\` parsed to an EMPTY list from ${JSON.stringify(body)}. ` +
        `An empty list would compare equal to another empty list and hide real drift.`
    );
  }
  return roles;
}

/** Read a repo-relative file as UTF-8. */
const read = (path: string) => readFileSync(at(path), "utf8");

/** The ordered precedence declared at one code location. */
const precedenceAt = ({
  path,
  identifier,
}: {
  path: string;
  identifier: string;
}) => extractPrecedence(read(path), identifier, path);

/**
 * The Cognito group `Precedence` numbers, PARSED OUT OF THE TEMPLATE rather than
 * hardcoded, so this tracks the file instead of a memory of it.
 *
 * The resources are written on one line as flow mappings —
 *   `Properties: { GroupName: ADMIN, UserPoolId: !Ref UserPool, Precedence: 0, ... }`
 * — so a full YAML parse is unnecessary and would drag `!Ref`/`!Sub` tag handling in
 * for nothing. Order in the file is NOT trusted; the caller sorts by Precedence,
 * because Precedence is what Cognito uses and file order is cosmetic.
 */
function cognitoGroups(): { name: string; precedence: number }[] {
  const source = readRepo(COGNITO_TEMPLATE);
  const groups = [
    ...source.matchAll(
      /GroupName:\s*([A-Za-z0-9_]+)[^}\n]*?Precedence:\s*(-?\d+)/g
    ),
  ].map((m) => ({ name: m[1], precedence: Number(m[2]) }));

  if (groups.length === 0) {
    throw new Error(
      `${COGNITO_TEMPLATE}: parsed ZERO Cognito groups with a Precedence. The template's ` +
        `formatting changed and this parser went blind — fix the parser, do not ` +
        `delete the assertion.`
    );
  }
  return groups;
}

// ─── Repo scan, for the COUNT test ──────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "release",
  "test-report",
]);

/** True for a test/spec file — those legitimately reference the constant. */
const isTestFile = (name: string) => /\.(test|spec)\.tsx?$/.test(name);

/** Every non-test .ts/.tsx file under services/, services-relative, POSIX-separated. */
function sourceFiles(dir = SERVICES_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry) && !isTestFile(entry)) {
      found.push(relative(SERVICES_ROOT, full).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Every file declaring a precedence constant, found BY PATTERN rather than by
 * consulting the list above — otherwise a sixth copy in a brand-new file would be
 * invisible to the very test that exists to count copies.
 */
function declaredCopies(): { path: string; identifier: string }[] {
  const copies: { path: string; identifier: string }[] = [];
  for (const path of sourceFiles()) {
    const source = read(path);
    if (!source.includes("ROLE_PRECEDENCE")) continue;
    for (const m of source.matchAll(DECLARATION)) {
      copies.push({ path, identifier: m[1] });
    }
  }
  return copies;
}

// ════════════════════════════════════════════════════════════════════════════

describe("ROLE_PRECEDENCE has six copies and they must be byte-identical in ORDER", () => {
  it("parses the designated source of truth into a non-trivial ordered list", () => {
    // The guard on every assertion below: if THIS parse silently degraded to `[]`,
    // every comparison would trivially pass. Asserted first and explicitly.
    const truth = precedenceAt(SOURCE_OF_TRUTH);

    expect(
      truth.length,
      `${SOURCE_OF_TRUTH.path}: parsed ${truth.length} roles`
    ).toBe(5);
    expect(new Set(truth).size, `duplicate role in ${SOURCE_OF_TRUTH.path}`).toBe(
      truth.length
    );
    // Highest privilege first is the whole semantic of "lower index wins".
    expect(truth[0], `${SOURCE_OF_TRUTH.path}: most-privileged role`).toBe("ADMIN");
    expect(
      truth[truth.length - 1],
      `${SOURCE_OF_TRUTH.path}: least-privileged role`
    ).toBe("PARTICIPANT");
  });

  it.each(DUPLICATES)(
    "$path — `$identifier` matches the source of truth, SAME MEMBERS IN THE SAME ORDER",
    (copy) => {
      const truth = precedenceAt(SOURCE_OF_TRUTH);
      const actual = precedenceAt(copy);

      // ⚠ toEqual on the ARRAY, never on a Set and never after a sort. Same members
      // in a different order is still drift, and it is the MORE dangerous kind: the
      // list still validates, still resolves a role, and quietly resolves a
      // DIFFERENT one than the next service over.
      expect(
        actual,
        `DRIFT — ${copy.path} (${copy.identifier}) disagrees with ` +
          `${SOURCE_OF_TRUTH.path} (${SOURCE_OF_TRUTH.identifier}). ` +
          `Expected ${JSON.stringify(truth)}, found ${JSON.stringify(actual)}. ` +
          `All six copies must change together.`
      ).toEqual(truth);
    }
  );

  it.skipIf(!INFRA_PRESENT)("the Cognito group Precedence numbers in the template encode the SAME order", () => {
    // THE SIXTH COPY, and the one that decides the real `cognito:groups` claim. Every
    // code copy is a collapse of what THIS produced; if the template disagrees, all
    // five code copies can be perfectly consistent and still be consistently wrong.
    const truth = precedenceAt(SOURCE_OF_TRUTH);
    const groups = cognitoGroups();

    expect(
      groups.map((g) => g.name).sort(),
      `${COGNITO_TEMPLATE}: the set of Cognito groups`
    ).toEqual([...truth].sort());

    const byPrecedence = [...groups]
      .sort((a, b) => a.precedence - b.precedence)
      .map((g) => g.name);

    expect(
      byPrecedence,
      `DRIFT — ${COGNITO_TEMPLATE} orders the Cognito groups ${JSON.stringify(byPrecedence)} ` +
        `but ${SOURCE_OF_TRUTH.path} says ${JSON.stringify(truth)}. The template is ` +
        `what Cognito actually enforces, so this mismatch means every code copy ` +
        `collapses the claim differently than the pool built it.`
    ).toEqual(truth);
  });

  it.skipIf(!INFRA_PRESENT)("the Precedence numbers are contiguous from 0 with no duplicates", () => {
    // Not cosmetic. Two groups sharing a Precedence makes Cognito's tie-break
    // UNDEFINED for a user in both, so the resolved role depends on nothing the code
    // can see — and a gap means the next role inserted has no obvious slot, which is
    // exactly the "just add a role" edit that tends to introduce drift.
    const groups = cognitoGroups();
    const numbers = groups.map((g) => g.precedence).sort((a, b) => a - b);

    expect(
      numbers,
      `${COGNITO_TEMPLATE}: Precedence values, expected 0..${groups.length - 1} exactly once each`
    ).toEqual(groups.map((_, i) => i));
  });
});

describe("the COUNT of copies is itself the invariant", () => {
  it("finds EXACTLY the five known code copies and no sixth", () => {
    // Found by scanning for the DECLARATION pattern across every non-test .ts/.tsx
    // in the repo, so a copy pasted into a brand-new file fails here rather than
    // living unasserted until it drifts. If you are reading this because the test
    // went red after you added a copy: add it to DUPLICATES above so the drift
    // assertion covers it too. Do not raise the number and move on.
    const found = declaredCopies();
    const expected = ALL_CODE_COPIES.map((c) => `${c.path}#${c.identifier}`).sort();
    const actual = found.map((c) => `${c.path}#${c.identifier}`).sort();

    expect(
      actual,
      `The set of ROLE_PRECEDENCE declarations changed. Added: ` +
        `${JSON.stringify(actual.filter((a) => !expected.includes(a)))}; ` +
        `removed: ${JSON.stringify(expected.filter((e) => !actual.includes(e)))}.`
    ).toEqual(expected);

    expect(actual.length, "number of code copies of the precedence contract").toBe(5);
  });

  it("every copy it found is one this suite actually compares", () => {
    // Closes the loop between the two tests above: the count test could pass while
    // the drift test covered a different set. Every declaration found on disk must
    // appear in the list the drift assertions iterate.
    const covered = new Set(
      ALL_CODE_COPIES.map((c) => `${c.path}#${c.identifier}`)
    );
    for (const copy of declaredCopies()) {
      expect(
        covered.has(`${copy.path}#${copy.identifier}`),
        `${copy.path} declares \`${copy.identifier}\` but no drift assertion covers it`
      ).toBe(true);
    }
  });
});

// ─── ReleaseVersion defaults agree across templates ──────────────────────────

/**
 * Every template that declares a `ReleaseVersion` parameter must DEFAULT to the SAME release, and
 * that default must satisfy the parameter's own `AllowedPattern`.
 *
 * ── WHY THIS IS A SECURITY TEST, NOT A TIDINESS TEST ──
 *
 * The API stack and the identity stack each deploy Lambda code from `ReleaseVersion`. If their
 * defaults disagree, a deploy that takes the defaults runs two DIFFERENT releases side by side —
 * and it succeeds silently, because older artifacts are still in the bucket and nothing fails to
 * resolve. A stale default is not a broken deploy; it is a working deploy of the wrong code, which
 * can quietly reintroduce fixes that a later release made.
 *
 * It bites a FRESH ACCOUNT hardest (a DR rebuild, a second environment, anyone following the
 * README), because an existing stack keeps its own parameter value on update.
 *
 * ⚠ WHAT THIS DOES NOT CHECK: that the default names a release whose artifacts have actually been
 * published. That depends on your own release process, so bump the defaults in every template here
 * in the same commit that publishes a new release.
 */
describe.skipIf(!INFRA_PRESENT)("ReleaseVersion defaults agree across templates", () => {
  /**
   * The `ReleaseVersion:` parameter's own block, from its key to the next parameter (or the next
   * top-level section), so a `Default:` belonging to a neighbouring parameter cannot satisfy it.
   */
  const parameterBlock = (template: string): string => {
    const yaml = readRepo(template);
    const start = yaml.indexOf("\n  ReleaseVersion:");
    expect(start, `${template}: ReleaseVersion parameter not found — has it been renamed?`).toBeGreaterThan(-1);
    const next = /\n(?: {2}[A-Za-z0-9]+:|[A-Za-z])/g;
    next.lastIndex = start + 1;
    const end = next.exec(yaml)?.index ?? yaml.length;
    return yaml.slice(start, end);
  };

  /** The quoted `Default:` of a template's ReleaseVersion parameter. */
  const releaseDefault = (template: string): string => {
    const m = /Default:\s*"([^"]+)"/.exec(parameterBlock(template));
    expect(m, `${template}: ReleaseVersion has no quoted Default`).not.toBeNull();
    return m![1];
  };

  it.each(RELEASE_TEMPLATES)(
    "%s — the default is a well-formed version that satisfies its own AllowedPattern",
    (template) => {
      // The pattern is enforced by CloudFormation at deploy time, which is too late to be useful:
      // a malformed default fails the stack rather than the build. Assert it here instead.
      const pattern = /AllowedPattern:\s*"([^"]+)"/.exec(parameterBlock(template));
      expect(pattern, `${template}: ReleaseVersion lost its AllowedPattern`).not.toBeNull();
      // The YAML carries a doubled backslash for the escape; unescape it for JS.
      const re = new RegExp(pattern![1].replace(/\\\\/g, "\\"));  // nosemgrep: detect-non-literal-regexp
      expect(re.test(releaseDefault(template)), `${template}: ${releaseDefault(template)}`).toBe(true);
    }
  );

  it("every template defaults to the SAME release — a split default silently ships mixed code", () => {
    const defaults = Object.fromEntries(RELEASE_TEMPLATES.map((t) => [t, releaseDefault(t)]));
    expect(
      new Set(Object.values(defaults)).size,
      `ReleaseVersion defaults disagree: ${JSON.stringify(defaults)}. A deploy that takes the ` +
        `defaults would run different releases in different stacks. Update every template in the ` +
        `same commit.`
    ).toBe(1);
  });
});

/**
 * ⚠ ABSENT INFRASTRUCTURE TEMPLATES ⇒ A TODO. Reports the gap in the run summary rather than leaving
 * a lower test count for nobody to notice. Registered ONLY when the templates are missing: vitest
 * still counts an `it.todo` inside a skipped describe, which would report a false gap on a full
 * checkout.
 */
if (!INFRA_PRESENT) {
  describe("the infrastructure templates", () => {
    it.todo(
      "are checked once infra/aws/app/ (platform-identity.yaml, platform-api.yaml) is present beside services/"
    );
  });
}
