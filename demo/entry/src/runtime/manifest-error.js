/** Shared error type: used by manifest / URL resolution / sandbox health checks, so upper layers can backstop and instrument uniformly. */
export class ManifestError extends Error {
  constructor(message, code = 'MF_MANIFEST') {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}
