# Draws

Every draw this repo has run. Each one is a promise published before a Bitcoin
block existed, then the result that block produced.

| Draw | Entrants | Winners | Block | Outcome |
|---|---:|---:|---:|---|
| [`draws/2026-09-11T022000Z-block966456`](draws/2026-09-11T022000Z-block966456/) | 40 | 3 | 966456 | _waiting for block 966456_ — [commitment](draws/2026-09-11T022000Z-block966456/COMMITMENT.md) |

Check any of them yourself — Node 18+, no dependencies:

```bash
node select.js verify                  # the most recent draw
node select.js verify --draw <folder>  # a specific one
```
