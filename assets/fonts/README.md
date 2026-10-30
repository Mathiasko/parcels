# Postal's fonts

Committed woff2 files, so the Postal theme works fully offline. The app serves them itself
(`/fonts/<file>` from an allowlist of the ten flat `.woff2` names below; nothing else in this
directory is ever served). They were fetched once with `npm pack` from the fontsource packages
below and copied unmodified; nothing is added to `package.json`.

## Layout

- All ten `.woff2` files sit flat in `assets/fonts/`, under their fontsource names.
- Each family's licence is in its own subfolder: `dm-serif-display/OFL.txt`,
  `libre-franklin/OFL.txt`, `courier-prime/OFL.txt` (the package's `LICENSE`, byte for byte; it is
  the SIL Open Font License 1.1 with the family's copyright line).

## Families

| Family | npm package | Version | Upstream project | Licence |
|---|---|---|---|---|
| DM Serif Display | `@fontsource/dm-serif-display` | 5.3.0 | Google Fonts (`https://github.com/google/fonts`), via fontsource (`https://fontsource.org/fonts/dm-serif-display`) | SIL OFL 1.1 |
| Libre Franklin (variable) | `@fontsource-variable/libre-franklin` | 5.3.0 | The Libre Franklin Project (`https://github.com/googlefonts/Libre-Franklin`), via fontsource | SIL OFL 1.1 |
| Courier Prime | `@fontsource/courier-prime` | 5.3.0 | The Courier Prime Project (`https://github.com/quoteunquoteapps/CourierPrime`), via fontsource | SIL OFL 1.1 |

Copyright lines (from each `OFL.txt`):

- DM Serif Display: Copyright 2014 - 2017 Adobe Systems Incorporated (http://www.adobe.com/), with Reserved Font Name 'Source'. Copyright 2019 Google LLC.
- Libre Franklin: Copyright 2020 The Libre Franklin Project Authors (https://github.com/googlefonts/Libre-Franklin)
- Courier Prime: Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime)

## Files

| File | Family | Weight | Style | Subset |
|---|---|---|---|---|
| `dm-serif-display-latin-400-normal.woff2` | DM Serif Display | 400 | normal | latin |
| `dm-serif-display-latin-ext-400-normal.woff2` | DM Serif Display | 400 | normal | latin-ext |
| `dm-serif-display-latin-400-italic.woff2` | DM Serif Display | 400 | italic | latin |
| `dm-serif-display-latin-ext-400-italic.woff2` | DM Serif Display | 400 | italic | latin-ext |
| `libre-franklin-latin-wght-normal.woff2` | Libre Franklin Variable | variable | normal | latin |
| `libre-franklin-latin-ext-wght-normal.woff2` | Libre Franklin Variable | variable | normal | latin-ext |
| `courier-prime-latin-400-normal.woff2` | Courier Prime | 400 | normal | latin |
| `courier-prime-latin-ext-400-normal.woff2` | Courier Prime | 400 | normal | latin-ext |
| `courier-prime-latin-700-normal.woff2` | Courier Prime | 700 | normal | latin |
| `courier-prime-latin-ext-700-normal.woff2` | Courier Prime | 700 | normal | latin-ext |

Libre Franklin: the package declares the variable `wght` axis as 100 to 900 (its CSS says
`font-weight: 100 900`; `metadata.json` has `wght` min 100, max 900, default 400). Postal uses
400 to 800 of that range. The package's font-family name is `Libre Franklin Variable`, and its
CSS uses `format('woff2-variations')`. The italic variable files were not taken.

## `unicode-range` strings

Copied verbatim from the packages' CSS (`400.css` / `400-italic.css` for DM Serif Display, `400.css`
/ `700.css` for Courier Prime, `wght.css` for Libre Franklin) and `unicode.json`. All three
families, and every weight and style, use the same two strings:

- `latin`:
  `U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD`
- `latin-ext`:
  `U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF`

## Updating

In a new empty temp directory: `npm pack <package>@<version>`, extract each tarball into its own
subfolder (run nothing from inside), copy the files in `package/files/` named above and the
package's `LICENSE`, check each `.woff2` starts with the bytes `wOF2`, and update the versions here.
