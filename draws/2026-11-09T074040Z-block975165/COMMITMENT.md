# Draw commitment

**Status: committed. The winners are not yet known — to anyone, including us.**

| | |
|---|---|
| Eligible pool | 30 entrants — Rank 1-30, ascending |
| Winners to draw | 3 |
| Commitment hash | `1ba4cd9c65562ec8a5172c60de5c185021c34d4f5ec2ebbbb46fcebe3d7a6b22` |
| Randomness | Bitcoin block **975165** |
| Chain tip when committed | 975145 |
| Committed at | 2026-11-09T07:40:40.723Z |
| Entrant file | `entrants.json` — sha256 `f1b6e018201a35965d938495e748e5b4d309701a4f2a08dbc1f26043d9fd485c` |

The winners will be a deterministic function of the list below and the hash of that
block. The block did not exist when this was published (the tip was 975145),
so nobody could know or steer the outcome. See
[README](../../README.md#what-this-actually-does) for what that buys you.

Watch the block: <https://mempool.space/block/975165>

## Eligible entrants, in committed order

The commitment hash above is the SHA-256 of exactly these 30 identifiers, one per
line, in this order (see `commitmentHash` in [select.js](../../select.js)).

| # | Rank | Entrant |
|---:|---:|---|
| 1 | 1 | H***s |
| 2 | 2 | gett****wned |
| 3 | 3 | n****3 |
| 4 | 4 | le****aze |
| 5 | 5 | Eu****21 |
| 6 | 6 | Sh****er |
| 7 | 7 | Amt****gpp |
| 8 | 8 | Be****01 |
| 9 | 9 | t****25 |
| 10 | 10 | J****z |
| 11 | 11 | t**e |
| 12 | 12 | A****wa |
| 13 | 13 | Scr****r67 |
| 14 | 14 | Dr****ak |
| 15 | 15 | mi****ex |
| 16 | 16 | Us****66 |
| 17 | 17 | m****t |
| 18 | 18 | Andr****mania |
| 19 | 19 | mar****122 |
| 20 | 20 | S****A |
| 21 | 21 | C****S |
| 22 | 22 | A****U |
| 23 | 23 | F****Z |
| 24 | 24 | M****06 |
| 25 | 25 | H****50 |
| 26 | 26 | B****VY |
| 27 | 27 | dr****ton |
| 28 | 28 | Li****006 |
| 29 | 29 | D****er |
| 30 | 30 | Ato****ypto |

## Checking this after the draw

```bash
node select.js verify
```

That recomputes the hash above from the list above, re-reads the block hash from the
chain, and re-runs the draw. Anything altered after this commit shows up as a FAIL.
