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
A definition of a related collection of recipes. Its identity and selector semantics depend on the mechanism that provides it.
_Avoid_: catalog, recipe.

**Source selector**:
An optional provider-specific request used to select a Source revision. A provider may reject selectors entirely.
_Avoid_: version, source assertion.

**Source revision**:
The exact provider-specific content identifier used to pin a resolved Source; for a Git Source, this is a commit.
_Avoid_: selector, tag, branch.

**Recipe**:
A reusable definition that describes an ordered sequence of steps for generating or detecting artifacts in a consumer repository.
_Avoid_: artifact template, source, plugin, script.

**Artifact**:
A file, fragment, or tool that is installed, detected, or created in the consumer repository environment as the result of installing a recipe.
_Avoid_: recipe, source.

**Step**:
An ordered operation within a recipe that generates or detects an artifact. Steps are required by default and may be declared optional; their other fields and validation rules are defined by their step type.
_Avoid_: recipe, script.

**Optional step**:
A step whose detection, installation, removal, or lack of Custom authorization produces a non-blocking diagnostic and does not prevent the remaining steps from continuing. Lack of authorization blocks a required Custom step.
_Avoid_: best-effort recipe, ignored step.

**Step type**:
The kind of operation a step performs, such as creating a file, managing a file fragment, or executing custom behavior. In the MVP, the built-in types are File and File Fragment; other behavior uses Custom and may become a dedicated type later when a repeated pattern justifies it.
_Avoid_: recipe type, artifact type.

**File step**:
A step that creates or verifies a complete file artifact from source content.

**File Fragment step**:
A step that creates or updates a delimited fragment within a file artifact.

**Custom step**:
A step whose check, installation, or removal behavior is supplied by a script executed through a supported runtime, with a runtime chosen independently for each operation, and therefore requires explicit authorization before execution.
_Avoid_: arbitrary recipe, plugin step.

**Local catalog registry**:
The set of catalogs available to a developer for discovery, independently of the consumer repository.
_Avoid_: manifest dependency.

**Manifest**:
A consumer repository's declaration of the sources it intends to install. Each declared Source is installed completely in the MVP.
_Avoid_: installation record.

**Source dependency**:
A Source's declaration that another Source must also be resolved and installed, using the same Source declaration shape as a Manifest entry.
_Avoid_: recipe dependency, catalog dependency, manifest dependency.

**Installation record**:
A record of what an installation operation actually installed, including relevant versions and content fingerprints for detecting drift.
_Avoid_: manifest, log.

**Source provider**:
A mechanism that locates a Source, normalizes its identity, and resolves a requested selector to an exact revision when supported.
_Avoid_: installation provider, catalog.

**Source reference**:
A reference used to locate a Source. Its structure and optional locator components depend on the Source provider.
_Avoid_: file URI prefix.

**Source locator path**:
An optional provider-specific path selecting a Source within a larger locator, such as a subdirectory inside a Git repository.
_Avoid_: recipe path, local subpath selector.

**Installation provider**:
A mechanism that applies an artifact to the consumer repository environment.
_Avoid_: source provider, plugin.

**Managed block**:
A delimited fragment of a file whose ownership and contents can be recognized by the recipe that manages it.
_Avoid_: patch, free-form modification.
