#!/usr/bin/env node
/**
 * fulcrum CLI — the command-line entry of the micro-frontend workflow.
 *
 *   fulcrum dev              start the base (does not spawn sub-apps; they claim ports via discovery/announce)
 *   fulcrum dev -- child     also spawn in-repo sub-apps (when dir points to local source)
 *   fulcrum build            build the site: base + each sub-app → dist/site
 *   fulcrum preview          serve dist/site statically for acceptance
 *   fulcrum stop             cleanup: works even when the pid file is gone, by falling back to ports
 *   fulcrum check            6 CI gates
 *   fulcrum mock-env <port>  spin up a "test env" stand-in (for demo/testing)
 *
 * Convention: **cwd is the project root**. The manifest is searched upward from cwd
 * for at most 3 levels, so running from sub-directories like `src/` or `app/` still finds it.
 *
 * Every subcommand is a top-level executed script (reads process.argv), so before dispatch
 * we align argv to [node, <command>, ...args], so they receive positional args identical
 * to a standalone run.
 */
const [, , cmd, ...rest] = process.argv;

const usage = `
fulcrum <command>

  dev [names...] [--all]   start the base; with names, also spawn those sub-apps
  build [names...]         build the site → dist/site (--clean wipes all, --with <name> builds cross-repo)
  preview [port]           serve dist/site statically
  stop                     stop this round's dev server / base
  check                    validate manifest, proxy, artifacts, hardcoded addresses
  mock-env <port> [dir]    spin up a static "test env" stand-in

Common environment variables:
  MF_MANIFEST   manifest path
  MF_APPS_DIR   root searched when resolving cross-repo artifacts
  MF_HOST       base URL used during acceptance (default http://127.0.0.1:8000/)
`;

type CommandLoader = () => Promise<unknown>;

const COMMANDS: Record<string, CommandLoader> = {
  dev: () => import('./dev.js'),
  build: () => import('./build.js'),
  preview: () => import('./preview.js'),
  stop: () => import('./stop.js'),
  check: () => import('./check.js'),
  'mock-env': () => import('./mock-env.js'),
};

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(usage);
  process.exit(cmd ? 0 : 1);
}

const load = COMMANDS[cmd];
if (!load) {
  console.error(`unknown command: ${cmd}`);
  console.log(usage);
  process.exit(1);
}

process.argv = [process.argv[0] as string, `fulcrum-${cmd}`, ...rest];

await load();
