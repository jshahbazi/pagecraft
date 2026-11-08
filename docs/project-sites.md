# Editing the Stark and Planetable websites

Pagecraft works with a local Git checkout. Open an existing checkout from the operating system's folder chooser, or enter a GitHub repository URL or `owner/repository` to clone it into Pagecraft's managed checkouts. Pagecraft saves site files locally and commits and pushes through Git's configured upstream. It does not publish either hosted website.

| Project    | GitHub repository      | Maintained site source |
| ---------- | ---------------------- | ---------------------- |
| Stark      | `jshahbazi/stark`      | `website/public`       |
| Planetable | `jshahbazi/planetable` | `website/dist`         |

## Open the source folder

To open a local checkout immediately when starting Pagecraft, pass its path:

```sh
npm start -- /path/to/checkout
```

Otherwise, choose **Open site → Choose a folder** and select the checkout. If its root has no HTML page, Pagecraft detects conventional site folders such as `website/public` and `website/dist`. You can select the source folder directly as well.

To use a GitHub URL or repository name, choose **Open site → Open a GitHub repository**. Pagecraft uses Git authentication already configured on the computer and creates a managed checkout under `~/.pagecraft/checkouts`. Its blobless, no-checkout clone and sparse source-folder detection avoid checking out unrelated content in large repositories.

Stark's maintained website source is `website/public`. Its `website/dist` directory is generated output and should not be edited as the source. After changing Stark's source, run `node website/build.mjs` in the checkout to recreate `website/dist`.

Planetable's `website/dist` files are maintained source despite the directory name. The directory is tracked and buildless; edit those files directly.

## Save, commit, and push

Use **Save files** or Cmd/Ctrl+S to write changed files to the selected source folder. The browser backup is separate from disk saving and is keyed by canonical directory. Pagecraft does not automatically reopen a cached workspace when started without a directory argument. When you explicitly reopen a directory, Pagecraft reconciles only that directory's backup; if a file with browser edits changed on disk, it refuses to overlay the conflict so the draft can be exported and reconciled manually.

Use **Commit & push** to commit selected site files on the checkout's current branch and push to its configured upstream. A commit contains the selected files' current contents, including edits that already existed in those files when opened. Unrelated unstaged changes remain untouched. Pagecraft refuses staged changes, preexisting unpushed or diverged commits, branch or upstream changes, and external modifications to selected files.

If a push fails after the commit was created, retry state stays available while the server process runs, including after a browser reload. If the server restarts, the commit remains in the checkout; finish or reconcile it in Git before opening the directory in Pagecraft again.

## Choose the right editor view

Use the visual editor for content written directly in HTML. Use Code view when visible content or behavior is created by JavaScript, or when editing CSS, data files, assets, or markup structure that the visual editor does not represent. A scripted interactive story, for example, may keep labels and transitions in JavaScript even though the page is HTML.

## Publish the hosted website

A successful Git push means the commit reached the configured remote. It does not deploy the hosted site. After changing Stark's source, rebuild `website/dist`; then use the project's separate Sites publication workflow. For Planetable, use its existing Sites workflow after pushing the maintained `website/dist` source. Follow each project's established publication process.
