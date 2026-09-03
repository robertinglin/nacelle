import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCitgmProjectUrl } from '../citgm-project-url.mjs';

test('resolves the upstream project archive from lookup precedence', () => {
  const metadata = {
    repository: { type: 'git', url: 'git+https://github.com/example/project.git' },
    gitHead: 'published-sha',
    'dist-tags': { latest: 'v1.2.3' },
  };
  assert.equal(
    resolveCitgmProjectUrl({ moduleSpec: 'project@latest', metadata, lookup: {} }),
    'https://github.com/example/project/archive/published-sha.tar.gz',
  );
  assert.equal(
    resolveCitgmProjectUrl({ moduleSpec: 'project@latest', metadata, lookup: { sha: 'lookup-sha' } }),
    'https://github.com/example/project/archive/lookup-sha.tar.gz',
  );
  assert.equal(
    resolveCitgmProjectUrl({ moduleSpec: 'project@latest', metadata, lookup: { head: true } }),
    'https://github.com/example/project/archive/HEAD.tar.gz',
  );
});

test('does not turn npm-managed projects or non-GitHub repositories into archives', () => {
  const metadata = { repository: 'https://gitlab.com/example/project.git' };
  assert.equal(resolveCitgmProjectUrl({ moduleSpec: 'project', metadata, lookup: {} }), null);
  assert.equal(resolveCitgmProjectUrl({
    moduleSpec: 'project',
    metadata: { repository: 'https://github.com/example/project.git' },
    lookup: { npm: true },
  }), null);
});

test('uses the selected published version gitHead when registry metadata nests it', () => {
  assert.equal(
    resolveCitgmProjectUrl({
      moduleSpec: 'project@latest',
      metadata: {
        'dist-tags': { latest: '1.2.3' },
        versions: {
          '1.2.3': {
            repository: { type: 'git', url: 'git+https://github.com/example/project.git' },
            gitHead: 'published-version-sha',
          },
        },
      },
    }),
    'https://github.com/example/project/archive/published-version-sha.tar.gz',
  );
});
