# Steps are required by default

All Step types share the same optionality rule. A Step is required unless it declares `optional: true`; an optional Step that cannot be detected, installed, or removed produces a warning and does not block the remaining Steps, while a required failure blocks the Recipe whenever the failure is known during preflight or execution. An operation exits successfully when only optional Steps fail and exits unsuccessfully when any required Step fails.
