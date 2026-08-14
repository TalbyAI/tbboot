# Source revisions pin content while versions describe releases

Status: superseded by ADR-0008.

Historical context: this ADR distinguished a requested release version from its resolved content pin. ADR-0008 replaced that proposed common SemVer interface with provider-specific `selector` values; the current MVP contract is defined there.

The surviving distinction is between a provider-specific request and the exact resolved content: local Sources have no selector capability, while Git Sources resolve selectors and pin the resulting commit. Source dependencies reuse the same Source declaration shape as Manifest entries; they do not introduce a second dependency-only syntax.
