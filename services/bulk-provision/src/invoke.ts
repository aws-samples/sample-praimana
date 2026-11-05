// ── CALLING A SERVICE BY DIRECT LAMBDA INVOCATION ────────────────────────────────────────
//
// ⚠ THE IMPLEMENTATION MOVED TO `@praimana/service-shared`. It is re-exported here so this
// worker's call sites and tests keep one import path — but there is now exactly ONE copy of it.
//
// It moved because the worker was not the only caller that needs it, and discovering the second one
// cost a failed upload. The worker invokes Team with no bearer token (IAM is the credential); Team
// then has to ask Workshop "does this facilitator own workshop W?" — and had only an HTTP client
// pointed at the public gateway URL, which 401s anything tokenless. So hop 1 was authenticated and
// hop 2 was not, `ownsWorkshop` fail-closed as designed, and all three teams in the file were refused
// with "only the workshop owner can create teams" while the facilitator did in fact own it.
//
// Duplicating the transport into Team would have meant two `buildGatewayEvent`s free to drift on the
// one detail that matters most — the claim shape path 1 trusts without verifying. Hence one copy.
//
// See the services' shared `service-invoke` module for the full reasoning: why no shared secret is
// involved, and why `Invoke` succeeding does not mean the target succeeded.

export {
  buildGatewayEvent,
  callService,
  lambdaClient,
  setLambdaClient,
  ServiceInvokeError,
  type CallerIdentity,
  type InvokeOptions,
  type ServiceResponse,
} from "@praimana/service-shared";
