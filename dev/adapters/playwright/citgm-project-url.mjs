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
export function resolveCitgmProjectUrl({ moduleSpec, metadata, lookup = {} } = {}) {
  if (lookup?.npm) return null;
  const repository = normalizeRepository(
    typeof metadata?.repository === 'string' ? metadata.repository : metadata?.repository?.url,
  );
  if (!repository) return null;

  const { range } = parseModuleSpec(moduleSpec);
  let archiveRef;
  if (lookup.head) archiveRef = 'HEAD';
  else if (lookup.sha || metadata.gitHead) archiveRef = lookup.sha || metadata.gitHead;
  else archiveRef = `${lookup.prefix || ''}${metadata['dist-tags']?.[range] || range}`;
  return `${repository}/archive/${encodeURIComponent(archiveRef)}.tar.gz`;
}
