# Installation record is local to the consumer checkout

The MVP stores machine-specific installation state in `.tbboot/state.yaml` inside the consumer repository. The record is not versioned and contains the fingerprints and ownership information needed for drift detection and uninstall. During a writing `install`, tbboot creates or updates `.tbboot/.gitignore` to ensure `/state.yaml` is ignored while preserving existing entries; it does not modify the repository-root `.gitignore`. `doctor` and `install --dry-run` do not create or modify this metadata.
