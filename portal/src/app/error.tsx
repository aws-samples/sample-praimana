"use client";

import { RouteError } from "@/components/ui/RouteError";

// Root-level error boundary, catches render/server-component errors anywhere
// that a more specific segment boundary doesn't already handle (D4).
export default function RootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={props.error} reset={props.reset} />;
}
