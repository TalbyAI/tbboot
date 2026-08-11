# Source references use local paths or recognized schemes

The manifest accepts unprefixed relative, absolute, and UNC paths through the local source provider. Future source providers may claim recognized URI schemes, but an explicit unsupported scheme is an error rather than a local path. The `file:` scheme is not used as a prefix; local source access is identified by the absence of a scheme.

**Consequences**: local references remain portable and familiar, future providers have an unambiguous extension point, and typos such as an unsupported scheme fail clearly instead of resolving to an unintended local path.
