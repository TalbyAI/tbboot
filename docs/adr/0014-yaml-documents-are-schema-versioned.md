# YAML documents are schema-versioned

Every authored or generated tbboot YAML document declares `schemaVersion: 1`, including `tbboot.yaml`, `source.yaml`, `recipe.yaml`, catalogs, `tbboot.lock.yaml`, and `.tbboot/state.yaml`. An unknown schema version fails validation before any write operation.

While tbboot remains below version `1.0`, extension work may evolve the
contract and its registry-dispatched validation without changing the declared
`schemaVersion`. The value remains `1` until the tool publishes `1.0`.

This policy does not promise compatibility between documents or extension
definitions produced by different `0.x` versions, and no pre-`1.0` migration
is provided by default. The compatibility and migration policy for `1.0` and
later must be decided explicitly before that release.
