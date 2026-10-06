import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, keys } from "../api.ts";
import { Shell } from "../layout.tsx";
import { ErrorAlert } from "../ui/alert.tsx";

interface NovelModel {
  config?: { title?: string };
}

/** A novel's workspace. */
export function NovelPage() {
  const { novelId = "" } = useParams();
  const novel = useQuery({ queryKey: keys.novel(novelId), queryFn: () => api.novel<NovelModel>(novelId) });
  return (
    <Shell>
      {novel.isPending ? (
        <h1 className="text-2xl font-semibold text-muted" aria-busy="true">
          Opening…
        </h1>
      ) : novel.isError ? (
        <>
          <h1 className="text-2xl font-semibold">Couldn't open this novel</h1>
          <ErrorAlert title={novel.error.message} className="mt-4">
            <Link to="/" className="text-accent underline">
              Back to your novels
            </Link>
          </ErrorAlert>
        </>
      ) : (
        <h1 className="text-2xl font-semibold">{novel.data.novel.config?.title ?? "Untitled"}</h1>
      )}
    </Shell>
  );
}
