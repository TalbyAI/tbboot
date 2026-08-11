# Repository Environment Contract

This context defines the concepts used to declare and consume reusable setup definitions for a repository environment.

## Language

**Consumer repository**:
A concrete repository that declares the sources and recipes it wants to install and verify.
_Avoid_: client repository, target project.

**Catalog**:
An index of sources with metadata for discovering and selecting them. A catalog helps with discovery but is not required to install a source directly.
_Avoid_: marketplace.

**Source**:
A definition of a related collection of recipes. Its identity and version depend on the mechanism that provides it.
_Avoid_: catalog, recipe.

**Recipe**:
A reusable definition that describes an ordered sequence of steps for generating or detecting artifacts in a consumer repository.
_Avoid_: artifact template, source, plugin, script.

**Recipe ID**:
The stable name used to identify a recipe within its source.
_Avoid_: display name, duplicated declaration ID.

**Artifact**:
A file, fragment, or tool that is installed, detected, or created in the consumer repository environment as the result of installing a recipe.
_Avoid_: recipe, source.

**Step**:
An ordered operation within a recipe that generates or detects an artifact. Its fields and validation rules are defined by its step type.
_Avoid_: recipe, script.

**Step type**:
The kind of operation a step performs, such as creating a file or managing a file fragment.
_Avoid_: recipe type, artifact type.

**File step**:
A step that creates or verifies a complete file artifact from source content.

**File Fragment step**:
A step that creates or updates a delimited fragment within a file artifact.

**Local catalog registry**:
The set of catalogs available to a developer for discovery, independently of the consumer repository.
_Avoid_: manifest dependency.

**Manifest**:
A consumer repository's declaration of the sources and recipes it intends to install.
_Avoid_: installation record.

**Installation record**:
A record of what an installation operation actually installed, including relevant versions and content fingerprints for detecting drift.
_Avoid_: manifest, log.

**Source provider**:
A mechanism that locates a source and establishes its identity and version when possible.
_Avoid_: installation provider, catalog.

**Source reference**:
A reference used to locate a source, either through the local environment or through a recognized source provider.
_Avoid_: file URI prefix.

**Installation provider**:
A mechanism that applies an artifact to the consumer repository environment.
_Avoid_: source provider, plugin.

**Managed block**:
A delimited fragment of a file whose ownership and contents can be recognized by the recipe that manages it.
_Avoid_: patch, free-form modification.
