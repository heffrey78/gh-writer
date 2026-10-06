import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { queryClient } from "./api.ts";
import { GlobalCommands } from "./global-commands.tsx";
import { CommandPalette } from "./palette.tsx";
import { LibraryPage } from "./library/library-page.tsx";
import { NovelPage } from "./novel/novel-page.tsx";
import { NotFound } from "./not-found.tsx";
import { apply } from "./theme.ts";
import "./styles.css";

apply();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <GlobalCommands />
        <CommandPalette />
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/novels/:novelId/*" element={<NovelPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
