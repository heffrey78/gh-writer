import { Link } from "react-router";
import { Shell } from "./layout.tsx";

export function NotFound() {
  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Nothing here</h1>
      <p className="mt-2 text-muted">
        This page doesn't exist. <Link to="/" className="text-accent underline">Back to your novels</Link>
      </p>
    </Shell>
  );
}
