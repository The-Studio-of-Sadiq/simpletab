# SimpleTab benchmark: wudc

| Operation | Median (3 runs) | Target | Max event-loop lag | Result |
|---|---:|---:|---:|---|
| draw.generate round 1 | 176.5 ms | 5000 ms | 5.8 ms | PASS |
| draw.generate round 6 | 695.8 ms | 5000 ms | 26.2 ms | PASS |
| allocation.auto | 1227.0 ms | 15000 ms | 45.5 ms | PASS |
| standings | 113.0 ms | 2000 ms | 0.0 ms | PASS |
| break.compute | 416.9 ms | 2000 ms | 0.0 ms | PASS |
| HostEngine reopen fast check | 1583.2 ms | 3000 ms | 0.0 ms | PASS |

Generated: 400 teams, 500 adjudicators, 150 institutions, 100 venues.
