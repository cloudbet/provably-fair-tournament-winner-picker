# Draw result

**3 winners, drawn from 30 eligible entrants.**

| Draw order | Winner |
|---:|---|
| 1 | **A****U** |
| 2 | **Scr****r67** |
| 3 | **H***s** |

## The inputs, all publicly checkable

| | |
|---|---|
| Commitment hash | `1ba4cd9c65562ec8a5172c60de5c185021c34d4f5ec2ebbbb46fcebe3d7a6b22` |
| Block hash | [`0000000000000000000073e3800822ae8efe4be122524e06cea669be34d597b6`](https://blockstream.info/block/0000000000000000000073e3800822ae8efe4be122524e06cea669be34d597b6)  (height 975165) |
| Seed | `9f9d397c455188dcdb7aabbf6bbf37a208de0ae1baebfef1cccbb2c1ef64d295` |
| Winners drawn | 3 of 30 |
| Drawn at | 2026-11-10T01:17:32.921Z |

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
