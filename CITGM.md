# CITGM Integration Rule

Every fix made while bringing a package to green in CITGM must improve the
runtime's or harness's general conformance to Node.js behavior. A fix must not
be tailored to the package, repository, version, test name, or CITGM invocation
being exercised.

Do not add package-name or version conditionals, skip or weaken upstream tests,
fake success or exit codes, rewrite candidate output, inject candidate-specific
fixtures, stub behavior only for one dependency, or add any other CITGM
workaround. A package-specific symptom may identify a missing general runtime
contract, but the implementation must address that contract for all callers.

It is acceptable to improve the CITGM harness when the improvement is
general-purpose, preserves the upstream test's meaning, and applies equally to
all candidate packages. Harness changes must still execute the real candidate
tests inside the browser runtime.

A run may be called passing only when the actual browser CITGM command reports
`exitCode: 0` without timeout or error, with the candidate's upstream tests
executed. Agents must record the exact command, result evidence, changed files,
and any remaining environmental caveats.
