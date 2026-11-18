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
