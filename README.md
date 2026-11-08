# Pagecraft

A local WYSIWYG HTML editor for the websites you make with ChatGPT. Click the page to select an element, double-click to edit text, adjust its design, and push a reviewed commit to GitHub.

![Pagecraft visual editor](docs/preview.jpg)

Pagecraft runs on your computer. It has no npm dependencies and uses your existing GitHub CLI login for repository access.

## Run

Install [Node.js 22 or later](https://nodejs.org/) and [GitHub CLI](https://cli.github.com/) for GitHub access. Local editing and ZIP export work without GitHub CLI.

```sh
git clone https://github.com/jshahbazi/pagecraft.git
cd pagecraft
npm start
```

Open **http://127.0.0.1:4173**. No install or build step is needed. If that port is busy, use `PORT=4174 npm start`.

For GitHub access, sign in once in a terminal:

```sh
gh auth login
```

## Edit a site

1. Choose **Open site** and open a folder, a single HTML file, pasted HTML, or a GitHub repository. Folder import includes supported CSS, scripts, images, fonts, and media.
2. Click an element on the canvas or in **Layers**. Use **Design** to change its text, typography, colors, spacing, links, or image URL. Double-click text on the canvas to edit it directly.
3. Use **Insert** to add a heading, paragraph, link button, section, or image. Duplicate or delete the selected element with the inspector buttons.
4. Switch between desktop, tablet, and mobile canvas widths. Use **Code** to edit HTML, CSS, JavaScript, JSON, or SVG, then choose **Apply code**.
5. Review the changed files and export the full local workspace as a ZIP, or **Push to GitHub**.

The browser saves one workspace locally in IndexedDB. Opening another site replaces it. Export edits you want to keep. Local source files are not overwritten by browser editing. Undo/redo records edits within the current session; importing a project or reloading starts a new history.

## Push to GitHub

Open an existing repository with an HTML site, choose an existing branch (blank uses its default), and optionally specify the **Site folder**, such as `website/public`. Paths in the editor are relative to this folder; commits write them back under the same folder.

You can also import a local site first, then choose **Push to GitHub** to connect it to an existing repository and site folder. This keeps your current local edits. Review the listed files carefully: each changed local file replaces the matching remote file. Remote files absent from your local workspace are preserved.

Pagecraft checks the branch commit you opened, creates Git blobs, a tree based on that commit, and a single-parent commit, then updates the branch without forcing it. If someone else changes the branch, the push is refused. Export your edits and reopen the updated repository to reconcile them. Branch protection and your GitHub permissions still apply. Pagecraft does not create repositories, branches, or pull requests, and it does not delete remote files.

A successful push means a GitHub commit exists. Your host controls deployment. See the [Stark and Planetable guide](docs/project-sites.md) for those projects' source folders and separate Sites publication workflows.

## Supported sites and limits

- Static HTML/CSS sites, including multi-page folders with relative and root-relative assets.
- Up to 300 supported site files and 20 MiB of decoded content per workspace. Open the site subfolder in large repositories.
- Text: HTML, CSS, JS/MJS, JSON, SVG, TXT, XML, webmanifest, and source maps. Assets: PNG, JPEG, GIF, WebP, AVIF, ICO, WOFF/WOFF2, TTF, OTF, EOT, MP4, WebM, MP3, OGG, WAV, PDF.
- Dotfiles, Git metadata, dependency folders, and unsupported file types are skipped. Repositories with symlinks or submodules in the selected site folder are refused. Unselected repository files stay untouched.

The visual canvas pauses authored scripts and event handlers. They remain in the saved HTML. External stylesheets are not loaded; include CSS in your folder or HTML. Layouts built by JavaScript, runtime Tailwind CDNs, React/Next.js source projects, server-side templates, and model-driven documents need their own source/build tools. Edit static output only when it is the maintained source. Script-generated labels should be changed in their script or data source through Code view.

The HTML parser normalizes markup when applying visual edits. Code in an authored script is preserved; visual edits can change document whitespace and attribute formatting. The inspector's plain-text field replaces inline formatting inside the selected text element; direct canvas editing preserves existing inline markup. Container text replacement is disabled to protect nested layouts.

## Local security model

The server listens only on `127.0.0.1`, validates the request host and origin, and requires a per-process session token for GitHub API actions. GitHub credentials remain with `gh`; Pagecraft does not store them in browser storage. Imported sites render in an opaque-origin sandbox with scripts, forms, navigation, embedded frames, and network API requests blocked. Local assets are projected as data URLs. Valid external HTTPS images and fonts can still contact their source hosts.

This is a local development tool. Do not expose its port through a tunnel or reverse proxy.

## Development

```sh
npm run check
npm test
npm run dev
```

The test suite exercises request isolation, path and file limits, GitHub branch conflicts, subtree path mapping, source commit construction, and ZIP CRC/directory output with an injected GitHub transport. [Verification notes](docs/verification.md) distinguish automated checks from browser and live GitHub checks.

- `server.mjs`: loopback server and GitHub adapter.
- `public/editor.js`: canonical HTML model and sandboxed visual editing bridge.
- `public/app.js`: workspace, inspector, history, local persistence, review, and publishing UI.
- `public/files.js`: folder import and dependency-free ZIP export.
- `examples/forma/`: small editable sample site.

MIT licensed.
