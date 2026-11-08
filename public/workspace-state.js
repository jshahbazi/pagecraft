/** Compare the file payloads while treating two absent files as equal. */
export function sameFile(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.content === b.content && a.encoding === b.encoding;
}

/**
 * Reattach a browser workspace to a freshly scanned local directory after the
 * server has restarted. Preserve browser edits only when their disk versions
 * have not changed since the browser last observed them.
 */
export function reconcileLocalWorkspace(previous, opened, serverId) {
  const oldLocal = previous?.local;
  if (!oldLocal || oldLocal.directory !== opened?.directory)
    throw new Error(
      "This workspace belongs to a different directory. Export your edits before opening or reattaching another directory.",
    );
  if (
    oldLocal.git &&
    (!opened?.git ||
      ["root", "branch", "remote", "upstream"].some(
        (key) => oldLocal.git[key] !== opened.git[key],
      ))
  )
    throw new Error(
      "The checkout or push destination changed since this workspace was opened. Export your edits and reopen the original checkout before saving or pushing.",
    );

  const previousFiles = new Map(
    (previous.files ?? []).map((file) => [file.path, file]),
  );
  const previousBaseline = new Map(
    (previous.baseline ?? []).map((file) => [file.path, file]),
  );
  const oldDisk = new Map(
    (oldLocal.diskBaseline ?? []).map((file) => [file.path, file]),
  );
  const freshDisk = new Map(
    (opened.files ?? []).map((file) => [file.path, file]),
  );
  const allPaths = new Set([
    ...previousFiles.keys(),
    ...previousBaseline.keys(),
    ...oldDisk.keys(),
  ]);
  const protectedPaths = new Set();

  for (const path of allPaths) {
    const file = previousFiles.get(path);
    if (
      !sameFile(file, previousBaseline.get(path)) ||
      !sameFile(file, oldDisk.get(path))
    ) {
      protectedPaths.add(path);
      if (!sameFile(freshDisk.get(path), oldDisk.get(path)))
        throw new Error(
          `The on-disk file "${path}" changed since this workspace was opened. Export your edits and reopen the directory before saving.`,
        );
    }
  }

  const files = new Map(freshDisk);
  const baseline = new Map(freshDisk);
  for (const path of protectedPaths) {
    files.delete(path);
    baseline.delete(path);
    const browserFile = previousFiles.get(path);
    const oldBaselineFile = previousBaseline.get(path);
    if (browserFile) files.set(path, browserFile);
    if (oldBaselineFile) baseline.set(path, oldBaselineFile);
  }

  const resultFiles = [...files.values()];
  const current = resultFiles.some((file) => file.path === previous.current)
    ? previous.current
    : resultFiles.find((file) => /\.html?$/i.test(file.path))?.path;

  return {
    ...previous,
    files: resultFiles,
    baseline: [...baseline.values()],
    current,
    local: {
      ...oldLocal,
      workspaceId: opened.workspaceId,
      directory: opened.directory,
      git: opened.git,
      serverId,
      diskBaseline: structuredClone(opened.files ?? []),
    },
  };
}
