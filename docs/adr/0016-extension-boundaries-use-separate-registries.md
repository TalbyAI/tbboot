# Extension boundaries use separate registries

## Status

Accepted

## Context

tbboot needs to add new `Step types`, support additional runtimes and leave a
future boundary for `Source providers` and third-party extensions. These
concerns share infrastructure for identity, compatibility, capabilities,
trust and authorization, but they have different lifecycle and security
contracts.

A universal plugin API would make distribution and activation convenient, but
would couple Step execution, runtime invocation and Source materialization.
An adapter-only design would be smaller initially, but would prevent built-in
and future external Step types from using the same schema and lifecycle model.

## Decision

Use separate registries and contracts for:

- `Step types`;
- runtimes;
- `Source providers`.

Use a shared host-owned layer for metadata, compatibility, capability policy,
trust, authorization, lifecycle control, diagnostics, cancellation and
persistence.

The first implementation uses explicit static registration in the host. Built-
in Step types use the same definition and registration model as future
extensions, while their implementations may remain internal.

A future package may contribute to more than one registry, but every
contribution is validated, authorized and resolved independently. Dynamic
discovery is explicit and manifest-driven; automatic scanning, activation from
a `Source` and marketplace behavior are not part of this decision.

## Consequences

Positive consequences:

- built-ins exercise the same extension boundary as future types;
- Step lifecycle and runtime protocol remain host invariants;
- Source-specific resolution stays inside a `Source provider`;
- trust and capabilities can be applied per contribution instead of to an
  opaque universal plugin;
- the static first step avoids package loading and distribution complexity.

Trade-offs:

- a future package must implement more than one contract when it contributes
  to multiple registries;
- dynamic distribution and activation require a later manifest, fingerprint,
  signature and compatibility design;
- out-of-process execution provides operational isolation but is not a
  security sandbox by itself;
- the host must maintain adapters for runtimes whose launch behavior cannot be
  represented declaratively.
