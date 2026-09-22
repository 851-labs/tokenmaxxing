import { Link } from "@tanstack/react-router";

function NotFoundPage() {
  return (
    <div className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn&apos;t find the page you were looking for.
      </p>
      <Link className="mt-6 inline-flex text-sm font-medium underline underline-offset-4" to="/">
        Back to tokenmaxxing.sh
      </Link>
    </div>
  );
}

export { NotFoundPage };
