# Catalogs are optional local indexes

A consumer repository manifest may reference a source directly; catalogs are discovery indexes registered locally by each developer and are not required for installation. The prototype will not implement catalogs because it must first compare the proposed semantics with composition of existing tools.

**Consequences**: the repository does not depend on a machine's catalog configuration, but discovery remains separate from installation and will be resolved later.
