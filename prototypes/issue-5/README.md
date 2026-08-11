# Issue 5 prototype

This throwaway Windows fixture compares the proposed local declarative
semantics with a composition path built from existing tools.

The proposed implementation and tests live under `proposed/` and `test/`.
The comparison path is under `composition/`.

Run on Windows:

```powershell
Set-Location prototypes/issue-5
npm install
npm test
npm run compare
```

The fixture is throwaway. `doctor` and `install --dry-run` are read-only.
The composition path requires the external tools documented in
[`composition/README.md`](composition/README.md).
