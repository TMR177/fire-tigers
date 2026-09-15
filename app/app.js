/* Fire Tigers — app. Renders from local state, writes through the store. */
(function () {
  'use strict';
  var E = window.LineupEngine;
  var CFG = window.FT_CONFIG;
  var store = new window.SupabaseStore(CFG);

  var gameId = null, inning = 1, view = 'dugout';
  var IF = {}, PREM = {};
  E.INFIELD.forEach(function (p) { IF[p] = 1; });
  E.PREMIUM.forEach(function (p) { PREM[p] = 1; });

  function $(s) { return document.querySelector(s); }
  function el(t, c, x) {
    var n = document.createElement(t);
    if (c) n.className = c;
    if (x != null) n.textContent = x;
    return n;
  }
  function S() { return store.state; }
  function game() {
    return S().games.filter(function (g) { return g.id === gameId; })[0] || null;
  }
  function chipClass(p) { return p === 'C' ? 'c' : (IF[p] ? 'if' : 'of'); }
  function positions() { var g = game(); return E.positionsFor(!!(g && g.hasCatcher)); }

  var EXPECTED_INNINGS = 3;   // what 90 minutes usually buys

  /* How many innings the UI will let you address. Fixed at five, this silently
     capped a fast game: you could not assign anyone to a sixth. Always keep two
     spare beyond whatever has been played, up to the 12 the database allows. */
  function maxInnings() {
    var g = game();
    var played = (g && g.inningsPlayed) || 0;
    return Math.min(12, Math.max(5, played + 2));
  }
  function attOf(id) {
    var a = S().attendance[gameId] || {};
    return a[id] || 'present';
  }
  function presentIds() {
    return S().players.filter(function (p) { return attOf(p.id) === 'present'; })
                      .map(function (p) { return p.id; });
  }
  function nameOf(id) {
    var p = S().players.filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }
  function lineupFor(inn) {
    var g = (S().assignments[gameId] || {});
    return g[inn] || {};
  }

  /* ------------------------------------------------------------------ gate */

  function showGate(msg, isErr) {
    $('#gate').hidden = false;
    $('#app').hidden = true;
    if (msg) {
      var m = $('#gateMsg');
      m.textContent = msg;
      m.className = 'msg' + (isErr ? ' err' : '');
    }
  }

  $('#gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('#gateEmail').value.trim();
    if (!email) return;
    $('#gateBtn').disabled = true;
    $('#gateMsg').textContent = 'Sending…';
    store.signIn(email).then(function (r) {
      $('#gateBtn').disabled = false;
      if (r.error) {
        showGate(r.error.message, true);
      } else {
        showGate('Check ' + email + ' and tap the link. It opens straight back here.');
      }
    });
  });

  /* --------------------------------------------------------------- chrome */

  function renderBar() {
    var g = game();
    if (!g) { $('#gbOpp').textContent = 'No game selected'; $('#gbMeta').textContent = ''; return; }
    var d = new Date(g.startsAt);
    $('#gbOpp').textContent = (g.homeAway === 'away' ? '@ ' : 'vs. ') + (g.opponent || '');
    $('#gbMeta').textContent = d.toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    var limit = g.timeLimit || 90;
    $('#gbLimit').textContent = '/' + Math.floor(limit / 60) + ':' +
      String(limit % 60).padStart(2, '0');

    if (g.status === 'live' && g.clockStartedAt) {
      var mins = Math.max(0, Math.round((Date.now() - new Date(g.clockStartedAt)) / 60000));
      $('#gbTime').firstChild.nodeValue = Math.floor(mins / 60) + ':' +
        String(mins % 60).padStart(2, '0');
      $('#gbBar').style.width = Math.min(100, mins / limit * 100) + '%';
      $('#gbFlag').textContent = mins >= limit ? 'Time is up'
        : (mins > limit - 25 ? 'Likely last inning' : '');
    } else {
      $('#gbTime').firstChild.nodeValue = '—';
      $('#gbBar').style.width = '0';
      $('#gbFlag').textContent = g.status === 'final' ? 'Final' : '';
    }

    var pending = S().pendingOps.length;
    var sync = store.online && !pending;
    var badge = $('#syncRoll');
    if (pending && store.lastError) {
      // A write that keeps failing used to sit in the queue invisibly.
      badge.textContent = 'Sync problem: ' + String(store.lastError).slice(0, 48);
    } else {
      badge.textContent = sync ? 'Synced'
        : (store.online ? 'Saving…' : 'Offline — will sync');
    }
    badge.className = 'sync' + (sync ? '' : ' off');
  }

  function renderGamePick() {
    var sel = $('#gamePick');
    sel.innerHTML = '';
    S().games.forEach(function (g) {
      var d = new Date(g.startsAt);
      var o = el('option', null,
        d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
        (g.homeAway === 'away' ? '@ ' : 'vs. ') + (g.opponent || ''));
      o.value = g.id;
      if (g.id === gameId) o.selected = true;
      sel.appendChild(o);
    });
  }
  $('#gamePick').addEventListener('change', function (e) {
    gameId = e.target.value; inning = 1; renderAll();
  });

  /* ------------------------------------------------------------ roll call */

  function renderRoll() {
    var L = $('#rollList');
    L.innerHTML = '';
    if (!S().players.length) {
      L.appendChild(el('div', 'empty', 'No roster loaded.'));
      return;
    }
    S().players.forEach(function (p) {
      var st = attOf(p.id);
      var r = el('div', 'row' + (st !== 'present' ? ' sat' : ''));
      r.appendChild(el('span', 'nm', p.name));
      var grp = el('div', 'att');
      [['present', 'In'], ['out', 'Out'], ['absent', 'Absent']].forEach(function (o) {
        var b = el('button', null, o[1]);
        b.setAttribute('aria-pressed', st === o[0]);
        b.onclick = function () { store.setAttendance(gameId, p.id, o[0]); };
        grp.appendChild(b);
      });
      r.appendChild(grp);
      // Catcher flag: willing AND has their own gear.
      var c = el('button', 'gear' + (p.canCatch ? ' on' : ''), 'C');
      c.title = p.canCatch ? 'Can catch — tap to clear' : 'Mark as a catcher';
      c.setAttribute('aria-pressed', !!p.canCatch);
      c.onclick = function () { store.setCanCatch(p.id, !p.canCatch); };
      r.appendChild(c);
      L.appendChild(r);
    });
    var gear = S().players.filter(function (p) { return p.canCatch; }).length;
    $('#rollCount').textContent = presentIds().length + ' of ' + S().players.length +
      (gear ? ' · ' + gear + ' can catch' : '');
  }

  /* --------------------------------------------------------------- batting */

  /* Today's order. Once set for a game it is frozen — at-bats accumulate as you
     play, so re-sorting live would reshuffle the order mid-inning. */
  function order() {
    var byId = {};
    S().players.forEach(function (p) { byId[p.id] = p; });
    var slots = (S().battingSlots || {})[gameId];
    var present = presentIds();
    if (slots && Object.keys(slots).length) {
      var arr = Object.keys(slots)
        .filter(function (id) { return byId[id] && attOf(id) === 'present'; })
        .sort(function (a, b) { return slots[a] - slots[b]; })
        .map(function (id) { return byId[id]; });
      // A kid who showed up after the order was set bats at the back.
      present.forEach(function (id) {
        if (!(id in slots)) arr.push(byId[id]);
      });
      return arr;
    }
    return E.battingOrderByNeed(S().players, present, store.battingStats(gameId));
  }

  /* Find the batter by WHO they are, not by counting to a position. The order
     closes up when a kid leaves, so a stored position silently starts pointing
     at a different child — skipping whoever was actually due. */
  function batIndex(order) {
    if (!order || !order.length) return 0;
    if (S().battingGameId !== gameId) return 0;
    var id = S().battingNextId;
    if (id) {
      for (var i = 0; i < order.length; i++) {
        if (order[i].id === id) return i;
      }
      // Not found: the kid who was up is the one who left. Whoever followed
      // them has moved into that slot, so the stored position is now correct.
    }
    var idx = S().battingNext || 0;
    return idx >= order.length ? 0 : idx;
  }

  function renderBat() {
    var o = order();
    if (!o.length) {
      $('#abSlot').textContent = '';
      $('#abName').textContent = 'Nobody checked in';
      $('#abDeck').textContent = ''; $('#abHole').textContent = '';
      return;
    }
    var i = batIndex(o);
    // Don't let the card invite a tap that would hijack the live game's batter.
    var mine = S().battingGameId === gameId;
    var locked = !mine && !store.canMoveBatting(gameId);
    $('#abGo').disabled = $('#abSkip').disabled = locked;
    if (locked) {
      $('#abSlot').textContent = 'Another game is in progress — batting locked here';
    } else {
      $('#abSlot').textContent = 'Batter ' + (i + 1) + ' of ' + o.length + ' · At bat';
    }
    $('#abName').textContent = o[i].name;
    $('#abDeck').textContent = o[(i + 1) % o.length].name;
    $('#abHole').textContent = o[(i + 2) % o.length].name;
  }

  $('#abGo').onclick = function () {
    var o = order();
    if (!o.length) return;
    var i = batIndex(o);
    // If nobody set the order, freeze it on the first tap — keeping whoever is
    // up right now. An unfrozen order drifts apart between phones.
    if (!Object.keys((S().battingSlots || {})[gameId] || {}).length) {
      store.setBattingSlots(gameId, o.map(function (p) { return p.id; }), i);
    }
    var n = (i + 1) % o.length;
    store.advanceBatter(gameId, o[i].id, o[n].id, n);
  };

  /* Same movement through the order, no at-bat recorded. */
  $('#abSkip').onclick = function () {
    var o = order();
    if (!o.length) return;
    var i = batIndex(o);
    if (!Object.keys((S().battingSlots || {})[gameId] || {}).length) {
      store.setBattingSlots(gameId, o.map(function (p) { return p.id; }), i);
    }
    var n = (i + 1) % o.length;
    store.skipBatter(gameId, o[n].id, n);
  };

  /* Has today's order actually moved yet? Before the first batter there is
     nothing to hold on to, and starting at the top is exactly what lets a kid
     who arrived late and is owed the most lead off. */
  function battingUnderway() {
    var pa = (S().plateAppearances || {})[gameId] || {};
    for (var k in pa) { if (pa[k] > 0) return true; }
    return S().battingGameId === gameId && (S().battingNext || 0) > 0;
  }

  /* Re-sorting rebuilds the ORDER, never the pointer. The kid in the box stays
     in the box — on all three phones, since setBattingSlots pushes the pointer
     into batting_state. Same rule as auto-fill: rebuild forward, leave what
     already happened alone, and say so. */
  $('#setOrder').onclick = function () {
    if (!gameId) return;
    var cur = order();
    var upId = cur.length ? cur[batIndex(cur)].id : null;
    var o = E.battingOrderByNeed(S().players, presentIds(), store.battingStats(gameId));
    var ids = o.map(function (p) { return p.id; });
    // Take who is up from order()+batIndex, not raw state: those already
    // resolve the "the kid who was up is the one who left" case, and they
    // return only present kids — the same set the sort works on.
    var at = battingUnderway() ? ids.indexOf(upId) : -1;
    store.setBattingSlots(gameId, ids, at < 0 ? 0 : at);
    renderAll();
    if (at > -1) {
      $('#orderMeta').textContent = 'Re-sorted — ' + nameOf(upId) + ' still up';
    }
  };

  function renderOrderBox() {
    var slots = (S().battingSlots || {})[gameId];
    var box = $('#orderList');
    box.innerHTML = '';
    var set = slots && Object.keys(slots).length;
    $('#setOrder').textContent = set ? 'Re-sort order' : 'Set batting order';
    // With no completed games nobody is owed anything, so every kid ties and
    // the sort lands in the same place every time. Say so, rather than letting
    // it look like the button did nothing.
    var st = store.battingStats(gameId), history = false;
    Object.keys(st).forEach(function (k) { if (st[k].games) history = true; });
    $('#orderMeta').textContent = set
      ? 'Set — re-sort any time'
      : 'Not set — locks on the first batter';
    $('#orderWhy').textContent = history
      ? 'Sorted by who is owed at-bats. Re-sort to rebuild it from the latest totals.'
      : 'No completed games yet, so everyone is even and this order is as fair as any. ' +
        'Re-sorting will give the same list until a game has innings marked played.';
    var o = order();
    o.forEach(function (p, i) {
      var r = el('div', 'row');
      r.appendChild(el('span', 'slot', String(i + 1)));
      r.appendChild(el('span', 'nm', p.name));
      box.appendChild(r);
    });
    if (!o.length) box.appendChild(el('div', 'empty', 'Nobody checked in yet.'));
  }

  /* ---------------------------------------------------------------- field */

  function renderField() {
    var L = lineupFor(inning), f = $('#fieldList'), filled = 0;
    f.innerHTML = '';
    positions().forEach(function (pos) {
      var id = L[pos];
      if (id && attOf(id) !== 'present') id = null;
      var r = el('div', 'row' + (id ? '' : ' hole'));
      r.appendChild(el('span', 'chip ' + chipClass(pos), pos));
      if (id) {
        filled++;
        r.appendChild(el('span', 'nm', nameOf(id)));
        var key = gameId + ':' + inning + ':' + id;
        var t = el('button', 'tell', '✓');
        t.setAttribute('aria-pressed', !!told[key]);
        t.title = 'Told them';
        t.onclick = function () {
          told[key] ? delete told[key] : (told[key] = 1);
          try { localStorage.setItem('ft.told', JSON.stringify(told)); } catch (e) {}
          renderField();
        };
        r.appendChild(t);
        var s = el('button', 'sit', 'Out');
        s.onclick = function () { store.setAttendance(gameId, id, 'out'); };
        r.appendChild(s);
      } else {
        var b = el('button', 'holebtn', 'Open — tap to fill');
        b.onclick = function () { fillHole(pos); };
        r.appendChild(b);
      }
      f.appendChild(r);
    });
    $('#fieldCount').textContent = filled + ' on the field';

    var on = {};
    positions().forEach(function (p) { if (L[p]) on[L[p]] = 1; });
    var bl = $('#benchList');
    bl.innerHTML = '';
    var bench = S().players.filter(function (p) { return !on[p.id]; });
    bench.forEach(function (p) {
      var st = attOf(p.id);
      var r = el('div', 'row' + (st !== 'present' ? ' sat' : ''));
      r.appendChild(el('span', 'chip bn', st === 'present' ? '—' : st.toUpperCase()));
      r.appendChild(el('span', 'nm', p.name));
      var s = el('button', 'sit' + (st !== 'present' ? ' in' : ''),
        st !== 'present' ? 'Back in' : 'Out');
      s.onclick = function () {
        store.setAttendance(gameId, p.id, st !== 'present' ? 'present' : 'out');
      };
      r.appendChild(s);
      bl.appendChild(r);
    });
    $('#benchCount').textContent =
      bench.filter(function (p) { return attOf(p.id) === 'present'; }).length + ' sitting';
  }

  var told = {};
  try { told = JSON.parse(localStorage.getItem('ft.told') || '{}'); } catch (e) {}

  function availableFor(inn, pos) {
    var L = lineupFor(inn), used = {};
    positions().forEach(function (p) { if (L[p]) used[L[p]] = 1; });
    return S().players.filter(function (p) {
      if (used[p.id] || attOf(p.id) !== 'present') return false;
      if (pos === 'C' && !p.canCatch) return false;
      return true;
    }).map(function (p) { return p.id; });
  }

  function fillHole(pos) {
    openSheet('Who plays ' + pos + '?', availableFor(inning, pos), function (id) {
      store.setAssignment(gameId, inning, pos, id);
    }, pos === 'C' ? 'only kids with gear' : null);
  }

  function renderInnTabs() {
    var w = $('#innTabs');
    w.innerHTML = '';
    var g = game(), played = (g && g.inningsPlayed) || 0, top = maxInnings();
    for (var i = 1; i <= top; i++) {
      (function (i) {
        var b = el('button', i > Math.max(played, EXPECTED_INNINGS) ? 'ghost' : '',
                   'Inn ' + i);
        b.setAttribute('aria-pressed', i === inning);
        // renderGameBtn too: this partial render never touched the Inning
        // played button, so a stale "tap again" outlived the tab switch.
        b.onclick = function () {
          inning = i; renderGameBtn(); renderField(); renderInnTabs();
        };
        w.appendChild(b);
      }(i));
    }
  }

  /* The clock is the thing that decides how many innings you get, so starting it
     is a deliberate tap at first pitch rather than something derived from the
     scheduled time — games never start when the schedule says they do. */
  $('#startGame').onclick = function () {
    var g = game();
    if (!g) return;
    if (g.status === 'live') {
      store.patchGame(gameId, {
        local: { status: 'final' }, remote: { status: 'final' }
      });
    } else {
      var t = new Date().toISOString();
      store.patchGame(gameId, {
        local: { status: 'live', clockStartedAt: t },
        remote: { status: 'live', clock_started_at: t }
      });
    }
    renderAll();
  };

  function renderGameBtn() {
    var g = game();
    var b = $('#startGame');
    if (!g) return;
    // Derive the label from state on every render, rather than writing it once
    // in the handler and suppressing later updates — that is how a stale
    // "tap again" survived a context switch and described the wrong inning.
    var d = $('#inningDone');
    d.textContent = doneLabel();
    d.className = 'btn' + (armedFor === armKey() ? ' primary' : '');
    b.textContent = g.status === 'live' ? 'End game'
                  : g.status === 'final' ? 'Game over' : 'Start game';
    b.className = 'btn' + (g.status === 'scheduled' ? ' primary' : '');
    b.disabled = g.status === 'final';
  }

  /* Marking an inning played writes it into the season ledger permanently. If
     spots are open — which is what a kid leaving mid-inning leaves behind — it
     records a short inning and nothing says so. Make it a deliberate second tap. */
  /* The arm belongs to ONE inning of ONE game, not to the app. A bare boolean
     stayed armed across a game switch or an inning-tab tap, so the next tap
     marked the WRONG inning played with no confirmation — and nothing in the
     app can un-mark one. Keying it to game+inning invalidates it automatically,
     so no future context switch has to remember to clear it. */
  var armedFor = null, armTimer = null;
  function armKey() { return gameId + ':' + inning; }
  function inningPlayed(i) {
    return !!((S().actuals || {})[gameId] || {})[i];
  }

  /* Naming the inning on the button is the point: marking one played is
     irreversible, so the coach should be able to read what is about to happen
     rather than trust that the selection is where they left it. */
  function doneLabel() {
    if (inningPlayed(inning)) return 'Inning ' + inning + ' recorded';
    var open = openSpots();
    if (armedFor === armKey()) {
      return open
        ? 'Inning ' + inning + ' · ' + open + ' open — tap again'
        : 'Mark inning ' + inning + ' played — tap again';
    }
    return open
      ? 'Inning ' + inning + ' played (' + open + ' open)'
      : 'Inning ' + inning + ' played';
  }

  function openSpots() {
    var L = lineupFor(inning), open = 0;
    positions().forEach(function (pos) {
      var id = L[pos];
      if (!id || attOf(id) !== 'present') open++;
    });
    return open;
  }

  $('#inningDone').onclick = function () {
    var g = game();
    if (!g) return;
    if (inningPlayed(inning)) return;        // already recorded; nothing to add

    // EVERY mark takes two taps now, not just the short ones. Marking played
    // advances the selected inning, so the button immediately re-aims at the
    // next one — a double tap used to record two innings, irreversibly.
    if (armedFor !== armKey()) {
      armedFor = armKey();
      renderGameBtn();
      clearTimeout(armTimer);
      armTimer = setTimeout(function () { armedFor = null; renderGameBtn(); }, 6000);
      return;
    }
    armedFor = null;
    clearTimeout(armTimer);
    store.markInningPlayed(gameId, inning);
    var n = Math.max(g.inningsPlayed || 0, inning);
    store.patchGame(gameId, {
      local: { inningsPlayed: n }, remote: { innings_played: n }
    });
    if (inning < maxInnings()) inning++;
    renderAll();
  };

  /* -------------------------------------------------------------- catcher */

  function setCatcher(v) {
    var g = game();
    if (!g) return;
    // Vacate BEFORE the flag flips, while C is still a real row. If the phone
    // dies between the two writes this leaves "cleared but still on" — an open
    // C the coach can see and refill. The other order leaves the ghost.
    if (!v) store.clearCatcher(gameId);
    store.patchGame(gameId, { local: { hasCatcher: v }, remote: { has_catcher: v } });
    renderAll();
  }
  $('#cYes').onclick = function () { setCatcher(true); };
  $('#cNo').onclick = function () { setCatcher(false); };

  function renderCatcher() {
    var g = game(), v = !!(g && g.hasCatcher);
    $('#cYes').setAttribute('aria-pressed', v);
    $('#cNo').setAttribute('aria-pressed', !v);
    var anyGear = S().players.some(function (p) { return p.canCatch; });
    $('#cHint').textContent = v
      ? (anyGear
        ? '11 in the field, 4 on the bench each inning.'
        : 'Catcher is on but nobody is flagged as able to catch, so that spot will stay open. Tap the C next to a name on the Roll tab.')
      : (anyGear
        ? '10 in the field, 5 on the bench. With all 15 here that is one infield, one outfield and one bench inning each.'
        : 'Nobody is flagged as a catcher yet, so the plan plays 10. Tap the C next to a name on the Roll tab to change that.');
  }

  /* ----------------------------------------------------------------- plan */

  function renderPlan() {
    var t = $('#planTable');
    t.innerHTML = '';
    var top = maxInnings();
    var th = el('thead'), hr = el('tr'), i;
    hr.appendChild(el('th', null, ''));
    for (i = 1; i <= top; i++) {
      hr.appendChild(el('th', i > EXPECTED_INNINGS ? 'dim' : '', 'Inn ' + i));
    }
    th.appendChild(hr);
    t.appendChild(th);

    var tb = el('tbody');
    positions().forEach(function (pos) {
      var tr = el('tr'), thc = el('th');
      thc.appendChild(el('span', 'chip ' + chipClass(pos), pos));
      tr.appendChild(thc);
      for (var i = 1; i <= top; i++) {
        (function (i) {
          var td = el('td', i > EXPECTED_INNINGS ? 'dim' : '');
          var id = lineupFor(i)[pos];
          if (id && attOf(id) !== 'present') id = null;
          var c = el('button', 'cell' + (id ? '' : ' empty'), id ? nameOf(id) : '— open —');
          c.onclick = function () {
            openSheet('Inning ' + i + ' · ' + pos, availableFor(i, pos), function (x) {
              store.setAssignment(gameId, i, pos, x);
            }, pos === 'C' ? 'only kids with gear' : null);
          };
          td.appendChild(c);
          tr.appendChild(td);
        }(i));
      }
      tb.appendChild(tr);
    });
    t.appendChild(tb);

    var w = [];
    S().players.forEach(function (p) {
      var seen = {}, i;
      for (i = 1; i <= top; i++) {
        positions().forEach(function (pos) {
          if (lineupFor(i)[pos] === p.id) seen[pos] = (seen[pos] || 0) + 1;
        });
      }
      Object.keys(seen).forEach(function (pos) {
        if (seen[pos] > 1) w.push(p.name + ' plays ' + pos + ' twice');
      });
    });
    $('#planWarn').innerHTML = w.length
      ? '<b>Check:</b> ' + w.join(' · ')
      : '<b>Looks clean.</b> Nobody doubles a position, nobody sits back-to-back.';
  }

  /* Innings already played are history. Planning from inning 1 rewrote them,
     which retroactively changed the season ledger for innings the kids had
     actually finished. Only ever plan forward from the next unplayed inning. */
  function firstUnplayedInning() {
    var g = game();
    return ((g && g.inningsPlayed) || 0) + 1;
  }

  $('#autoFill').onclick = function () {
    if (!gameId) return;
    var g = game();
    var from = firstUnplayedInning();
    var count = Math.max(1, maxInnings() - from + 1);
    var plan = E.planGame({
      players: S().players,
      present: presentIds(),
      innings: count,
      hasCatcher: !!(g && g.hasCatcher),
      ledger: store.ledger()
    });
    store.applyPlan(gameId, plan, from);
    renderAll();
    // renderAll rewrites the warning box, so say this after it.
    var notes = plan.warnings.slice();
    if (from > 1) {
      notes.unshift('Planned innings ' + from + ' onward — innings 1–' +
        (from - 1) + ' were already played and were left alone.');
    }
    if (notes.length) {
      $('#planWarn').innerHTML = '<b>Note:</b> ' + notes.join(' · ');
    }
  };

  $('#clearPlan').onclick = function () {
    if (!gameId) return;
    store.batch(function () {
      for (var i = firstUnplayedInning(); i <= maxInnings(); i++) {
        positions().forEach(function (pos) {
          store.setAssignment(gameId, i, pos, null);
        });
      }
    });
    renderAll();
  };

  /* --------------------------------------------------------------- ledger */

  function renderLedger() {
    var led = store.ledger(), pa = {}, L = $('#ledList');
    Object.keys(S().plateAppearances).forEach(function (gid) {
      var m = S().plateAppearances[gid];
      Object.keys(m).forEach(function (pid) { pa[pid] = (pa[pid] || 0) + m[pid]; });
    });

    var rows = S().players.slice().sort(function (a, b) {
      var A = led[a.id] || {}, B = led[b.id] || {};
      return (B.bench || 0) - (A.bench || 0) ||
             (A.infield || 0) - (B.infield || 0) ||
             ((pa[a.id] || 0) - (pa[b.id] || 0));
    });

    L.innerHTML = '';
    var anyPlayed = rows.some(function (p) {
      var s = led[p.id] || {};
      return (s.infield || 0) + (s.outfield || 0) + (s.bench || 0) > 0;
    });
    if (!anyPlayed) {
      L.appendChild(el('div', 'empty',
        'Nothing played yet. Mark an inning played on the Dugout tab and the season ledger starts here.'));
      $('#ledMeta').textContent = '';
      return;
    }

    rows.forEach(function (p) {
      var s = led[p.id] || { infield: 0, outfield: 0, bench: 0 };
      var tot = Math.max(s.infield + s.outfield + s.bench, 1);
      var r = el('div', 'ledrow');
      r.appendChild(el('span', 'nm', p.name));
      var bars = el('div', 'bars');
      [['b-if', s.infield], ['b-of', s.outfield], ['b-bn', s.bench]].forEach(function (x) {
        var b = el('i', x[0]);
        b.style.width = (x[1] / tot * 100) + '%';
        bars.appendChild(b);
      });
      r.appendChild(bars);
      var n = pa[p.id] || 0;
      r.appendChild(el('span', 'ab' + (n < 2 ? ' low' : ''), String(n)));
      L.appendChild(r);
    });
    var games = Object.keys(S().actuals).length;
    $('#ledMeta').textContent = 'After ' + games + ' game' + (games === 1 ? '' : 's');
  }

  /* ---------------------------------------------------------------- sheet */

  function openSheet(title, ids, pick, hint) {
    $('#sheetH').textContent = title + (hint ? ' · ' + hint : '');
    var b = $('#sheetBody');
    b.innerHTML = '';
    if (!ids.length) b.appendChild(el('p', 'opt', 'Nobody available.'));
    ids.forEach(function (id) {
      var p = S().players.filter(function (x) { return x.id === id; })[0];
      var o = el('button', 'opt', p.name);
      if (p.canCatch) o.appendChild(el('small', null, 'has gear'));
      o.onclick = function () { pick(id); closeSheet(); };
      b.appendChild(o);
    });
    $('#sheet').setAttribute('data-open', '');
  }
  function closeSheet() { $('#sheet').removeAttribute('data-open'); }
  $('#sheet').onclick = function (e) { if (e.target === $('#sheet')) closeSheet(); };

  /* ----------------------------------------------------------------- tabs */

  var tabs = document.querySelectorAll('.tabs button');
  Array.prototype.forEach.call(tabs, function (b) {
    b.onclick = function () {
      view = b.dataset.view;
      Array.prototype.forEach.call(tabs, function (x) {
        x.setAttribute('aria-selected', x === b);
      });
      ['roll', 'dugout', 'plan', 'ledger'].forEach(function (v) {
        $('#v-' + v).hidden = (v !== view);
      });
      renderAll();
    };
  });

  /* ----------------------------------------------------------------- boot */

  function renderAll() {
    if (!S().games.length) return;
    if (!gameId) gameId = pickDefaultGame();
    renderBar(); renderGamePick(); renderRoll(); renderBat(); renderGameBtn();
    renderOrderBox();
    renderInnTabs(); renderCatcher(); renderField(); renderPlan(); renderLedger();
    if (typeof banner === 'function') banner();
  }

  function pickDefaultGame() {
    var live = S().games.filter(function (g) { return g.status === 'live'; })[0];
    if (live) return live.id;
    var now = Date.now();
    var next = S().games.filter(function (g) {
      return new Date(g.startsAt).getTime() > now - 6 * 3600e3;
    })[0];
    return (next || S().games[S().games.length - 1] || {}).id || null;
  }

  store.subscribe(function () { renderAll(); });

  function showApp(member) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#whoami').innerHTML = '';
    $('#whoami').appendChild(document.createTextNode(
      ((member && member.display_name) || 'Signed in') + ' · '));
    var out = el('button', null, 'Sign out');
    out.onclick = function () { store.signOut().then(function () { location.reload(); }); };
    $('#whoami').appendChild(out);
  }

  function banner() {
    var b = $('#banner');
    if (!b) return;
    var msg = '';
    if (store.libMissing) {
      msg = 'Could not load the sync library. Working on this phone only — ' +
            'changes are saved here and will sync next time it loads with signal.';
    } else if (store.netDown || !store.online) {
      msg = 'No connection. Working from this phone — changes are saved and ' +
            'will sync when signal returns.';
    } else if (store.stale) {
      msg = 'Could not refresh from the server; showing the last lineup this ' +
            'phone received.';
    }
    if (store.queueOverflowed) {
      msg += (msg ? ' ' : '') + 'Too many unsent changes queued — the oldest were dropped.';
    }
    b.textContent = msg;
    b.hidden = !msg;
  }

  /* Boot from whatever this phone already has. The previous order waited on a
     network round trip before deciding whether to render at all, so at a field
     with no signal the app showed a sign-in screen — the one situation the
     whole local-first design exists for. Auth and sync are an upgrade now,
     not a gate. */
  store.load().then(function () {
    if (S().member && S().players.length) {
      showApp(S().member);
      renderAll();
      banner();
    }
    return store.init();
  }).then(function () {
    return store.start();
  }).then(function () {
    banner();
    if (store.member) { showApp(store.member); renderAll(); return; }

    if (store.libMissing || store.netDown) {
      showGate('No connection, and this phone has not been signed in before. ' +
        'Get on wifi or data and reload.', true);
      return;
    }
    if (!store.session) { showGate(); return; }
    var email = store.session.user.email;
    showGate(store.memberError
      ? 'Signed in as ' + email + ', but the roster check failed: ' + store.memberError
      : 'Signed in as ' + email + ', but you are not on the Fire Tigers roster ' +
        'yet. Ty needs to add you — send him that email address.', true);
    var again = el('button', null, 'Try again');
    again.style.marginTop = '12px';
    again.onclick = function () { location.reload(); };
    $('#gateMsg').appendChild(document.createElement('br'));
    $('#gateMsg').appendChild(again);
  }).catch(function (e) {
    // Never let a startup failure hide an app we can already render from cache.
    if (store.member || (S().member && S().players.length)) {
      showApp(store.member || S().member);
      renderAll();
      store.stale = true;
      banner();
      return;
    }
    showGate('Could not start: ' + (e && e.message), true);
  });

  setInterval(renderBar, 30000);
}());
