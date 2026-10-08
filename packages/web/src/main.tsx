import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { queryClient } from "./api.ts";
import { ConnectDialog } from "./github/connect.tsx";
import { GlobalCommands } from "./global-commands.tsx";
import { CommandPalette } from "./palette.tsx";
import { LibraryPage } from "./library/library-page.tsx";
import { NovelPage } from "./novel/novel-page.tsx";
import { NotFound } from "./not-found.tsx";
import { apply } from "./theme.ts";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import "./styles.css";

apply();

// The graph benchmark (#68), loaded only when visited.
const GraphBench = lazy(() => import("./graph/graph-bench.tsx").then((m) => ({ default: m.GraphBench })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <GlobalCommands />
        <CommandPalette />
        <ConnectDialog />
        <ErrorBoundary what="this page">
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route
              path="/bench/graph"
              element={
                <Suspense>
                  <GraphBench />
                </Suspense>
              }
            />
            <Route path="/novels/:novelId/*" element={<NovelPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
