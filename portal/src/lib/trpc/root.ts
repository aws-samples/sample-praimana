import { router } from "./trpc";
import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { workshopRouter } from "./routers/workshop";
import { teamRouter } from "./routers/team";
import { taskRouter } from "./routers/task";
import { messageRouter } from "./routers/message";
import { aiRouter } from "./routers/ai";
import { gitRouter } from "./routers/git";
import { docsRouter } from "./routers/docs";
import { resourcesRouter } from "./routers/resources";
import { desktopRouter } from "./routers/desktop";
import { ratingRouter } from "./routers/rating";
import { phaseRouter } from "./routers/phase";
import { submissionRouter } from "./routers/submission";
import { insightsRouter } from "./routers/insights";
import { feedbackRouter } from "./routers/feedback";
import { costRouter, healthRouter } from "./routers/health";

export const appRouter = router({
  admin: adminRouter,
  auth: authRouter,
  workshop: workshopRouter,
  team: teamRouter,
  task: taskRouter,
  message: messageRouter,
  ai: aiRouter,
  git: gitRouter,
  docs: docsRouter,
  /** Workshop-wide material the facilitator uploads; readable by every role on the experience. */
  resources: resourcesRouter,
  desktop: desktopRouter,
  rating: ratingRouter,
  phase: phaseRouter,
  // Bug reports and feedback. Filing is open to every signed-in role; the inbox is ADMIN + FACILITATOR,
  // enforced by middleware in the identity service.
  feedback: feedbackRouter,
  health: healthRouter,
  cost: costRouter,
  // Submission, judging and places. Every refusal code reaches the caller intact -
  // see the header there.
  submission: submissionRouter,
  // The experience owner's / admin's operational view, counts per team, never content, never
  // per-person. See the router header.
  insights: insightsRouter,
});

export type AppRouter = typeof appRouter;
