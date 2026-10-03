# Private braces security backport

This directory contains a private, unpublished derivative of `braces@3.0.3`,
identified as `braces@3.0.3-chevoink.1`. The original name, author and MIT license
are retained. It is not an official upstream patched release.

Source retrieved and verified on 2026-10-03:

- Published source: https://registry.npmjs.org/braces/-/braces-3.0.3.tgz
- Published source commit: `74b2db2938fad48a2ea54a9c8bf27a37a62c350d`
- Tarball integrity: `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`
- Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- Proposed upstream fix (open at retrieval): https://github.com/micromatch/braces/pull/72
- Exact backported patch: https://github.com/micromatch/braces/commit/d0d575e55e74a4e0218e5248fafb79efc3e54ebb

The published tarball's SHA-512 integrity was checked before extracting it;
the original runtime files, README and license matched the installed 3.0.3 bytes.
Only the upstream patch's five runtime diffs (`compile`, `constants`, `expand`,
`parse`, `stringify`) were applied. Its unrelated unreleased source and documentation
changes were excluded. `index.js`, `utils.js`, README and LICENSE remain unchanged.

Two corrections to that patch preserve the intended narrow behavior:

1. Finite `maxDepth` values are rounded down before capping at 100, so 1.5 cannot
   permit two levels in the parser. Non-finite/non-numeric values use the safe cap.
2. Recursive `stringify` calls retain the released default parent argument while
   forwarding depth. Passing the current node as parent would change existing
   `escapeInvalid` output independently of security mitigation.

Parsing bounds combined brace/parenthesis nesting. The three recursive walkers
also bound direct AST child depth and child cycles. Ordinary AST structural
requirements still apply; malformed cyclic parent pointers, expansion cardinality
and AST width are outside this depth-only mitigation. Existing length/range limits
are retained.

The root manifest explicitly depends on this local package and uses npm's
`$braces` override reference so transitive consumers resolve the same root source.
A bare relative file override was found to resolve relative to a transitive
consumer under npm 10.9.8 and is deliberately avoided. Local-link lock entries have
no registry tarball integrity; `INTEGRITY.json` records SHA-256 of the committed
runtime/package/license/source documentation and the scoped tests verify those bytes
and all Tailwind/nodemon consumer paths after installation.
The scoped `.gitattributes` preserves LF bytes across Windows and Linux checkouts.

The upstream advisory remains relevant to unpatched published 3.0.3. npm audit's
handling of a local derivative does not certify its security; the source patch,
integrity and behavioral regressions provide the mitigation evidence. No audit
allowlist or threshold change is used. Existing unrelated findings remain visible.
Retire this private derivative when an official fixed release is available and
passes the same security and compatibility checks.
