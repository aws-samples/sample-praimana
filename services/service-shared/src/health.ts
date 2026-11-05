import { Hono } from "hono";
import { emitAuthDenial, emitFailClosedRefusal, UNCODED_REFUSAL } from "./metrics.js";
import { routeTemplate, scopeFromPath } from "./request-scope.js";

/**
 * Health/liveness for every service — a single source of truth so all seven
 * expose an identical, UNAUTHENTICATED `/health`.
 *
 * `withHealth(app, name)` returns a NEW root Hono that answers `/health` and then
 * delegates everything else to the wrapped service app. Because `/health` lives on
 * the root (above the service's basePath and its `edgeIdentityMiddleware`), it needs
 * no token — which is exactly what a liveness probe or the local gateway aggregator
 * wants. The wrapped app keeps its own basePath/routes untouched, so this is a
 * drop-in for both the local Node server (`app.fetch`) and Lambda (`handle(app)`).
 *
 * `uptimeSeconds` is the PROCESS uptime (`process.uptime()`); `startedAt` is when
 * this process booted — together they answer "is it up, and for how long".
 */

// Captured once at module load = process boot. process.uptime() gives the live delta.
const startedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();

export interface ServiceHealth {
  status: "ok";
  service: string;
  uptimeSeconds: number;
  startedAt: string;
  timestamp: string;
}

export function serviceHealth(service: string): ServiceHealth {
  return {
    status: "ok",
    service,
    uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
    startedAt,
    timestamp: new Date().toISOString(),
  };
}

// Hono's generics are invariant across app instances; `any` here just lets us accept
// any concrete service app. The returned root is a plain Hono, usable everywhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withHealth(app: Hono<any, any, any>, service: string): Hono {
  const root = new Hono();

  /**
   * ── ⚠ FAIL-CLOSED REFUSALS ARE COUNTED HERE, AND THIS IS WHY THIS IS THE PLACE ──────────
   *
   * Every service is wrapped by this function and every one passes its own name, so ONE insertion
   * instruments the whole platform — no per-service edit, and nothing to remember when a tenth
   * service arrives. See `emitFailClosedRefusal` for the outage this makes visible.
   *
   * ⚠ IT RUNS AFTER `next()` AND READS ONLY THE STATUS FIRST. A 503 is rare by construction, so the
   * body is cloned only on that branch — the happy path costs one integer comparison.
   *
   * ⚠ `clone()` IS MANDATORY, NOT TIDINESS. Reading `c.res.json()` directly CONSUMES the body and
   * the caller would receive an empty response — turning an observability addition into a broken
   * error path, which is the worst possible trade.
   *
   * ⚠ AND IT NEVER THROWS. A malformed or non-JSON 503 body yields `UNCODED` rather than an
   * exception: this code runs on an already-degraded request, and failing here would convert a
   * reported refusal into a 500.
   *
   * ⚠ THE WORKSHOP AND TEAM SCOPE COME FROM THE PATH, AND STAY OUT OF THE DIMENSIONS. That is what
   * answers "is the platform healthy for the workshop running right now" without minting
   * a metric series per caller-supplied id — see `emitFailClosedRefusal` for the full argument.
   */
  root.use("*", async (c, next) => {
    await next();
    const status = c.res.status;

    /**
     * ── ⚠ 401 AND 403 ARE COUNTED HERE TOO ─────────────────────────────────────────────────────────
     *
     * This middleware read `if (c.res.status !== 503) return;`, so the ONLY cross-cutting response
     * instrumentation on the platform excluded authentication failures and authorization denials BY
     * CONSTRUCTION. There is no Hono `logger()` anywhere either, so a run of 401s from token replay,
     * or a facilitator walking team ids and collecting 403s, produced no platform-visible signal at
     * all — the two event classes a security investigation starts from.
     *
     * ⚠ WHY HERE AND NOT AT THE GUARDS. Every service is wrapped by `withHealth` and passes its own
     * name, so one insertion covers all of them, including services added later. The alternative was
     * 69 edits (the count of `, 403)` sites in non-test code) plus a standing obligation to remember
     * the 70th. What the guards can say and this cannot — WHICH principal was refused WHICH resource —
     * belongs in their own log lines, and is a different question from "how many".
     *
     * ⚠ NO BODY CLONE ON THIS BRANCH, unlike the 503 one below. A denial is far more frequent than a
     * fail-closed refusal (every unauthenticated probe is one), and the `code` a clone would recover
     * is not the question being asked here — the STATUS already separates "who are you" from "you may
     * not". Reading the body on every 403 would add a clone to the cheapest refusal path on the
     * platform.
     *
     * ⚠ THE ROUTE IS TEMPLATED, NOT RAW. Several routes are keyed on an EMAIL ADDRESS, so
     * `c.req.path` would write personal data into CloudWatch on exactly the attacker-driven requests,
     * and put an unbounded caller-controlled value into a metric property. See `routeTemplate`.
     */
    if (status === 401 || status === 403) {
      emitAuthDenial({
        service,
        status,
        routePath: routeTemplate(c.req.path),
        ...scopeFromPath(c.req.path),
      });
      return;
    }

    if (status !== 503) return;
    let code = UNCODED_REFUSAL;
    try {
      const body = (await c.res.clone().json()) as { code?: unknown };
      if (typeof body?.code === "string" && body.code !== "") code = body.code;
    } catch {
      // Non-JSON or unreadable body — still a refusal, still counted.
    }
    emitFailClosedRefusal({ service, code, routePath: c.req.path, ...scopeFromPath(c.req.path) });
  });

  root.get("/health", (c) => c.json(serviceHealth(service)));
  root.route("/", app);
  return root;
}
