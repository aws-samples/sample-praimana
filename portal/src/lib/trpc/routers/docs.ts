import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";

/** Latest-version pointer for a doc (mirrors the docs service DocPointer). */
type DocPointer = {
  teamId: string;
  path: string;
  workshopId: string;
  s3Key: string;
  versionId: string | null;
  lastCommitHash: string | null;
  /**
   * WHOEVER LAST WROTE THIS FILE, and it holds two different kinds of value: a Cognito sub for a
   * hand-uploaded file, a git author NAME for a synced one. `lastAuthorName` is the resolved display
   * name, present only when the id actually resolved, so a reader prefers it and falls back here.
   */
  lastAuthor: string | null;
  lastAuthorName?: string;
  updatedAt: string;
};

/** One S3 object version of a doc. */
type DocVersion = {
  versionId: string;
  lastModified: string;
  size: number;
  isLatest: boolean;
};

/**
 * Docs router, reads the versioned `.md` documents the desktop app synced to the
 * docs microservice (content + history live in S3). Mirrors the git router's shape
 * but points at the docs service's real-content endpoints (git.getFiles is
 * stats-only). backendFetch already targets the microservices gateway (:8080).
 */
export const docsRouter = router({
  // Latest-version pointers for every doc the team has synced.
  list: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/teams/${encodeURIComponent(input.teamId)}/docs`, {
        token: ctx.token,
      });
      return (data.files || []) as DocPointer[];
    }),

  // Version history (S3 object versions, newest-first) for one doc.
  versions: protectedProcedure
    .input(z.object({ teamId: z.string(), path: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/docs/versions?path=${encodeURIComponent(input.path)}`,
        { token: ctx.token }
      );
      return (data.versions || []) as DocVersion[];
    }),

  // Content of a doc, latest, or a specific versionId for history browsing.
  content: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        path: z.string(),
        versionId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const qs = new URLSearchParams({ path: input.path });
      if (input.versionId) qs.set("versionId", input.versionId);
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/docs/content?${qs.toString()}`,
        { token: ctx.token }
      );
      return data as {
        path: string;
        versionId: string | null;
        lastAuthor: string | null;
        lastAuthorName?: string;
        lastCommitHash: string | null;
        content: string;
      };
    }),
});
