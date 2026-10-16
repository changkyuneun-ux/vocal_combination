import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./Layout.tsx";
import { routesFor } from "./routes.tsx";
import { APPS, currentApp } from "./apps.ts";
import { queryClient } from "./queryClient.ts";

export function App() {
  const kind = currentApp();
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={APPS[kind].basename}>
        <Routes>
          <Route element={<Layout />}>
            {routesFor(kind).map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
