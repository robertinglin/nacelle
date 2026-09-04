function parseModuleSpec(moduleSpec) {
  const spec = String(moduleSpec || '').trim();
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    const at = slash === -1 ? -1 : spec.indexOf('@', slash);
    return {
      name: at === -1 ? spec : spec.slice(0, at),
      range: at === -1 ? 'latest' : spec.slice(at + 1) || 'latest',
    };
  }
  const at = spec.indexOf('@');
  return {
    name: at === -1 ? spec : spec.slice(0, at),
    range: at === -1 ? 'latest' : spec.slice(at + 1) || 'latest',
  };
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string') return null;
  const normalized = repository
    .replace(/^git\+/, '')
    .replace(/^git:/, 'https:')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return /^https:\/\/github\.com\//i.test(normalized) ? normalized : null;
}

/**
 * Resolve the project archive that the upstream CITGM lookup will use.
 * Precache must cover that archive when the npm package does not contain the
 * candidate's test dependencies or its published metadata has no gitHead.
 */
export function resolveCitgmProjectUrl({ moduleSpec, metadata, versionMetadata = null, lookup = {} } = {}) {
  if (lookup?.npm) return null;
  // CITGM resolves the candidate first and then uses that version's
  // package.json metadata (especially gitHead). The registry index has the
  // repository and dist-tags, but need not carry the selected gitHead at its
  // top level. Accept both documents so callers can preserve that distinction.
  const selected = versionMetadata || metadata || {};
  const repository = normalizeRepository(
    typeof (selected.repository || metadata?.repository) === 'string'
      ? (selected.repository || metadata.repository)
      : (selected.repository || metadata?.repository)?.url,
  );
  if (!repository) return null;

  const { range } = parseModuleSpec(moduleSpec);
  let archiveRef;
  if (lookup.head) archiveRef = 'HEAD';
  else if (lookup.sha || selected.gitHead || metadata?.gitHead) {
    archiveRef = lookup.sha || selected.gitHead || metadata.gitHead;
  } else {
    archiveRef = `${lookup.prefix || ''}${metadata?.['dist-tags']?.[range]
      || selected['dist-tags']?.[range] || range}`;
  }
  return `${repository}/archive/${encodeURIComponent(archiveRef)}.tar.gz`;
}
