# Source references use local paths or recognized schemes

The canonical Source reference in a Manifest or Source dependency is structured: it names a provider, a provider locator, and an optional provider-specific selector. Provider-specific locator components, such as Git's optional repository path, are represented explicitly rather than encoded into an ambiguous URI. The local provider uses a path locator and does not accept a nested path component; the Git provider uses a repository locator and may accept a path within that repository. Unsupported provider fields or schemes fail validation rather than falling back to a local path.

**Consequences**: local references remain portable and familiar, future providers have an unambiguous extension point, and typos such as an unsupported scheme fail clearly instead of resolving to an unintended local path.
