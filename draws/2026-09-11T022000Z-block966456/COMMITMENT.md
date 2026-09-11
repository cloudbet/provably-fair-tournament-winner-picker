# Draw commitment

**Status: committed. The winners are not yet known — to anyone, including us.**

| | |
|---|---|
| Eligible pool | 40 entrants — Rank 11-50, ascending |
| Winners to draw | 3 |
| Commitment hash | `9e39d05debddb19d968f489bac9d54d17bfb74e443ed1822f8feb1728dd5cd5f` |
| Randomness | Bitcoin block **966456** |
| Chain tip when committed | 966436 |
| Committed at | 2026-09-11T02:20:00.974Z |
| Entrant file | `entrants.json` — sha256 `a7adf801db18c652d9e46d7c523c800f4812d041f1773cea94c2aa07281e987c` |

The winners will be a deterministic function of the list below and the hash of that
block. The block did not exist when this was published (the tip was 966436),
so nobody could know or steer the outcome. See
[README](../../README.md#what-this-actually-does) for what that buys you.

Watch the block: <https://blockstream.info/block/966456>

## Eligible entrants, in committed order

The commitment hash above is the SHA-256 of exactly these 40 identifiers, one per
line, in this order (see `commitmentHash` in [select.js](../../select.js)).

| # | Rank | Entrant |
|---:|---:|---|
| 1 | 11 | mi****zo |
| 2 | 12 | bo****ey |
| 3 | 13 | Co****ag |
| 4 | 14 | Aw****wa |
| 5 | 15 | Je****22 |
| 6 | 16 | An****ia |
| 7 | 17 | mi****ex |
| 8 | 18 | Ka****ot |
| 9 | 19 | ge****ed |
| 10 | 20 | pa****96 |
| 11 | 21 | Jo****23 |
| 12 | 22 | j9****08 |
| 13 | 23 | re****de |
| 14 | 24 | Dr****ak |
| 15 | 25 | ch****ry |
| 16 | 26 | Ra****uh |
| 17 | 27 | Su****ps |
| 18 | 28 | dr****on |
| 19 | 29 | SH****MA |
| 20 | 30 | Ca****nD |
| 21 | 31 | Ho****cs |
| 22 | 32 | il****it |
| 23 | 33 | em****ge |
| 24 | 34 | CB****AS |
| 25 | 35 | MA****AC |
| 26 | 36 | DA****O2 |
| 27 | 37 | MA****EF |
| 28 | 38 | EN****CE |
| 29 | 39 | Du****ne |
| 30 | 40 | Df****er |
| 31 | 41 | MB****06 |
| 32 | 42 | CO****LI |
| 33 | 43 | IF****YA |
| 34 | 44 | OF****SS |
| 35 | 45 | SU****YA |
| 36 | 46 | FR****EZ |
| 37 | 47 | A8****RU |
| 38 | 48 | HI****50 |
| 39 | 49 | BL****VY |
| 40 | 50 | Mu****23 |

## Checking this after the draw

```bash
node select.js verify
```

That recomputes the hash above from the list above, re-reads the block hash from the
chain, and re-runs the draw. Anything altered after this commit shows up as a FAIL.
