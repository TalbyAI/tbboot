# Steps use source inputs and repository-relative targets

Recipe steps may consume only files contained within their source, including shared folders in that source, and may act only on paths relative to the consumer repository root. Input paths are relative to the recipe by default; `..` may reach shared source folders but must be validated so resolution never escapes the source root. The prototype therefore excludes absolute paths, home-directory files, external inputs, and arbitrary host configuration.

**Consequences**: recipes are easier to inspect and reproduce safely, but the prototype cannot manage machine-wide files or consume data outside the source.
