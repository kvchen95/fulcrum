/**
 * internal — collection of internal modules for @fulcrum/cli.
 *
 * Why a separate subpath instead of exporting manifest / gateway / artifact / ports / discover
 * individually: that would freeze internal implementation into public API — changing one
 * function breaks semver. Only one gate opens here, labeled internal, with clear semantics:
 *
 *   "The plugin is the public API; these are implementation details. The CLI needs them, so one
 *    gate is opened, but the sign on it says internal — outside code should not depend on it directly."
 *
 * Version coupling relies on the monorepo: @fulcrum/cli depends on entry-vite via workspace, released from the same repo at the same version.
 */
export * from './manifest.js';
export * from './gateway.js';
export * from './artifact.js';
export * from './ports.js';
export * from './discover.js';
export * from './root.js';
export * from './types.js';
