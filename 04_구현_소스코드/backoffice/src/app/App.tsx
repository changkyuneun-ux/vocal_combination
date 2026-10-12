import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./Layout.tsx";
import { routes } from "./routes.tsx";
import { queryClient } from "./queryClient.ts";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            {routes.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
