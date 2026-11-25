# Draw result

**10 winners, drawn from 264 eligible entrants.**

| Draw order | Winner |
|---:|---|
| 1 | **desir****-stage** |
| 2 | **T***i** |
| 3 | **son****vio** |
| 4 | **sp****ere** |
| 5 | **Mah****_19** |
| 6 | **mi****ex** |
| 7 | **K***a** |
| 8 | **J****z** |
| 9 | **mar****122** |
| 10 | **Kve****iken** |

## The inputs, all publicly checkable

| | |
|---|---|
| Commitment hash | `c170d6b68436cbaf795c1a84cae38be999c8299c4c60b5bd6adfd96cdac0c20f` |
| Block hash | [`0000000000000000000111dde3f507ef4fe855a10634b6045c00c132d752f3a6`](https://mempool.space/block/0000000000000000000111dde3f507ef4fe855a10634b6045c00c132d752f3a6)  (height 977463) |
| Seed | `768322b025422923f2e327829289b6def456b7ccafe4c6479527ce319af80718` |
| Winners drawn | 10 of 264 |
| Drawn at | 2026-11-25T07:12:34.657Z |

The commitment hash and the block height were published in
[COMMITMENT.md](COMMITMENT.md) **before** that block was mined — that commit is in this
repo's history, timestamped. The eligible list is there too.

## Verify it yourself

You do not have to trust any of the above. Node 18+, no dependencies:

```bash
node select.js verify
```

It re-derives the eligible pool, re-reads the block hash from the live chain, re-runs
the draw, and prints a check per line — ending in `PASS` if, and only if, the winners
above follow from the committed inputs. Exit code 0 means pass, 1 means something was
tampered with.

How it works, in full: [README.md](../../README.md).
