/**
 * Shared body for App Router `loading.tsx` segment boundaries, a centered
 * pulse shown while a server component or the initial route data resolves (D4).
 */
export function LoadingScreen({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-ink-tertiary text-sm">{label}</div>
    </div>
  );
}
