import { z } from "zod";

/**
 * ── THE DEVELOPER-SETUP BLOB, BOUNDED ─────────────────────────────────────────────────────────
 *
 * `workshop.create` and `workshop.update` both forward `setupConfig` verbatim into the create/PATCH
 * body. The receiving service stores it as opaque JSON and validates nothing inside it
 * (`WorkshopSetupConfig` in `lib/backend-types.ts` says so), so this schema is the only bound between
 * an authenticated caller and a stored blob that is re-served to every reader of the experience.
 *
 * ⚠ ONE FREE-TEXT FIELD. The developer setup is a single `instructions` string, natural-language
 * steps an admin/facilitator writes for the AI coding assistant to perform the initial project setup
 * on the desktop app when a participant starts working. The desktop app injects it directly into the
 * assistant's setup prompt (see `desktop/src/main/handlers/framework.ts`); there is no repo download,
 * branch, guide URL, or per-assistant override any more.
 *
 * ⚠ `.strict()`, NOT ZOD'S DEFAULT STRIP, AND THAT IS DELIBERATE. Zod strips unknown keys silently;
 * an unexpected key here is a visible refusal rather than a silent discard, so a form that still sends
 * a removed field (`repoUrl`, `branch`, `setupGuideUrl`, `assistants`) gets a 400 that names the
 * problem rather than a save that quietly changes nothing.
 */

/**
 * The ceiling on the instruction text.
 *
 * It becomes the body of an LLM prompt on the desktop (`MAX_SETUP_PROMPT_CHARS` there is the matching
 * attention bound), so it is generous for a real multi-step setup guide, tens of lines of prose and
 * commands, while refusing a payload whose only purpose is to crowd out the surrounding instructions.
 */
const MAX_SETUP_INSTRUCTIONS_CHARS = 16 * 1024;

export const workshopSetupConfigSchema = z
  .object({
    instructions: z.string().max(MAX_SETUP_INSTRUCTIONS_CHARS).optional(),
  })
  .strict();

export type WorkshopSetupConfigInput = z.infer<typeof workshopSetupConfigSchema>;
