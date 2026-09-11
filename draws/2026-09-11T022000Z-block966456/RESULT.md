# Draw result

**3 winners, drawn from 40 eligible entrants.**

| Draw order | Winner |
|---:|---|
| 1 | **BL****VY** |
| 2 | **Ka****ot** |
| 3 | **dr****on** |

## The inputs, all publicly checkable

| | |
|---|---|
| Commitment hash | `9e39d05debddb19d968f489bac9d54d17bfb74e443ed1822f8feb1728dd5cd5f` |
| Block hash | [`00000000000000000000374b22c2c5829514c2b12990808f6beafa9ed35b9077`](https://blockstream.info/block/00000000000000000000374b22c2c5829514c2b12990808f6beafa9ed35b9077)  (height 966456) |
| Seed | `f9a72c2ea5203126bd9db7c1635f9640ecbfc50d7e7fa4e58b5c324518c5d7d7` |
| Winners drawn | 3 of 40 |
| Drawn at | 2026-09-11T06:25:46.278Z |

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
