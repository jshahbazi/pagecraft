# Editing the Stark and Planetable websites

Pagecraft edits files from a GitHub repository and can push changes to an existing branch. It does not create branches or deploy a hosted site.

| Project    | GitHub repository      | Site folder      |
| ---------- | ---------------------- | ---------------- |
| Stark      | `jshahbazi/stark`      | `website/public` |
| Planetable | `jshahbazi/planetable` | `website/dist`   |

When opening a repository, Pagecraft uses its default branch unless you enter another branch. Choose the existing branch you intend to update. Check that the branch contains the work you expect; local checkout changes do not automatically appear in GitHub or Pagecraft.

## Choose the right files

Stark's editable source is in `website/public`. Its `website/dist` directory is generated output and should not be used as the source for edits. After changing Stark's source, run `node website/build.mjs` in a Stark checkout to recreate `website/dist`. The build does not publish the hosted site; deployment uses the separate Sites workflow.

Planetable's site files in `website/dist` are maintained source, despite the directory name. The directory is tracked and buildless; edit those files directly. A push to GitHub still does not deploy the hosted site. Use the existing Sites workflow for publication.

## Choose the right editor view

Use the visual editor for content that is written directly in HTML. Use Code view when the visible content or behavior is created by JavaScript, or when editing CSS, data files, assets, or markup structure that the visual editor does not represent. For example, a scripted interactive story may have its labels and transitions in JavaScript even though the page itself is HTML.

Importing a local folder lets the browser read copies of supported files; it does not modify the original files on disk. Pushing changes updates the selected GitHub branch. It does not update the local checkout or deploy either project.
