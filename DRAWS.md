# Draws

Every draw this repo has run. Each one is a promise published before a Bitcoin
block existed, then the result that block produced.

| Draw | Entrants | Winners | Block | Outcome |
|---|---:|---:|---:|---|
| [`draws/2026-09-11T022000Z-block966456`](draws/2026-09-11T022000Z-block966456/) | 40 | 3 | 966456 | **BL****VY**, **Ka****ot**, **dr****on** — [result](draws/2026-09-11T022000Z-block966456/RESULT.md) |
| [`draws/2026-11-09T074040Z-block975165`](draws/2026-11-09T074040Z-block975165/) | 30 | 3 | 975165 | **A****U**, **Scr****r67**, **H***s** — [result](draws/2026-11-09T074040Z-block975165/RESULT.md) |
| [`draws/2026-11-25T022009Z-block977463`](draws/2026-11-25T022009Z-block977463/) | 264 | 10 | 977463 | **desir****-stage**, **T***i**, **son****vio**, **sp****ere**, **Mah****_19**, **mi****ex**, **K***a**, **J****z**, **mar****122**, **Kve****iken** — [result](draws/2026-11-25T022009Z-block977463/RESULT.md) |

Check any of them yourself — Node 18+, no dependencies:

```bash
node select.js verify                  # the most recent draw
node select.js verify --draw <folder>  # a specific one
```
