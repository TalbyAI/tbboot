# Source revisions pin content while versions describe releases

Status: superseded by ADR-0008.

For the MVP, a Manifest entry or Source dependency may request a SemVer version, while the Source provider resolves it to content. The Source does not repeat that version in `source.yaml`. Git Sources resolve version requests through provider-specific references and record the exact content pin separately; the Manifest does not duplicate a resolved version as Source metadata.

The MVP applies this distinction to local and Git Sources: a local Source may omit a version because the local provider has no version-selection capability, while a Git Source may resolve a version request to a tag and then pin the resulting commit. Source dependencies reuse the same Source declaration shape as Manifest entries; they do not introduce a second dependency-only syntax.
