# Catalogs are optional local indexes

A consumer repository manifest may reference a Source directly; catalogs are discovery indexes registered locally by each developer and are not required for installation. In the MVP, each catalog entry contains `title`, `description`, and `keywords` plus one structured Source reference. Catalog entries do not introduce IDs: Source identity remains the normalized provider and locator identity, and duplicate identities are invalid.

**Consequences**: the repository does not depend on a machine's catalog configuration, discovery remains separate from installation, and local deterministic search can use titles, descriptions, and keywords without becoming a marketplace.
