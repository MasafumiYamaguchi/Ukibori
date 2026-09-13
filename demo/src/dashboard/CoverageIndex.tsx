/**
 * Coverage index: maps each implementation group to the dashboard tab, the
 * retained standalone demo page, or the repository document that demonstrates
 * it. Every href targets a file that exists in this repository.
 */

type CoverageLinkKind = "tab" | "demo" | "doc";

interface CoverageLink {
  kind: CoverageLinkKind;
  label: string;
  href: string;
}

interface CoverageGroup {
  id: string;
  group: string;
  links: readonly CoverageLink[];
}

const REPO_DOC = "https://github.com/MasafumiYamaguchi/Ukibori/blob/master/";

const LINK_KIND_LABEL: Record<CoverageLinkKind, string> = {
  tab: "dashboard tab",
  demo: "standalone demo",
  doc: "repository document",
};

function tab(label: string, href: string): CoverageLink {
  return { kind: "tab", label, href };
}

function demo(href: string): CoverageLink {
  return { kind: "demo", label: href.slice(1), href };
}

function doc(fileName: string): CoverageLink {
  return { kind: "doc", label: fileName, href: `${REPO_DOC}${fileName}` };
}

const COVERAGE_GROUPS: readonly CoverageGroup[] = [
  {
    id: "core-renderer",
    group: "#13–19 core renderer (SDF → height → normals → lighting → shadows → glyphs)",
    links: [
      tab("Diagnostics → Renderer", "#diagnostics/renderer"),
      demo("/renderer-debug.html"),
      doc("packages/renderer/README.md"),
    ],
  },
  {
    id: "dom-react",
    group: "#20–21 DOM integration and React API",
    links: [
      tab("Diagnostics → DOM integration", "#diagnostics/dom"),
      demo("/dom-debug.html"),
      doc("packages/ukibori-dom/README.md"),
    ],
  },
  {
    id: "gpu-scheduler",
    group: "#22–33 WebGPU, environment, scheduler and WASM fallback",
    links: [
      tab("Playground → backend / environment / exposure", "#playground"),
      demo("/scheduler-debug.html"),
      demo("/wasm-debug.html"),
    ],
  },
  {
    id: "shadows-lighting",
    group: "#41, #43, #45–48, #52–53 soft shadows, reconstruction, light color, benchmarks and shadow/glyph quality",
    links: [
      tab("Playground → soft shadows and light color", "#playground"),
      doc("ISSUE_43_REVIEW_FIX_PROGRESS.md"),
      doc("ISSUE_48_PERFORMANCE_REPORT.md"),
      doc("packages/renderer/benchmark-report.md"),
      doc("ISSUE_52_IMPLEMENTATION_REPORT.md"),
      doc("ISSUE_53_IMPLEMENTATION_REPORT.md"),
    ],
  },
  {
    id: "text-bake-shape-profiles",
    group: "#56–61 CSS text color, dynamic soft shadows, Bake boundaries, SVG paths and height profiles",
    links: [
      tab("Feature lab → profiles, shapes, Bake, text color", "#features"),
      demo("/profile-debug.html"),
      doc("ISSUE_56_IMPLEMENTATION_REPORT.md"),
      doc("ISSUE_57_IMPLEMENTATION_REPORT.md"),
      doc("ISSUE_61_IMPLEMENTATION_REPORT.md"),
    ],
  },
  {
    id: "scene-encoding",
    group: "Scene encoding optimization",
    links: [doc("SCENE_ENCODING_PERFORMANCE_REPORT.md")],
  },
  {
    id: "byte-comparison",
    group: "Byte comparison optimization",
    links: [doc("BYTE_COMPARISON_PERFORMANCE_REPORT.md")],
  },
  {
    id: "cpu-environment",
    group: "CPU environment optimization",
    links: [doc("CPU_ENVIRONMENT_PERFORMANCE_REPORT.md")],
  },
  {
    id: "emissive",
    group: "Emissive materials, illumination and bloom",
    links: [
      tab("Playground → emissive controls", "#playground"),
      demo("/emissive-debug.html"),
      doc("EMISSIVE_IMPLEMENTATION_REPORT.md"),
      doc("EMISSIVE_EFFECTS_IMPLEMENTATION_REPORT.md"),
    ],
  },
];

export function CoverageIndex() {
  return (
    <section className="dash-coverage" aria-labelledby="coverage-heading">
      <h2 id="coverage-heading">Coverage index</h2>
      <p>
        Each implementation group below is available through a dashboard tab, a retained
        standalone demo page or a repository document. Documents open on GitHub.
      </p>
      <div className="dash-coverage-scroll">
        <table className="dash-coverage-table">
          <caption className="dash-visually-hidden">
            Implementation groups and where to explore them
          </caption>
          <thead>
            <tr>
              <th scope="col">Implementation group</th>
              <th scope="col">Where to explore</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGE_GROUPS.map((group) => (
              <tr key={group.id}>
                <th scope="row">{group.group}</th>
                <td>
                  <ul className="dash-coverage-links">
                    {group.links.map((link) => (
                      <li key={`${link.kind}:${link.href}`}>
                        <a
                          href={link.href}
                          {...(link.kind === "doc"
                            ? { target: "_blank", rel: "noreferrer" }
                            : {})}
                        >
                          {link.kind === "doc" ? <code>{link.label}</code> : link.label}
                        </a>{" "}
                        <span className={`dash-link-kind kind-${link.kind}`}>
                          {LINK_KIND_LABEL[link.kind]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
