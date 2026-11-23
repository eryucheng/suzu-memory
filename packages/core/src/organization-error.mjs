// Candidate validity and input freshness are domain decisions. Storage and
// provider exceptions remain execution failures; callers must not infer these
// categories from the stage at which an exception happened.
export class OrganizationCandidateError extends Error {
  constructor(message, code = 'MEMORY_ORGANIZATION_INVALID_CANDIDATE') {
    super(message);
    this.name = 'OrganizationCandidateError';
    this.code = code;
    this.category = 'invalid-candidate';
  }
}

export class OrganizationInputChangedError extends Error {
  constructor(message = 'Organization input changed; regenerate from current memories and evidence.') {
    super(message);
    this.name = 'OrganizationInputChangedError';
    this.code = 'MEMORY_ORGANIZATION_INPUT_CHANGED';
    this.category = 'stale-input';
  }
}
