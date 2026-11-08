# Verification

Verified on 2026-11-08 with Node.js 24.15.0 and Chrome on macOS.

## Automated

`npm run check`, `npm test`, and `git diff --check` pass. The 22 Node tests cover:

- Loopback host/origin/session boundaries and static file isolation.
- Repository, branch, directory, and changed-file validation.
- Read-only repository loading at an exact branch commit, including binary assets.
- Subtree loading before limits and prefixing changed paths when committing.
- Preservation of unrelated remote files through a root base tree.
- Refusal of stale branch heads, unsafe existing file modes, symlinks, and submodules.
- Error responses without leaking GitHub command output or credentials.
- Import filtering, normalized paths, duplicate files, byte/count limits, and ZIP CRC/directory output.

GitHub behavior in the automated tests uses an injected transport. Live checks are listed separately.

## Browser and live checks

- Opened the default example; its local SVG asset and CSS render in the opaque sandbox.
- Selected elements through Layers and the canvas; edited styles, typed directly into text, and inspected the resulting HTML in Code view.
- Confirmed canvas edits preserve authored relative image URLs and emit no editor attributes or rewritten data URLs.
- Reloaded the app and recovered the IndexedDB workspace.
- Typed multiline content including Enter-created blocks and repeated rich-text keystrokes. Subsequent typing stayed saved, authored link URLs were retained, and original scripts did not run.
- Checked that the inspector is hidden during Code edits so stale source cannot overwrite an inspector edit.
- Exercised active-link clicks, keyboard Enter, and middle-clicks. The canvas stayed on its authored page and exported href attributes remained unchanged.
- Exported Planetable through the UI and independently opened the browser-downloaded ZIP with Python's zipfile reader: all 13 entries and CRCs passed. Also validated the two-file sample ZIP with the same independent reader.
- Opened Stark from GitHub with `website/public`: 18 supported files and four HTML pages on the checked `main` revision. Its CSS and product image rendered. A style edit preserved the authored script and stylesheet references. Undo restored an unchanged workspace. No push to Stark was performed.
- Opened Planetable from GitHub with `website/dist`: 13 supported files on the checked `main` revision. The stylesheet, local fonts, and logo rendered. No push to Planetable was performed.
- Connected an already-edited example workspace to `jshahbazi/pagecraft`, folder `examples/forma`, without losing its edits. Reviewed and pushed one changed HTML file through the UI to `main` (commit `22f6fc9`). Fetched that commit independently and confirmed its only changed path was `examples/forma/index.html`; unrelated app and repository files stayed unchanged.
- Imported the local example folder using Chrome's native macOS folder picker and upload confirmation: both HTML and its nested SVG asset loaded and rendered. The extension file-chooser automation did not complete that workflow, so native UI was used for verification.

Original scripts are deliberately paused in the editing canvas. This does not verify those sites' interactive runtime behavior or a Sites deployment. Script-generated content must be edited in the script/data source.

## Recheck manually

1. Run `npm start`, open the example, double-click a phrase and type several characters.
2. Change its color and size, then duplicate/delete a block and undo/redo.
3. Use Code view to inspect unchanged authored links, scripts, and asset paths.
4. Export ZIP; open its HTML with its adjacent assets in a normal browser.
5. Open a disposable repository or site folder, change a file, review it, and push. Confirm the changed path and preservation of unrelated remote files.
6. Advance the remote branch from another client and verify Pagecraft refuses a stale push.

A GitHub commit and a deployed website are separate outcomes. Only report a deployment after its hosting system verifies success.
