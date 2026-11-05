import { withHealth } from "@praimana/service-shared";
import { createUserAccessRoutes } from "./routes.js";
import {
  CognitoUserDirectory,
  DynamoAuditRepository,
  DynamoInvitationReader,
  DynamoProfileStore,
  EventBridgePublisher,
  cognitoDeadline,
  cryptoRandomBytes,
} from "./adapters.js";

/**
 * Composition root — the ONE place the AWS adapters are chosen.
 *
 * CognitoUserDirectory throws at construction when COGNITO_USER_POOL_ID is unset, and
 * that throw happens HERE, at module load (cold start), on purpose: a misconfigured
 * deploy fails loudly on the first invocation with a clear message rather than
 * answering 500s per invite with a ValidationException from deep inside the SDK.
 * Fail fast at startup on misconfiguration.
 */
const app = createUserAccessRoutes({
  directory: new CognitoUserDirectory(),
  invitations: new DynamoInvitationReader(),
  profiles: new DynamoProfileStore(),
  events: new EventBridgePublisher(),
  // The SECOND writer of the append-only audit table, alongside the team service. Its
  // record() never throws, so an audit problem degrades to `audited: false` on the
  // response rather than failing an access change that has already taken effect.
  audit: new DynamoAuditRepository(),
  random: cryptoRandomBytes,
  deadline: cognitoDeadline,
});

export default withHealth(app, "user-access");
