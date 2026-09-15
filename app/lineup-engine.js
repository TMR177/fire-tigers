/* Fire Tigers — lineup planner.
 *
 * Builds an inning-by-inning defensive plan that pays down whoever the season
 * has short-changed. Pure functions, no I/O, no DOM — so it runs the same in
 * the browser and in node, and can be tested without a database.
 *
 * The core idea: a 3-inning game cannot be fair on its own. Fairness is a
 * season-long ledger, and each game's plan spends its innings on whoever is
 * owed the most. Innings 1-3 get the debts because the clock usually eats
 * anything after that.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LineupEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INFIELD  = ['P', 'C', '1B', '2B', '3B', 'SS'];
  var OUTFIELD = ['LF', 'LCF', 'CF', 'RCF', 'RF'];
  var PREMIUM  = ['P', 'C', '1B', 'SS'];   // the spots kids actually want

  var IS_INFIELD = toSet(INFIELD);
  var IS_PREMIUM = toSet(PREMIUM);

  var DEFAULTS = {
    wSeasonPos:  3,    // nudge away from repeating a position across the season
    wGamePos:  100,    // effectively forbid repeating a position within a game
    wGroup:      5,    // pull toward an even infield / outfield split
    wPremium:    4,    // spread P, C, 1B, SS around
    wBenchSeason: 3,   // who is due to sit
    wBenchGame:  12,   // strongly avoid sitting twice in one game
    wBackToBack: 500,  // effectively forbid sitting two innings running
    maxSwapPasses: 12
  };

  function toSet(arr) {
    var s = {};
    for (var i = 0; i < arr.length; i++) s[arr[i]] = true;
    return s;
  }

  function positionsFor(hasCatcher) {
    var p = INFIELD.concat(OUTFIELD);
    return hasCatcher ? p : p.filter(function (x) { return x !== 'C'; });
  }

  /* Running tallies: the season ledger plus whatever this game has spent so far. */
  function newState(players, ledger) {
    var st = { pos: {}, inf: {}, out: {}, bench: {}, premium: {}, satLast: {} };
    players.forEach(function (p) {
      var L = (ledger && ledger[p.id]) || {};
      st.pos[p.id]     = Object.assign({}, L.pos || {});
      st.inf[p.id]     = L.infield  || 0;
      st.out[p.id]     = L.outfield || 0;
      st.bench[p.id]   = L.bench    || 0;
      st.premium[p.id] = L.premium  || 0;
      st.satLast[p.id] = false;
    });
    return st;
  }

  function cost(id, pos, st, canCatch, w) {
    if (pos === 'C' && !canCatch) return Infinity;
    var c = 0;
    c += w.wSeasonPos * (st.pos[id][pos] || 0);
    c += w.wGamePos   * (st.pos[id]['_game_' + pos] || 0);
    c += w.wGroup     * (IS_INFIELD[pos] ? st.inf[id] : st.out[id]);
    if (IS_PREMIUM[pos]) c += w.wPremium * st.premium[id];
    return c;
  }

  /* Greedy minimum-cost assignment, then pairwise swaps until nothing improves.
   * With 11 spots and 15 kids this lands on the optimum in practice, and it is
   * far easier to reason about than a full Hungarian solve. */
  function assign(candidates, positions, st, catchable, w) {
    var C = {};   // C[id][pos]
    candidates.forEach(function (id) {
      C[id] = {};
      positions.forEach(function (pos) {
        C[id][pos] = cost(id, pos, st, !!catchable[id], w);
      });
    });

    /* Most constrained position first.
     *
     * Sorting every pairing by cost and taking the cheapest looks right, but it
     * starves scarce positions: with one gear-owning kid, catcher has exactly
     * one eligible player, and the scramble hands that kid an easier spot
     * first. Catcher is then unfillable and sits open all game. Fill the
     * positions with the fewest eligible players before the rest. */
    var eligible = {};
    positions.forEach(function (pos) {
      eligible[pos] = candidates.filter(function (id) {
        return C[id][pos] !== Infinity;
      }).length;
    });
    var order = positions.slice().sort(function (a, b) {
      return eligible[a] - eligible[b];
    });

    var takenId = {}, result = {};
    order.forEach(function (pos) {
      var best = null, bestCost = Infinity;
      candidates.forEach(function (id) {
        if (takenId[id]) return;
        if (C[id][pos] < bestCost) { bestCost = C[id][pos]; best = id; }
      });
      result[pos] = best;
      if (best) takenId[best] = true;
    });
    positions.forEach(function (pos) { if (!(pos in result)) result[pos] = null; });

    for (var pass = 0; pass < w.maxSwapPasses; pass++) {
      var improved = false;
      for (var i = 0; i < positions.length; i++) {
        for (var j = i + 1; j < positions.length; j++) {
          var pa = positions[i], pb = positions[j];
          var x = result[pa], y = result[pb];
          if (!x && !y) continue;
          var now  = (x ? C[x][pa] : 0) + (y ? C[y][pb] : 0);
          var swap = (x ? C[x][pb] : 0) + (y ? C[y][pa] : 0);
          if (swap < now) { result[pa] = y; result[pb] = x; improved = true; }
        }
      }
      if (!improved) break;
    }
    return result;
  }

  /* reserved: players who must stay on the field this inning because nobody
     else can cover a position they hold — in practice the gear-owning catcher.
     Benching them leaves catcher unfillable no matter how the rest is solved. */
  function pickBench(available, benchSize, st, w, reserved) {
    if (benchSize <= 0) return [];
    var pool = available.filter(function (id) { return !(reserved && reserved[id]); });
    if (pool.length < benchSize) pool = available;   // not enough kids to protect
    var scored = pool.map(function (id) {
      return {
        id: id,
        score: w.wBenchSeason * st.bench[id]
             + w.wBenchGame   * (st.pos[id]._gameBench || 0)
             + (st.satLast[id] ? w.wBackToBack : 0)
      };
    });
    scored.sort(function (a, b) { return a.score - b.score; });
    return scored.slice(0, benchSize).map(function (s) { return s.id; });
  }

  /**
   * planGame({ players, present, innings, hasCatcher, ledger, weights })
   *
   *   players    [{ id, name, canCatch }]
   *   present    [id]            who is actually at the field
   *   innings    how many innings to plan (plan deeper than you expect to play)
   *   hasCatcher whether anyone is catching today
   *   ledger     { id: { pos:{POS:n}, infield, outfield, bench, premium } }
   *
   * returns { positions, grid:[{POS:id|null}], bench:[[id]], warnings:[] }
   */
  function planGame(opts) {
    var w = Object.assign({}, DEFAULTS, opts.weights || {});
    var players = opts.players || [];
    var present = opts.present || players.map(function (p) { return p.id; });
    var innings = opts.innings || 3;
    var warnings = [];

    var byId = {}, catchable = {};
    players.forEach(function (p) { byId[p.id] = p; catchable[p.id] = !!p.canCatch; });
    present = present.filter(function (id) { return byId[id]; });

    var hasCatcher = !!opts.hasCatcher;
    if (hasCatcher && !present.some(function (id) { return catchable[id]; })) {
      hasCatcher = false;
      warnings.push('No catcher-capable player is here, so the plan uses 10 fielders.');
    }
    var positions = positionsFor(hasCatcher);

    /* One gear-owner means they catch every inning and never sit. That is the
       honest consequence of playing with a catcher when only one kid can, but
       it is a coaching decision, not something to bury. */
    if (hasCatcher) {
      var gearHere = present.filter(function (id) { return catchable[id]; });
      if (gearHere.length === 1) {
        warnings.push((byId[gearHere[0]].name || 'The only catcher') +
          ' is the only one who can catch, so they will be behind the plate every ' +
          'inning and never sit. Turn the catcher off, or flag another kid, to ' +
          'rotate them.');
      }
    }

    if (present.length < positions.length) {
      warnings.push('Only ' + present.length + ' players for ' + positions.length +
                    ' spots — some positions will start open.');
    }

    var st = newState(players, opts.ledger);
    var grid = [], benches = [];

    for (var inn = 0; inn < innings; inn++) {
      var benchSize = Math.max(0, present.length - positions.length);

      // Keep one catcher off the bench — whichever has caught least, so the job
      // still rotates among them when more than one owns gear.
      var reserved = {};
      if (hasCatcher) {
        var withGear = present.filter(function (id) { return catchable[id]; });
        if (withGear.length) {
          withGear.sort(function (a, b) {
            return (st.pos[a].C || 0) - (st.pos[b].C || 0);
          });
          reserved[withGear[0]] = true;
        }
      }
      var bench = pickBench(present, benchSize, st, w, reserved);
      var onBench = toSet(bench);
      var candidates = present.filter(function (id) { return !onBench[id]; });

      var row = assign(candidates, positions, st, catchable, w);
      grid.push(row);
      benches.push(bench);

      // Roll the tallies forward so the next inning sees what this one spent.
      present.forEach(function (id) { st.satLast[id] = false; });
      bench.forEach(function (id) {
        st.bench[id]++;
        st.pos[id]._gameBench = (st.pos[id]._gameBench || 0) + 1;
        st.satLast[id] = true;
      });
      positions.forEach(function (pos) {
        var id = row[pos];
        if (!id) return;
        st.pos[id][pos] = (st.pos[id][pos] || 0) + 1;
        st.pos[id]['_game_' + pos] = (st.pos[id]['_game_' + pos] || 0) + 1;
        if (IS_INFIELD[pos]) st.inf[id]++; else st.out[id]++;
        if (IS_PREMIUM[pos]) st.premium[id]++;
      });
    }

    return { positions: positions, grid: grid, bench: benches, warnings: warnings };
  }

  /* Who bats, in order, starting from the season pointer and skipping anyone
   * absent or done for the day. This is the fix for the bottom of the order
   * losing an at-bat every week. */
  function battingOrder(players, present, startIndex) {
    var here = toSet(present);
    var order = players.slice().sort(function (a, b) {
      return (a.batsOrder || 0) - (b.batsOrder || 0);
    });
    var n = order.length, out = [], i;
    for (i = 0; i < n; i++) {
      var p = order[(startIndex + i) % n];
      if (here[p.id]) out.push(p);
    }
    return out;
  }

  /* Batting order for today, built from who the season owes at-bats to.
   *
   * The fixed-order alternative loses roughly half an at-bat per game for
   * whoever sits at the bottom, because an 8-batter cap over 3 innings never
   * reaches them. Sorting by need each game closes that gap, at the cost of
   * nobody having a permanent slot — which at this age nobody is tracking.
   *
   * Rate, not total: a kid who missed two games should not jump the order for
   * at-bats they were never there to take.
   */
  function battingOrderByNeed(players, present, stats) {
    var here = {};
    (present || []).forEach(function (id) { here[id] = true; });
    return players.filter(function (p) { return here[p.id]; })
      .slice()
      .sort(function (a, b) {
        var A = (stats && stats[a.id]) || { pa: 0, games: 0 };
        var B = (stats && stats[b.id]) || { pa: 0, games: 0 };
        var ra = A.games ? A.pa / A.games : 0;
        var rb = B.games ? B.pa / B.games : 0;
        if (ra !== rb) return ra - rb;
        if (A.pa !== B.pa) return A.pa - B.pa;
        return (a.batsOrder || 0) - (b.batsOrder || 0);  // stable tiebreak
      });
  }

  /* Fold a played game into the season ledger. */
  function applyToLedger(ledger, plan, playedInnings) {
    var L = JSON.parse(JSON.stringify(ledger || {}));
    function ensure(id) {
      if (!L[id]) L[id] = { pos: {}, infield: 0, outfield: 0, bench: 0, premium: 0 };
      return L[id];
    }
    var n = Math.min(playedInnings, plan.grid.length);
    for (var i = 0; i < n; i++) {
      plan.positions.forEach(function (pos) {
        var id = plan.grid[i][pos];
        if (!id) return;
        var e = ensure(id);
        e.pos[pos] = (e.pos[pos] || 0) + 1;
        if (IS_INFIELD[pos]) e.infield++; else e.outfield++;
        if (IS_PREMIUM[pos]) e.premium++;
      });
      plan.bench[i].forEach(function (id) { ensure(id).bench++; });
    }
    return L;
  }

  return {
    INFIELD: INFIELD, OUTFIELD: OUTFIELD, PREMIUM: PREMIUM,
    positionsFor: positionsFor,
    planGame: planGame,
    battingOrder: battingOrder,
    battingOrderByNeed: battingOrderByNeed,
    applyToLedger: applyToLedger,
    DEFAULTS: DEFAULTS
  };
}));
