import { Link } from "@tanstack/react-router";

function NotFoundPage() {
  return (
    // Padding, not margin: a top margin collapses through <main> and pushes the
    // bordered frame down, leaving a gap in the side borders under the header.
    <div className="px-4 py-24 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        We couldn&apos;t find the page you were looking for.
      </p>
      <Link className="mt-6 inline-flex text-sm font-medium underline underline-offset-4" to="/">
        Back to tokenmaxxing.sh
      </Link>
    </div>
  );
}

export { NotFoundPage };
