/**
 * Product view: the playable instrument is isolated in a same-origin iframe.
 * The earlier wellness showcase remains available as a standalone page.
 */
export function Product() {
  return (
    <>
      <header className="dash-view-head">
        <h2>Product</h2>
        <p>
          ripple R-1 is a playable pocket synthesizer built on Ukibori's physical base plane:
          a two-octave keyboard, four knobs, shared shadows and an emissive indicator.
        </p>
      </header>

      <section className="dash-frame-panel" aria-labelledby="product-frame-heading">
        <div className="dash-frame-head">
          <div>
            <h3 id="product-frame-heading">ripple R-1 — pocket voice</h3>
            <p>
              Play two octaves, edit a sixteen-step sequence and shape the sound with four dials.
            </p>
          </div>
          <a className="btn" href="/instrument.html" target="_blank" rel="noreferrer">
            Open standalone
          </a>
        </div>
        <iframe
          className="dash-frame"
          src="/instrument.html"
          title="ripple R-1 playable synthesizer demo"
        />
      </section>
      <p><a href="/neumorphism.html" target="_blank" rel="noreferrer">Open the wellness dashboard showcase ↗</a></p>
    </>
  );
}
