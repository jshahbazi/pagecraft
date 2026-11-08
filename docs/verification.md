# Verification

Verified on 2026-11-08 with Node.js 24.15.0 on macOS, Chrome, and the in-app browser.

## Automated checks

`npm run check`, `npm test`, and `git diff --check` pass. The 81 Node tests cover:

- Local host, origin, token, request-size, and static file boundaries.
- Directory reads, source-folder detection, relative paths, symbolic links, file counts, and byte limits.
- Saving selected files in place, detecting external edits, and serializing writes from multiple grants.
- Real local commits and pushes to temporary bare repositories, preserving unrelated dirty work, refusing staged/diverged work, literal pathspecs, and immutable push targets.
- Retrying a failed push without creating another commit.
- Browser draft reconciliation, Git branch/destination changes, and disk conflicts.
- One bounded retry for an explicitly expired token, including safe grant reattachment before a write.
- Native OS picker commands, cancellation, concurrency, and errors using injected command runners.
- GitHub identifier validation, unique clone directories, sparse checkout, and Git upstream preservation. A real temporary Git clone checks sparse contents and upstream metadata.
- Production editor behavior: selected-element keyboard deletion outside inline editing, native text deletion, no iframe reload on blur, stable IDs for new inline nodes, and selection restoration without scrolling.
- ZIP contents and CRC/directory output, plus the retained GitHub API adapter.

GitHub API tests use an injected transport. OS dialog command tests use an injected runner. Git commit/push tests use actual temporary local repositories.

## Browser and live checks

- Reloaded with a cached workspace present. The app showed No site open, an empty canvas, and no iframe srcdoc. No Forma or other site opened.
- Checked that Open site offers exactly Open directory and a GitHub repository field with Clone and open. There are no upload, paste, import, example, or folder-browser tabs.
- Sent a native macOS picker request; cancellation returned cleanly to the dialog. Choosing a folder through that native window was not fully automated. The underlying directory open/save flow was tested separately.
- Used Clone and open with jshahbazi/stark. The live GitHub clone selected website/public, retained origin/main, and omitted unrelated files through sparse checkout. Its stylesheet and images rendered. The checkout remained clean after browser edits were undone; no push to Stark was performed.
- Edited the cloned site's footer heading inline and pressed Backspace: it removed one character. Leaving the field kept the exact iframe srcdoc attribute and scrollTop at 4151; there was no reload or top-to-bottom scroll.
- Keyboard element deletion was restored at the user’s request. Production-source tests verify that Backspace/Delete remove the selected element outside inline editing and retain native character deletion during inline editing. The earlier browser check for inert deletion keys no longer describes the intended behavior.
- Opened actual Stark and Planetable checkout roots read-only through the directory service. They selected website/public and website/dist respectively, with their correct owning Git roots, branches, and upstreams. No files were saved or pushed in either original project.
- In a temporary existing checkout, confirmed that browser editing alone did not change the file. Save files changed the original HTML in place. A reviewed Commit & push changed only index.html; an unrelated dirty file remained uncommitted, and local HEAD matched the bare remote.
- Changed that temporary file from a second editor. Pagecraft refused to overwrite it and retained the browser draft.
- Restarted an isolated QA server while a folder operation was pending. The open tab renewed its expired token without a reload. Repeated with an unsaved edit: Save files safely reattached the directory and wrote the recovered edit without a reload.
- Verified ZIP export with Python's independent zipfile reader: entries and CRCs passed.

The editor pauses authored scripts and event handlers while preserving their source. These checks do not verify a site's interactive runtime or deployment. Stark and Planetable publication still uses their separate Sites workflow.

## Deletion and inline editing recheck

After restoring Backspace/Delete shortcuts, an independent review found that canvas keyboard Undo was not forwarded to the app. The editor now forwards Cmd/Ctrl+Z and Redo shortcuts outside inline editing, while keeping native text undo during inline editing.

Chrome end-to-end checks on an isolated local fixture passed:

- Backspace removed a section; toolbar Undo restored its heading, paragraph, and nested strong element.
- Delete removed that section; Cmd+Z from the canvas restored the complete section.
- Inline typing and Backspace changed characters normally. On blur the iframe srcdoc stayed unchanged and scrollTop stayed at 1824.

The QA shell used an integer label line height to avoid the browser automation tool's fractional iframe-coordinate restriction. Production editor and history code were unchanged by that layout workaround. No user site files were saved during these checks.

## Recovery limits

File saves preflight the whole batch, then atomically replace each file. A batch is not a filesystem-wide transaction; a partial failure reports any files already saved.

Failed local-push retry state belongs to the running server. A browser reload with that server still running retains the saved grant; after a server restart, the local commit remains in Git and must be pushed or reconciled there before reopening.
