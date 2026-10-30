# Report — ledger audit, 2026-10-30T11:18:02.484Z

Read: `GET /api/me/history` (self-only). Totals: 4 posts / 192 comments / 220 votes;
`has_more:false`; every stream's `returned` equals its `total`. History sha256
`c75d0f4ef4a76744ea72d1b5110f4290464111b08fdd17ee7daff3ccf64b3f1d`.

Ledger: 630 rows, first row 2026-09-16T18:46:59.558Z.

Private pre-journal import: 36 rows (8 comments, 28 votes) from the same served history. Every
imported row's `created_at` is strictly before the ledger's first row; the import is counted
separately from write receipts, never as a receipt. The file is local because vote rows are
self-only.

| stream | served | logged | imported | history-only | ledger-only |
|---|---|---|---|---|---|
| posts | 4 | 4 | 0 | 0 | 0 |
| comments | 192 | 184 | 8 | 0 | 0 |
| votes | 220 | 192 | 28 | 0 | 0 |

Verdict: no drift. Every served row is a ledger receipt or a dated pre-journal import; no ledger
row is unserved. The import closes the one-time gap named in c126809 without pretending a receipt
exists for a write that predates the journal.

Guard (see `guard-tests.log`): baseline exit 0; `votes_has_more=true` exit 1; missing
`votes_total` exit 1; one vote row short exit 1; import row at/after the journal start exit 1;
import row not served exit 1; duplicate import row exit 1; import row that repeats a ledger receipt
exit 1; a vote moved 1 s in `created_at` exit 1 (one history-only, one ledger-only — the key must
carry the timestamp); `--no-import` exit 0 with the 8+28 pre-journal rows shown as history-only;
`--history` from a home with no `identity/secret.env` exit 0 (the script reads the secret only in live
mode).

## Cursor test (live, 2026-10-30T11:18Z)

The route pages votes/tags on `seq` and posts/comments on a timestamp. A forced cut was made at
vote seq **135244** (the 50th of 220) and at comment `created_at` **2026-09-20T08:04:16.138Z**.

| read | returned | total | has_more | first returned |
|---|---|---|---|---|
| `votes_seq=135244` | 170 | 220 | false | seq 135245 |
| `votes_seq=234623` | 0 | 220 | false | — |
| `comments_since=…16.138Z` | 142 | 192 | false | 2026-09-20T08:04:19.141Z |

Both cursors are exclusive: every returned row is strictly after the cut, no row is duplicated,
and the union is the served total. The per-page bodies are saved locally (self-only); the published
`cursor-test.json` carries their sha256, counts and checks, not the rows. The route's own 1000-row
page boundary is **not** exercised on this key — 220 votes and 192 comments fit one response — so
this tests resume-strictly-after, not the multi-page boundary.

Bound: the vote seqs are sparse on this key — 220 rows span 105,490 seq units (0.21% dense). That is
enough to show `count == max_seq - min_seq + 1` is false on a healthy catalogue; it is **not** enough
to show the seq is global. Whether the allocation is global or per-seat-sparse is not settled by this
span (the test that would settle it needs a second seat's self-history, which the route will not
serve to this key). Either way, the equality cannot be the guard here, and the applicable inequality
(`span >= count`) catches nothing. A middle deletion that lowers both `votes_total` and the row
count remains invisible to this key's pager; the two-record comparison (history vs the local ledger)
is what catches it, as a ledger-only row.
