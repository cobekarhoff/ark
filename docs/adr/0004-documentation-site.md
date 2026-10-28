# Architecture decision record (ADR) 0004: Static documentation with Astro Starlight

Status: accepted, 2026-10-28. Ticket: ARK-116.

## Context and decision

Ark needs repository-authored explanations and interactive teaching tools, built with
its existing Bun workflow. Choose **Astro Starlight**, static output, local Pagefind
search, Markdown and Markdown with components (MDX) under `site/`. Use ordinary
browser controls and Cascading Style Sheets (CSS) animation, not a React runtime
or animation library. `bun run docs:build` generates source-derived content and
builds the site; continuous integration (CI) runs that exact command after a frozen
install. Commit the Bun lockfile. No hosted search, server runtime or deployment pipeline.

The evaluation below uses official primary sources inspected on 2026-10-28. It is
a capability comparison, **not seven implementation trials or performance benchmarks**.
Claims marked **unverified** were not established by a local build or an explicit
support guarantee. Bun package-manager examples do not alone prove Bun runtime parity.

## Seven-framework comparison

The requested axes are separated below, including build and runtime fit as distinct
columns. Animation means the ability to embed our teaching interaction, not a promise
of a built-in lifecycle widget.

| Framework | Docs-in-repository authoring | MDX and interactive components | Animation | Mermaid diagrams |
| --- | --- | --- | --- | --- |
| **Astro Starlight** | Local Markdown/MDX content collections [S1] | MDX with Astro components; browser scripts or optional framework islands [S1] | Native CSS/browser APIs in components; no animation package needed (implementation choice) | No first-party Mermaid integration; official catalog lists community `astro-mermaid` [S2] |
| **Docusaurus** | Local docs and versioned docs folders [D1, D3] | First-class React/MDX [D1] | React components or CSS; animation library optional (inference from component model, not benchmarked) | Official `@docusaurus/theme-mermaid`, enabled in config [D2] |
| **VitePress** | Local Markdown compiled into pages [V1] | Vue-enhanced Markdown, **not MDX**; imported Vue components [V1] | Vue components and CSS (inference); no React/MDX reuse | Not established as built-in by inspected guide; plugin/custom integration would need evaluation (**unverified**) |
| **Fumadocs** | Local Fumadocs MDX content source [F1] | React/MDX; Next.js is a supported path, not the only current framework [F1] | React components/CSS; optional libraries (**unverified** integration details) | Explicitly no built-in wrapper; official guide shows direct Mermaid and alternatives [F3] |
| **Nextra** | Local Markdown/MDX on Next.js [N1] | React and MDX; app router for Nextra 4 [N1] | React/CSS; optional libraries (**unverified** integration details) | Built-in remark transform and Mermaid component [N3] |
| **MkDocs Material** | Local Markdown, theme configuration; Python-first generator [M1, M4] | No native MDX/React component model; custom JavaScript/theme extension instead [M1] | Custom CSS/JavaScript, not an MDX component workflow (inference) | Documented native initialization with SuperFences configuration [M2] |
| **Mintlify** | MDX pages in the documentation repository, navigation in `docs.json` [T1] | Sandboxed React components; imports and code-splitting constraints [T2] | Browser logic/CSS possible; third-party libraries require setup, no dynamic imports [T2] | Built-in Mermaid fences, zoom and pan [T3] |

| Framework | Search | Versioning | Bun build fit | Bun runtime fit | Hosting |
| --- | --- | --- | --- | --- | --- |
| **Astro Starlight** | Default local Pagefind [S2] | No first-party versioning; catalog lists community `starlight-versions` [S2] | Official Bun recipe [S3]; this repo forces Bun for Astro | Build only; static output has no server runtime | Static output can be served by a static host; no adapter needed [S1] |
| **Docusaurus** | Search integration; Algolia and alternatives rather than assuming local search from core [D1, D4] | First-party snapshot tooling [D3] | Bun install/run examples exist [D2, D3]; Node-first setup [D1] | Bun-runtime compatibility **unverified**; static output itself needs no runtime | Static HTML plus React client application; GitHub Pages/Netlify/Vercel documented [D1] |
| **VitePress** | Local MiniSearch or Algolia [V2] | No built-in versioning established by inspected docs; manual snapshots/plugin work would be required (**unverified** options) | JavaScript/Vite toolchain; Bun-runtime build **unverified** here | No production server for static output [V1] | Static HTML deployable anywhere [V1] |
| **Fumadocs** | Built-in Orama can export a browser index with explicit static setup [F2] | Version routing/layout work; first-party release snapshot tooling **unverified** | Guides use Bun, but current installer requires Node.js 22; full Bun-runtime parity **unverified** [F1] | Server-first default; configure framework static export to avoid runtime [F2] | Next.js static export supported; also other React frameworks and Astro now documented [F1, F2] |
| **Nextra** | Pagefind with explicit postbuild indexing [N2] | First-party version snapshots **unverified**; would need content/routing policy | Bun build example [N4]; actual Bun runtime compatibility **unverified** here | Next.js static export supported; no production server in that mode [N4] | Static `out/`, including GitHub Pages/Nginx; image optimization must be disabled [N4] |
| **MkDocs Material** | Built-in browser search, no hosted search needed [M1] | Theme integrates third-party `mike` [M3] | Requires Python/MkDocs, not Bun; Bun could only wrap another toolchain [M4] | Static output has no server; Python needed at build time | Own static outputs [M1]; lifecycle concern: announced end of life May 5, 2027, successor Zensical [M1] |
| **Mintlify** | Platform search; independent offline static search/export **unverified** | Version navigation supported [T1], not evidence of automatic release snapshots | Node.js 20.17+ CLI requirement, not Bun support [T4] | Hosted platform is the primary model; Bun-hosted runtime **unverified** | Managed hosting; a supported self-hosted static export was **not established** by inspected docs [T4] |

## Why Starlight; why not the runner-up?

Starlight supplies a readable documentation shell, content collections, local search
and accessible navigation without making Ark adopt a client React application.
The interactive pieces need only small browser scripts. Astro documents Bun use;
the root command invokes the real command-line interface (CLI) under Bun to capture
all help, including commands absent from the typed-tool inventory.

**Docusaurus is the runner-up.** Its official Mermaid theme and built-in versioning
are stronger if we need many maintained product versions or a large diagram corpus.
For the current site, a React single-page application and Node-first toolchain are
more surface than the teaching widgets require. This is a maintenance judgment,
not a measured bundle-size or speed claim.

VitePress would introduce Vue and a non-MDX authoring model. Fumadocs and Nextra
are attractive React options but their common Next.js path adds routing/export and
search configuration; current Fumadocs also supports other frameworks, so it is not
accurate to describe it as Next.js-only. Material adds a Python build toolchain and
its documented end-of-life transition makes a new adoption unattractive. Mintlify's
hosted emphasis does not meet our independently built static-output contract on the
evidence inspected; this is not a claim that self-hosting is impossible.

## Consequences and deliberate limits

- Starlight has **no first-party versioning or Mermaid**. Publish only the current
  checkout's guide. Re-evaluate versioning when multiple supported Ark releases
  actually require distinct docs; do not create a second inventory now.
- We need diagrams, but not Mermaid syntax: the lifecycle and ordered execution
  dependency diagram are accessible HTML controls derived from source data, with
  CSS connectors. No Mermaid package is installed. If authored Mermaid fences become
  necessary, evaluate the catalogued `astro-mermaid` integration first and use the
  smallest supported integration then; its compatibility is **unverified** in this repo.
- The lifecycle consumes `cli/transitions.ts`; it is a state machine **with loops**,
  not a directed acyclic graph (DAG). The execution DAG is the ten ordered playbook
  steps in a single pass. Rounds return through the lifecycle, not invented DAG edges.
- Build-generated CLI help and flow data live in ignored `site/.generated/`;
  browser code receives data attributes, never CLI/production imports. `site/dist/`
  and Astro cache files are ignored too. The site requires no production server.
- The walkthrough is explicitly illustrative, never a completed run or signed evidence.
- The README is a short onboarding entry point. Deep operational detail moves into
  the site, while repository architecture decisions and product requirements keep
  their original source locations. No deploy pipeline is part of this decision.

## Official sources

- [S1: Starlight manual setup, content collections, static rendering](https://starlight.astro.build/manual-setup/)
- [S2: Starlight official and community plugin catalog, default Pagefind](https://starlight.astro.build/resources/plugins/)
- [S3: Astro Bun recipe](https://docs.astro.build/en/recipes/bun/)
- [D1: Docusaurus introduction, React/MDX, Node setup and static hosting](https://docusaurus.io/docs)
- [D2: Docusaurus official Mermaid theme](https://docusaurus.io/docs/markdown-features/diagrams)
- [D3: Docusaurus versioning](https://docusaurus.io/docs/versioning)
- [D4: Docusaurus search choices](https://docusaurus.io/docs/search)
- [V1: VitePress model, Vue-enhanced Markdown and static hosting](https://vitepress.dev/guide/what-is-vitepress)
- [V2: VitePress search](https://vitepress.dev/reference/default-theme-search)
- [F1: Fumadocs current quickstart, frameworks and prerequisites](https://www.fumadocs.dev/docs)
- [F2: Fumadocs static build and search configuration](https://www.fumadocs.dev/docs/deploying/static)
- [F3: Fumadocs Mermaid integration](https://www.fumadocs.dev/docs/markdown/mermaid)
- [N1: Nextra introduction and React components](https://nextra.site/docs)
- [N2: Nextra Pagefind setup](https://nextra.site/docs/guide/search)
- [N3: Nextra Mermaid](https://nextra.site/docs/advanced/mermaid)
- [N4: Nextra static exports and Bun command](https://nextra.site/docs/guide/static-exports)
- [M1: Material overview, local search and end-of-life announcement](https://squidfunk.github.io/mkdocs-material/)
- [M2: Material diagrams](https://squidfunk.github.io/mkdocs-material/reference/diagrams/)
- [M3: Material versioning with mike](https://squidfunk.github.io/mkdocs-material/setup/setting-up-versioning/)
- [M4: MkDocs Python installation](https://www.mkdocs.org/user-guide/installation/)
- [T1: Mintlify repository pages and version navigation](https://www.mintlify.com/docs/organize/navigation)
- [T2: Mintlify React component capabilities and constraints](https://www.mintlify.com/docs/customize/react-components)
- [T3: Mintlify Mermaid diagrams](https://www.mintlify.com/docs/components/mermaid-diagrams)
- [T4: Mintlify Node CLI, preview, validation and platform workflow](https://www.mintlify.com/docs/cli/install)
