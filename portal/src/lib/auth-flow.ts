/**
 * ⚠ MOVED TO `@praimana/shared`. This file is a RE-EXPORT, not an implementation.
 *
 * The desktop's sign-in form uses the same state machine, and the reason it must be one copy
 * rather than two is recorded alongside it: `authErrorMessage` collapses `UserNotFoundException`
 * and `NotAuthorizedException` into a single string, which is an ACCOUNT-ENUMERATION control. Two
 * copies is how one of them gets "improved" into leaking which addresses are registered.
 *
 * Kept as a re-export rather than deleted so the portal's ~20 existing import sites stay
 * valid; new code should import from `@praimana/shared` directly.
 */
export * from "@praimana/shared";
