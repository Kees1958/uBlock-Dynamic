# vendor/autoconsent/

`LICENSE` in this directory is the exact MPL-2.0 text, fetched verbatim
from `duckduckgo/autoconsent`'s own repository. It applies to **part**
of this directory's content — see `THIRD_PARTY_LICENSES.md` (project
root's docs) for the full account. Short version:

`rules.json`'s own `_provenance` field (more detailed than either
file's top-of-file comment) confirms **mixed provenance**, tagged
per-entry via each rule's own `_source` field:

- **11 of 26 original entries** are adapted (not copy-pasted) from
  `duckduckgo/autoconsent`'s own real rule definitions — MPL-2.0
  applies to these.
- **15 of 26 original entries** are independently hand-authored against
  each CMP's own public documentation/markup — MPL-2.0 does not apply
  to these.

Batches added since (Consent-O-Matic, DDG batch 4) are additional to
this original 26 — see `THIRD_PARTY_LICENSES.md` for the full,
current, per-batch counts.

Per-file/per-function MPL-2.0 notices aren't practical for this kind of
fine-grained mix — this directory-level `LICENSE` file is exactly the
mechanism MPL-2.0 §3.1 itself provides for that case.
