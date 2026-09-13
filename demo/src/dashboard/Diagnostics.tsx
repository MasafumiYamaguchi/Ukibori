import { DIAGNOSTICS_PAGES, diagnosticsPage } from "./routes";
import type { DiagnosticsId } from "./routes";

/**
 * Diagnostics view: the retained standalone debug pages are embedded one at a
 * time in a same-origin iframe. The iframe isolates each page's legacy CSS and
 * DOM from the dashboard, and the legacy pages themselves are never rewritten.
 */
export function Diagnostics({ id }: { id: DiagnosticsId }) {
  const page = diagnosticsPage(id);
  return (
    <>
      <header className="dash-view-head">
        <h2>Diagnostics</h2>
        <p>
          The legacy debug pages are mounted one at a time in an isolated same-origin iframe.
          Their styles and scripts run in the embedded document, so nothing leaks into this
          dashboard. Every page stays available at its own standalone URL.
        </p>
      </header>

      <nav className="dash-subnav" aria-label="Diagnostics pages">
        {DIAGNOSTICS_PAGES.map((entry) => (
          <a
            key={entry.id}
            className="dash-subnav-link"
            href={`#diagnostics/${entry.id}`}
            aria-current={entry.id === id ? "page" : undefined}
          >
            {entry.label}
          </a>
        ))}
      </nav>

      <section className="dash-frame-panel" aria-labelledby="diag-frame-heading">
        <div className="dash-frame-head">
          <div>
            <h3 id="diag-frame-heading">{page.title}</h3>
            <p>{page.description}</p>
          </div>
          <a className="btn" href={page.page} target="_blank" rel="noreferrer">
            Open standalone
          </a>
        </div>
        <iframe key={page.id} className="dash-frame" src={page.page} title={page.frameTitle} />
      </section>
    </>
  );
}
