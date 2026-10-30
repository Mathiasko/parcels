# Fake parcel-mail harness

Dev-only. It runs the synthetic corpus in `test/fixtures/fake-mail/` through the real ingest → poll → web path,
with no network. It never reads `config.json` or `data/`: everything lives in a fresh `mktemp` directory,
built from `config.example.json`, and that directory is removed at the end.

```sh
N=$HOME/.nvm/versions/node/v24.21.0/bin
$N/node scripts/dev/fake-mail/generate-corpus.mjs     # (re)write the .eml files, corpus.json, MANIFEST.md
$N/node node_modules/.bin/vitest run --config scripts/dev/fake-mail/vitest.config.ts scripts/dev/fake-mail/harness.run.ts
$N/node node_modules/.bin/vitest run --config scripts/dev/fake-mail/vitest.config.ts scripts/dev/fake-mail/probes.run.ts
```

Env: `SHOTS=0` skips Chrome (the run then takes about 1 s instead of about 80 s). `KEEP=1` keeps the temp dir.

| File | What it is |
|---|---|
| `generate-corpus.mjs`, `mime.mjs`, `templates.mjs` | Corpus generator: MIME, encodings, carrier templates. |
| `world.ts` | Canned carrier answers per fake number, as a function of time. |
| `harness.run.ts` | The run. Network guard, 64 stepped `runPoll` runs with the IMAP fake, state dump, expectation check, then the web server on a random loopback port (fake calendar and notifier), HTML of every page, headless-Chrome shots (own profile; 390 px via an iframe over the saved HTML). |
| `probes.run.ts` | Direct `extract()` probes behind `FINDINGS.md`. |
| `dump-fixture.mjs` | Prints the decoded text of any `.eml`. |
| `vitest.config.ts` | Own config: includes only `*.run.ts` here, so the repo suite never picks these up. |

Outputs: `test/fixtures/fake-mail/out/RESULTS.md` (per-mail verdicts, parcels, run log, notifications) plus
JSON dumps, `html/` and `shots/`. Cropping the screenshots needs ImageMagick (`magick`); without it the run
still completes and the shots are left uncropped.
