import { useMemo, useSyncExternalStore } from "react";
import { CoverageIndex } from "./dashboard/CoverageIndex";
import { Diagnostics } from "./dashboard/Diagnostics";
import { FeatureLab } from "./dashboard/FeatureLab";
import { Playground } from "./dashboard/Playground";
import { Product } from "./dashboard/Product";
import type { DashboardRoute } from "./dashboard/routes";
import { parseDashboardHash } from "./dashboard/routes";

/**
 * Demo dashboard shell.
 *
 * The URL hash selects exactly one view:
 *   #playground, #features, #diagnostics/<id>, #product
 *
 * An empty or invalid hash safely shows the Playground. Navigation uses real
 * links (so direct loads and back/forward work) and marks the active entry
 * with aria-current="page" — no fake tab ARIA. Only the active heavy panel
 * (its provider or its iframe) stays mounted, so switching views may reset
 * local state by design.
 */

const NAV_ITEMS = [
  { hash: "#playground", label: "Playground", view: "playground" },
  { hash: "#features", label: "Feature lab", view: "features" },
  { hash: "#diagnostics/renderer", label: "Diagnostics", view: "diagnostics" },
  { hash: "#product", label: "Product", view: "product" },
] as const;

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHash(): string {
  return window.location.hash;
}

function readServerHash(): string {
  return "";
}

function useDashboardRoute(): DashboardRoute {
  const hash = useSyncExternalStore(subscribeToHash, readHash, readServerHash);
  return useMemo(() => parseDashboardHash(hash), [hash]);
}

export function App() {
  const route = useDashboardRoute();
  return (
    <div className="dashboard">
      <header className="dash-header">
        <p className="dash-kicker">Ukibori 浮彫 · physically informed 2.5D UI layer</p>
        <h1>Ukibori demo dashboard</h1>
        <p className="dash-lede">
          One entry point for the physical renderer: the React playground, a public-API feature
          lab, the retained diagnostics pages and the product showcase. The URL hash selects one
          view at a time, and only that view — plus its provider or iframe — stays mounted.
        </p>
        <nav className="dash-nav" aria-label="Dashboard sections">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.hash}
              className="dash-nav-link"
              href={item.hash}
              aria-current={route.view === item.view ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="dash-main" id="dashboard-main">
        {route.view === "playground" ? <Playground /> : null}
        {route.view === "features" ? <FeatureLab /> : null}
        {route.view === "diagnostics" ? <Diagnostics id={route.id} /> : null}
        {route.view === "product" ? <Product /> : null}
        <CoverageIndex />
      </main>

      <footer className="dash-footer">
        <p>
          Hash routes: <code>#playground</code>, <code>#features</code>,{" "}
          <code>#diagnostics/&lt;id&gt;</code>, <code>#product</code>. An empty or unknown hash
          shows the Playground. Legacy standalone pages stay available at their own URLs.
        </p>
      </footer>
    </div>
  );
}
