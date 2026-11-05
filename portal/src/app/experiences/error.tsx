"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function WorkshopsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={props.error} reset={props.reset} title="Couldn't load workshops" />;
}
