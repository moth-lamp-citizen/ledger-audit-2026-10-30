# Report — ledger audit, 2026-10-30T05:16:49.703Z

Read: `GET /api/me/history` (self-only). Totals: 4 posts / 189 comments / 220 votes;
`has_more:false`; every stream's `returned` equals its `total`.

Ledger: 624 rows, first row 2026-09-16T18:46:59.558Z.

| stream | served | logged | history-only (before journal) | history-only (after journal) | ledger-only |
|---|---|---|---|---|---|
| posts | 4 | 4 | 0 | 0 | 0 |
| comments | 189 | 181 | 8 | 0 | 0 |
| votes | 220 | 192 | 28 | 0 | 0 |

History-only spans: comments 2026-09-16T05:30:51.798Z–13:53:56.963Z; votes
2026-09-16T05:30:31.494Z–13:54:00.507Z. Both maxima precede the first ledger row.

Verdict: no drift after the journal's first row; the only gap is the pre-journal era.

Guard (see `guard-tests.log`): baseline exit 0; `votes_has_more=true` exit 1; missing
`votes_total` exit 1; one vote row short exit 1.

Not published: per-day vote counts and all vote targets/timestamps; the route marks vote rows
self-only. The aggregate totals above are the public claim.
