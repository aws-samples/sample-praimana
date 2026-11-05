import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full rounded-lg border p-6 text-center">
        <h1 className="text-lg font-semibold text-ink-muted">Page not found</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/experiences"
          className="mt-5 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover transition-colors"
        >
          Back to workshops
        </Link>
      </div>
    </div>
  );
}
