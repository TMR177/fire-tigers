# Fire Tigers — Lineup & Rotation

Game-day lineup, position rotation and batting-order app for the Fire Tigers
(WGLL Single A machine pitch, Fall 2026).

**App:** https://tmr177.github.io/fire-tigers/ — coaches, sign in by email
**Family view:** `/view.html#<token>` — read-only, link handed out by the coach

## What's here

| File | |
|---|---|
| `index.html` | the app — roll call, dugout, plan grid, season ledger |
| `app/lineup-engine.js` | the planner: fairness-weighted position assignment |
| `app/store.js` | local-first data layer; the UI only ever reads local state |
| `app/supabase-store.js` | sync + realtime + auth on top of it |
| `view.html` | family read-only page |

## Design notes

**Offline is the normal case, not the edge case.** Ball fields have no signal.
Writes land locally and drain to the server when service returns, so the app
never blocks on the network mid-inning.

**Fairness is a season ledger, not a per-game property.** A 3-inning game cannot
be fair to 15 kids. The planner scores each kid-to-position pairing against
what the season already owes them, and front-loads those debts into innings 1-3
because the clock usually eats the rest.

**The batting order carries across games.** An 8-batter cap over 3 innings means
the bottom of a 15-deep order loses an at-bat every week if the order restarts.
It doesn't restart.

## Privacy

Players are stored and displayed as first name + last initial. There is nowhere
in the schema to put a surname, address or contact detail. Row-level security
means the publishable key in `app/config.js` reads nothing at all until a team
member is signed in — that key is safe in the open by design; the secret key is
not in this repo and never will be. The family view's token is a credential and
is likewise never committed.

No roster data lives in this repo.
