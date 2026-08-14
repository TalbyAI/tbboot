# YAML documents are schema-versioned

Every authored or generated tbboot YAML document declares `schemaVersion: 1`, including `tbboot.yaml`, `source.yaml`, `recipe.yaml`, catalogs, `tbboot.lock.yaml`, and `.tbboot/state.yaml`. An unknown schema version fails validation before any write operation.
