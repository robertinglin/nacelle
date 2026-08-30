# Node 22 alpha support

## Shipped contract

The alpha ships one runtime target: Node 22. There is no Node 24, Node 26, or
`current` package surface in this release.

| Field | Alpha value |
| --- | --- |
| Target | `v22` |
| Native reference snapshot | `v22.23.2` (Jod) |
| Node module ABI | `127` |
| Node-API | `10` |
| Major-scoped npm channel | `n22` |
| Package entries | `nacelle/v22`, `nacelle/latest`, `nacelle/lts` |
| Default aliases | `latest -> v22`, `lts -> v22` |

`22`, `v22`, `n22`, `node22`, `node@22`, `latest`, and `lts` select the same
frozen profile. Any other major or alias fails with
`ERR_NACELLE_UNSUPPORTED_NODE_VERSION`; it never silently falls back to v22.

The reference patch identifies the metadata and ABI snapshot. Nacelle remains
a browser runtime, so feature fields that describe unavailable host facilities
remain browser-accurate. For example, the runtime does not claim a native
libuv event loop merely because upstream Node 22 has one.

## Runtime and artifact flow

```text
Nacelle.create({ version })
        |
        v
src/versions/support.js ---- rejects unshipped selectors
        |
        v
src/versions/v22/profile.js
        |
        +---- process.version / process.versions / process.release
        +---- shell node --version
        +---- worker and virtual-process descriptors
        +---- module ABI / Node-API expectations
        |
        v
dist/v22/ + dist/v22/wasm/ + dist/v22/version.json
```

The shared VFS, shell, npm client, workers, module loader, networking, proxy,
and Nacelle+ code do not fork by Node version. The profile owns only facts that
can differ by release line.

## Completed alpha gaps

This release work closes the structural and productization gaps that were
present in the original v22-only implementation:

- Runtime selection now changes real process, shell, child, and worker
  metadata instead of accepting an inert version string.
- The Node 22 profile is based on an actual native `v22.23.2` metadata snapshot,
  rather than values inherited from the machine running the build.
- The checked-in WASM manifest records the matching module ABI and Node-API
  version, and the browser N-API implementation reports version 10.
- Versioned ESM, CommonJS, type, WASM, and metadata outputs live under
  `dist/v22/`; root, `latest`, and `lts` entries resolve to that output.
- Build metadata carries the source revision, profile hash, and complete WASM
  artifact-set hash without a wall-clock timestamp.
- The Playwright adapter is connected to the checked-in runtime/profile and
  creates the runtime selected by the request instead of merely echoing a
  variant label.
- Process-exit sentinels are contained when an IPC or signal callback exits a
  worker, rather than escaping into the hosting page's event loop.
- Package validation checks source and built manifests, exports, ABI values,
  artifact validity, aliases, and support metadata from the same registry.
- `wasmBaseUrl` now drives a lazy manifest/artifact loader. Artifacts are
  validated as WebAssembly and mounted at their declared virtual paths;
  build-provided SHA-256 values are checked when present. The option is no
  longer diagnostic-only metadata.
- The release command publishes the major-scoped `n22` channel first and only
  promotes `latest` and `lts` when explicitly requested.

## Alpha build and release sequence

The complete v22 sequence is:

1. Resolve `v22` from `src/versions/support.js`.
2. Load the immutable profile from `src/versions/v22/profile.js`.
3. Match the profile against `src/wasm/v22/addon-manifest.json`.
4. Validate every declared artifact as WebAssembly and hash its bytes.
5. Stage shared runtime code plus version-owned entries under `dist/v22/`.
6. Write `version.json` and `support.json` from the resolved profile.
7. Validate package exports and the staged manifest against the registry.
8. Produce a parity report with isolated process, shell, TypeScript, npm,
   virtual HTTP, and compression checks.
9. Run browser workloads through the same request contract in Chromium and
   Firefox.
10. Publish `nacelle@n22`; update `latest` and `lts` only after the release gate
    is accepted.

The corresponding commands are:

```bash
npm run versions
npm run build
npm run validate:versions
npm run parity
npm run test:full
npm run publish:n22 -- --dry-run
```

The test commands are provided as release scaffolding; validation ownership
can remain separate from implementation work.

## Remaining compatibility boundaries

These are explicit alpha boundaries, not hidden version fallbacks:

- Synchronous zlib/Brotli/zstd methods cannot be implemented with the
  asynchronous browser Compression Streams API alone. Async Node-style
  compression and streaming are supported; sync calls report the boundary.
- ELF/native `.node` addons require a browser-safe WASM adapter. The v22 WASM
  manifest lists the artifacts Nacelle can load; arbitrary host addons are not
  claimed.
- Browser extensions do not expose general raw TCP/TLS sockets. Nacelle+
  remains a capability-gated privileged HTTP(S) fetch companion.
- Nacelle+ cannot reliably inspect the IP chosen by the browser's DNS resolver,
  so its documented DNS-rebinding limitation remains.
- Host filesystem, OS process, and kernel behavior that browsers do not expose
  must stay virtual or fail at a named unsupported boundary.

These boundaries should appear as `unsupported` in compatibility reporting,
not as a pass and not as an unrelated generic exception.

## Activating another release line later

The alpha does not ship or advertise another line. When a later release is
deliberately accepted, use this activation sequence rather than changing the
default version string:

1. Add one registry record and one release-owned profile.
2. Capture metadata from the exact native reference patch.
3. Build or qualify that line's WASM artifacts and ABI manifest.
4. Keep it off all aliases while compatibility differences are classified.
5. Run the shared parity, browser, npm, TypeScript, shell, and workload gates.
6. Publish a major-scoped channel first; package versions remain immutable.
7. Add an LTS or non-LTS alias only after that line independently meets the
   support contract.
8. Keep support and removal dates in the registry so an alias change never
   silently removes an existing supported line.

That mechanism is present, but only v22 is activated for the alpha.
