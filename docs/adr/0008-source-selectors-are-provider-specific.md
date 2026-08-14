# Source selectors are provider-specific

The MVP uses an optional `selector` rather than a common version language. Each Source provider owns the selector syntax and capabilities: the local provider accepts only an absent or empty selector, while the Git provider may resolve exact tags, branches, or ranges. When several dependencies refer to the same Source, the provider intersects their selectors and chooses one candidate revision satisfying all of them; the resolved revision is recorded separately in the lockfile.

For the MVP, Git selectors use a structured shape: `ref` names one exact tag or branch, while `from` and `to` define an inclusive bounded range. Ranges are evaluated over commit ancestry rather than commit timestamps. An unbounded selector such as `^from` is out of scope until a candidate set or upper bound is defined. Exact tags and branches remain valid selectors, with the resolved commit recorded in the lockfile. During `install`, a compatible lock entry is authoritative; absent entries are resolved and written, while changing or stale selectors require an explicit lockfile-update flag.

Git selector bounds accept unambiguous short names and fully qualified `refs/tags/...` or `refs/heads/...` names. If a short name identifies both a tag and a branch, resolution fails and requires a fully qualified ref.

The lockfile is `tbboot.lock.yaml` at the consumer repository root, next to the Manifest, and is intended to be versioned with it. The first resolution writes it automatically. Normal `install` treats the lockfile as authoritative; `--update-lock` explicitly re-resolves and updates it, while `--frozen-lockfile` forbids creation or modification and fails if the lockfile is missing or stale.

For the MVP, each lock entry stores only Source resolution data: provider, normalized locator including any Git path, original selector, resolved revision, and content fingerprint. Recipe selection is not implemented in the MVP and is therefore not locked. Once Recipe selection is implemented, the product should extend the lockfile with the effective resolved Recipe graph so frozen mode can guarantee the complete plan. Installation outcomes remain outside the lockfile and belong to the Installation record.

Git range bounds are inclusive. The lower bound must be an ancestor of the upper bound; equal bounds select one commit, and multiple incomparable maximal candidates make the intersection a conflict.

Locator structure is also provider-specific. Git Sources may include an optional locator path inside the repository; the local provider's reference points directly to the Source directory and does not accept a second nested path selector. The provider's locator, including any such path, determines Source identity.

For Git, the locator path is relative to the repository root, normalized, and cannot be absolute, escape through `..`, or contain globs. The selected directory must contain `source.yaml`; omitting the path selects the repository root.
