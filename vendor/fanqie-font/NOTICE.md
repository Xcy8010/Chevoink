# Fanqie public-font character mapping

The character data in `api/lib/fanqie-font-map.ts` is adapted from row 0 of
[`ying-ck/fanqienovel-downloader/src/charset.json`](https://github.com/ying-ck/fanqienovel-downloader/blob/4cbb46e9038f2d714407745898380cf02c629deb/src/charset.json),
at commit `4cbb46e9038f2d714407745898380cf02c629deb` (2026-08-16).
The upstream project is licensed under AGPL-3.0. Its full license is preserved
in this directory. Chevoink is also distributed under AGPL-3.0.

The associated upstream decoding implementation is `src/main.py`,
`CODE`, `interpreter` and `str_interpreter`. This integration uses only the
first published character table, preserving unknown entries unchanged.

The mapping is used for the public `DNMrHsV173Pd4pgy` font version
`dc027189e0ba4cd`, observed on the original site's public chapter response.
Both WOFF and WOFF2 URLs are declared by that response. The inspected WOFF
SHA-256 is `ba1a867e395a7f8bca99dd13a0d6428b8f12fc9c38e3a0b2c3522b98f41763fe`.
Its CFF glyph names and cmap establish the codepoint-to-glyph relationship;
the upstream character facts supply glyph-to-character values. This does
not assert that an unknown font or an unobserved chapter is complete.
