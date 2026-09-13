/**
 * Product view: the retained neumorphism showcase is embedded in a
 * same-origin iframe so its legacy CSS cannot leak into the dashboard. The
 * standalone page itself is never rewritten.
 */
export function Product() {
  return (
    <>
      <header className="dash-view-head">
        <h2>Product</h2>
        <p>
          The neumorphism wellness dashboard is the product-flavored showcase built on the
          physical layer. It is mounted here in an isolated same-origin iframe and remains
          available at its own standalone URL.
        </p>
      </header>

      <section className="dash-frame-panel" aria-labelledby="product-frame-heading">
        <div className="dash-frame-head">
          <div>
            <h3 id="product-frame-heading">Neumorphism wellness dashboard</h3>
            <p>
              Raised and inset physical surfaces composed into a single shared-light product
              screen.
            </p>
          </div>
          <a className="btn" href="/neumorphism.html" target="_blank" rel="noreferrer">
            Open standalone
          </a>
        </div>
        <iframe
          className="dash-frame"
          src="/neumorphism.html"
          title="Neumorphism wellness dashboard demo"
        />
      </section>
    </>
  );
}
