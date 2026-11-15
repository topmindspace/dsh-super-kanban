# Localization

The browser follows DSH's native `locale` service. Explicit Chinese (`zh` or
`zh-*`) keeps the original interface. English and languages without a board
translation use English. Switching the host language updates mounted board,
header and overlay surfaces; label tables use getters rather than capturing the
language at module initialization. Date labels follow the same selection.

## Catalog and runtime boundary

`locales/en.mjs` is the single source-keyed English catalog. The original Chinese
message is the stable lookup key and the lossless Chinese fallback. Whole
templates use numbered placeholders (`{0}`, `{1}`, …), not translated fragments:
translators may reorder values without changing JavaScript evaluation order.
Unknown keys remain visible rather than becoming blank. Lookup checks own keys,
and interpolation uses a function replacement, preserving `$&`, backslashes,
HTML-looking text, paths and identifiers literally. This is text formatting, not
HTML rendering or code evaluation.

`server/i18n.mjs` owns the dependency-free translator. Server-authored labels,
rule explanations, continuation templates and AI instructions now default to
English. AI analysis requests English descriptions while retaining verbatim
evidence quotes. The explicitly requested Translate to Chinese action remains
available. Original session logs, user input, evidence, paths, IDs, relations and
stored card content are not automatically rewritten.

The browser is a hand-written DSH loader module, not an ESM build. To preserve
that deployment contract, `scripts/build-i18n.mjs` embeds the catalog and the exact
shared translator into one marked region of `client.js`. It does not introduce
a bundler, runtime dependency, remote language download or extra request. Both
the ESM catalog and server module are included in the npm package.

After editing translations:

```sh
node scripts/build-i18n.mjs
node scripts/build-i18n.mjs --check
node --test 'tests/**/*.test.mjs'
```

Checks cover catalog completeness, placeholder parity, Chinese fallback,
unsupported languages, literal interpolation, native language changes, date
locale, English browser output and preservation of raw evidence. Existing
Chinese UI contracts are still exercised explicitly. Scan finalization uses a
structural completion marker rather than parsing a translated message prefix.

## Existing cards

Changing UI language is not a data migration. Previously generated descriptions
retain their stored language. Optional instance-private display translations live
at `$DSH_HOME/storages/super-kanban/translations.en.json`: a JSON object mapping
exact original strings to English strings. `server/text-projection.mjs` validates
and caches this bounded, regular local file, and reloads it when it changes.
Invalid files are ignored without logging their private contents. No translation
service is called automatically. Only card descriptions are projected; raw
evidence, source-session titles, paths, IDs and execution state stay untouched.
State views, task-command responses and continuation drafts use the projection;
exports and the authoritative store retain their original content. The file is
instance data, never part of the public package or PR.

Any instance-specific translation of that content
must preserve task IDs, relations, status, completion/review state, provenance,
locks and original evidence. Never commit private card translations or session
content into this public catalog. Do not use `task.update` as a silent migration:
it intentionally marks automatic cards as user-edited.
