/**
 * Project root: one codebase is reused both "as a vite plugin mounted into someone else's project"
 * and "as a CLI run inside the template repo", so the root must not be counted up from `import.meta.url`
 * (once packed into node_modules that points at the package dir).
 * Priority: explicit setRoot() > MF_ROOT env var > process.cwd()
 *   the vite plugin calls setRoot with config.root in configResolved (most accurate)
 *   CLI scripts call setRoot(repo root) explicitly
 */
let current: string = process.env.MF_ROOT ?? process.cwd();

export function setRoot(dir: string | null | undefined): void {
  if (typeof dir === 'string' && dir) current = dir;
}

export function projectRoot(): string {
  return current;
}

/**
 * Editing on a Windows drive while the dev server runs inside WSL is a classic trap:
 * /mnt/* (drvfs) does not emit inotify events, so vite's chokidar watcher never sees
 * saves. The transform cache then never invalidates — the page keeps serving stale
 * modules even after a hard refresh, on every port (there is no cache to clear).
 *
 * Detection: running inside WSL (WSL_DISTRO_NAME is set) with the project under /mnt/*.
 * In that case vite must use polling instead of inotify.
 */
export function needsPolling(root: string = process.cwd()): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME) && /^\/mnt\//.test(root);
}

/** chokidar polling tuned for drvfs: fast enough to feel live, cheap enough for dev */
export function pollingWatch(): { usePolling: boolean; interval: number } {
  return { usePolling: true, interval: 300 };
}
