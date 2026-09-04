/**
 * Describe npm cache access for a browser child without cloning the parent's
 * in-memory package graph across a worker boundary. Cache contents are an
 * optimization; a child must retain the normal registry/artifact fetch path
 * so installs remain valid after the child has started.
 */
export function npmCacheSnapshot(cache) {
  const snapshot = { metadata: {}, tarballs: {} };
  if (cache?.artifactManifest && cache?.artifactBaseUrl) {
    snapshot.artifact = {
      baseUrl: cache.artifactBaseUrl.href,
      metadata: cache.artifactManifest.metadata || {},
      tarballs: cache.artifactManifest.tarballs || {},
    };
  }
  return snapshot;
}
