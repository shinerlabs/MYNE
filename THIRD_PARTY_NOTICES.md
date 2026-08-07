# Third-party notices and asset provenance

MYNE source is currently source-visible but not licensed for reuse; see [`README.md`](README.md).
Third-party rights are separate and remain with their respective owners. Inclusion here is for
provenance and attribution tracking, not an assertion of affiliation, endorsement or permission.

## Recorded identifiers and marks

The client contains visual identifiers for Solana, Switchboard, Circle/USDC and supported wallet
providers. Those names and marks identify compatible networks, services, assets or wallets and may
be protected trademarks. Their use must follow each owner's current brand and trademark terms.
Before a public release bundle is frozen, record the exact source URL, retrieved revision/date and
applicable brand permission for every shipped file in this category.

## Unresolved asset gates

The following provenance is not established by the repository and must not be guessed from visual
similarity or filenames:

- `Frontend/public/stickers/animated/` — exact upstream source, revision, per-file license and
  required attribution are not recorded. Some names resemble assets from public emoji projects,
  but that is not sufficient evidence that these copies share the same origin or license.
- `Frontend/public/stickers/custom/` — source and redistribution permission for the meme/character
  images are not recorded.
- Wallet artwork embedded by `Frontend/src/wallet-logos.js` — the source comment names RainbowKit,
  but the exact upstream revision, copied-file mapping and required license/copyright notice are
  absent.
- `Frontend/public/switchboard-logo.svg` and other third-party brand files — the originating file,
  retrieval date and applicable brand-use terms are not recorded in this repository.

These are release blockers for a professionally redistributable public repository. Before release,
either remove each unresolved asset and its manifest/reference or add verifiable provenance,
permission and all required notices. Do not label an asset Apache, MIT, OFL, Creative Commons or
project-owned without evidence tying the exact local file to that grant.

## Contribution rule

Every future third-party asset change must include, in the same pull request:

1. upstream owner and canonical source URL;
2. exact version, commit or retrieval date;
3. license or written permission covering the local copy;
4. required copyright, attribution and trademark notices; and
5. the complete list or directory scope of files covered.

Assets without that record should fail closed and remain outside the public/production bundle.
