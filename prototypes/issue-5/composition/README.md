# Composition path

The composition comparison requires [`chezmoi`](https://www.chezmoi.io/) for
complete files. [`mise`](https://mise.jdx.dev/) is optional; the same tasks can
be run directly with PowerShell.

The adapter uses chezmoi's [global command-line flags](https://www.chezmoi.io/reference/command-line-flags/global/)
and [`apply`](https://www.chezmoi.io/reference/commands/apply/).

Run the adapter directly with `composition.ps1 -Mode doctor|dry-run|install`
and pass `-ConsumerRoot` plus `-SourceRoot` when using a copied fixture.
Doctor and dry-run never write. The adapter reports exit code 2 when `chezmoi`
is unavailable.
