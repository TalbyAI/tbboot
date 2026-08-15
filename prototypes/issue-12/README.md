# Issue 12 acceptance fixture

This isolated prototype provides the end-to-end test harness for future
tbboot CLI slices. It creates temporary Consumer repositories and Sources
from checked-in templates, launches a CLI as a child process, and keeps exit
code, stdout, and stderr observable separately.

Run it on Windows with:

```powershell
Set-Location prototypes/issue-12
npm test
```

## Harness

`harness.mjs` exports four small seams:

- `createFixture()` copies `fixture/` into a unique temporary directory and
  returns `consumerRoot`, `sourceRoot`, and an idempotent `cleanup()`.
- `runCommand({ file, args, cwd, env })` invokes a real child process without
  merging stdout and stderr.
- `snapshotFiles(root)` returns sorted relative file paths and raw `Buffer`
  contents for byte-for-byte comparisons.
- `parseJsonOutput(stdout)` accepts surrounding whitespace and requires one
  non-empty JSON document.

Future acceptance tests should call the production CLI through
`runCommand`, rather than importing production modules. For a read-only
command, snapshot the Consumer repository before and after the command:

```js
const fixture = await createFixture();
try {
  const before = await snapshotFiles(fixture.consumerRoot);
  const result = await runCommand({
    file: process.execPath,
    args: [productionCli, 'doctor', '--root', fixture.consumerRoot],
    cwd: fixture.consumerRoot,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await snapshotFiles(fixture.consumerRoot), before);
  assert.ok(parseJsonOutput(result.stdout));
} finally {
  await fixture.cleanup();
}
```

Add a scenario by extending the checked-in fixture only with inputs that the
scenario needs, then add one end-to-end test using these seams. Keep all
scenario-specific files under this prototype. `test/fixtures/cli.mjs` is a
small process-boundary probe used while the production CLI is not available;
it is not a tbboot implementation and Issue 5 is not a dependency.
