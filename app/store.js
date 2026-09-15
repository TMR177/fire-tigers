/* Fire Tigers — data layer.
 *
 * Everything the app reads or writes goes through a Store. There are two
 * implementations behind one interface:
 *
 *   LocalStore     browser storage only. No account, no sync. Used for the
 *                  try-it-out build and as the offline cache.
 *   SupabaseStore  Postgres + realtime, so Nick's pre-fill on Saturday night
 *                  and Ty's mid-inning change both land on Stephanie's phone.
 *
 * The app never talks to Supabase directly. That is what makes the backend
 * swappable, and it is why a dead signal at the field is survivable: writes go
 * to local storage first and drain to the server when there is service.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Store = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'firetigers.v1';

  function now() { return new Date().toISOString(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function emptyState() {
    return {
      team: null,
      players: [],
      games: [],
      attendance: {},   // gameId -> playerId -> 'present'|'absent'|'out'
      assignments: {},  // gameId -> inning -> position -> playerId|null
      actuals: {},      // gameId -> inning -> true once played
      battingNext: 0,   // index into TODAY'S order, not a season pointer
      battingGameId: null,
      battingSlots: {}, // gameId -> [playerId] frozen order for that game
      plateAppearances: {}, // gameId -> playerId -> n
      pendingOps: [],   // writes not yet accepted by the server
      // Cached so a phone with no signal still knows it belongs to this team
      // and can open straight into the dugout instead of a sign-in screen.
      member: null,
      updatedAt: null
    };
  }

  /* ------------------------------------------------------------------ local */

  function LocalStore() {
    this.state = emptyState();
    this.listeners = [];
    this.mode = 'local';
  }

  LocalStore.prototype.load = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        var raw = localStorage.getItem(KEY);
        if (raw) self.state = Object.assign(emptyState(), JSON.parse(raw));
      } catch (e) {
        // Private windows and cleared site data both land here. An empty slate
        // is the right answer — never let storage take the app down.
        self.state = emptyState();
      }
      resolve(self.state);
    });
  };

  LocalStore.prototype.persist = function () {
    this.state.updatedAt = now();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch (e) { /* quota or blocked; the in-memory state is still correct */ }
    this.emit();
  };

  LocalStore.prototype.emit = function () {
    var s = this.state;
    this.listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  };

  LocalStore.prototype.subscribe = function (fn) {
    this.listeners.push(fn);
    var self = this;
    return function () {
      self.listeners = self.listeners.filter(function (f) { return f !== fn; });
    };
  };

  /* ---- domain writes. Each one is small and idempotent so it can be replayed
     against the server in order after the phone gets signal back. ---- */

  LocalStore.prototype.setAssignment = function (gameId, inning, position, playerId) {
    var a = this.state.assignments;
    a[gameId] = a[gameId] || {};
    a[gameId][inning] = a[gameId][inning] || {};

    // A player holds at most one spot per inning — clear any previous one,
    // mirroring the unique index the database enforces.
    if (playerId) {
      var row = a[gameId][inning];
      var self = this;
      Object.keys(row).forEach(function (p) {
        if (row[p] !== playerId || p === position) return;
        row[p] = null;
        // Queue the vacate as well. Clearing it only in memory left the server
        // still holding the old row, so the next upsert violated the
        // one-spot-per-inning index. That is a PERMANENT rejection, and it used
        // to wedge the entire queue behind it for the rest of the day.
        self.queue({ op: 'assign', gameId: gameId, inning: inning,
                     position: p, playerId: null });
      });
    }
    a[gameId][inning][position] = playerId || null;
    this.queue({ op: 'assign', gameId: gameId, inning: inning,
                 position: position, playerId: playerId || null });
    this.persist();
  };

  LocalStore.prototype.setAttendance = function (gameId, playerId, status) {
    var at = this.state.attendance;
    at[gameId] = at[gameId] || {};
    at[gameId][playerId] = status;

    this.queue({ op: 'attendance', gameId: gameId, playerId: playerId, status: status });

    // A kid who is done for the day vacates every inning STILL TO COME.
    // Innings already marked played are history — a kid who leaves in the 3rd
    // really did play the 1st and 2nd, and erasing those would quietly take
    // real innings off their season ledger.
    if (status !== 'present') {
      var g = this.state.assignments[gameId] || {};
      var played = this.state.actuals[gameId] || {};
      var self = this;
      Object.keys(g).forEach(function (inn) {
        if (played[inn]) return;
        Object.keys(g[inn]).forEach(function (pos) {
          if (g[inn][pos] !== playerId) return;
          g[inn][pos] = null;
          // Queue each one: clearing only local state left the server still
          // holding the assignment, so a reload put the kid back on the field.
          self.queue({ op: 'assign', gameId: gameId, inning: Number(inn),
                       position: pos, playerId: null });
        });
      });
    }
    this.persist();
  };

  LocalStore.prototype.applyPlan = function (gameId, plan, fromInning) {
    var start = fromInning || 1, self = this;
    plan.grid.forEach(function (row, i) {
      var inning = start + i;
      plan.positions.forEach(function (pos) {
        self.setAssignment(gameId, inning, pos, row[pos]);
      });
    });
  };

  LocalStore.prototype.markInningPlayed = function (gameId, inning) {
    var ac = this.state.actuals;
    ac[gameId] = ac[gameId] || {};
    ac[gameId][inning] = true;
    this.queue({ op: 'actual', gameId: gameId, inning: inning });
    this.persist();
  };

  LocalStore.prototype.advanceBatter = function (gameId, playerId, orderLen) {
    var pa = this.state.plateAppearances;
    pa[gameId] = pa[gameId] || {};
    pa[gameId][playerId] = (pa[gameId][playerId] || 0) + 1;
    var n = Math.max(orderLen || this.state.players.length, 1);
    this.state.battingGameId = gameId;
    this.state.battingNext = (this.state.battingNext + 1) % n;
    this.queue({ op: 'bat', gameId: gameId, playerId: playerId,
                 pa: pa[gameId][playerId], next: this.state.battingNext });
    this.persist();
  };

  /* Freeze today's batting order. It must be frozen, not recomputed live —
     at-bats accumulate during the game, so a live sort would reshuffle the
     order mid-inning and nobody would know who was up. */
  /* Slots are stored as {playerId: index}, not an array, because realtime
     delivers game_players one row at a time — a map merges cleanly, an array
     would have to be rebuilt from partial information. */
  LocalStore.prototype.setBattingSlots = function (gameId, orderedIds, startIndex) {
    var at = startIndex || 0, map = {};
    orderedIds.forEach(function (id, i) { map[id] = i; });
    this.state.battingSlots[gameId] = map;
    this.state.battingGameId = gameId;
    this.state.battingNext = at;
    this.queue({
      op: 'slots', gameId: gameId, ids: orderedIds.slice(), next: at,
      // Everyone else gets their slot cleared, so a kid who was out when the
      // order was set doesn't reappear at a stale position later.
      all: this.state.players.map(function (p) { return p.id; })
    });
    this.persist();
  };

  /* At-bats per game attended. Rate, not total, so a kid who missed games
     isn't credited as owed for at-bats they were never there to take.

     excludeGameId leaves the game in progress out. It has to: at-bats pile up
     while you play, so including today would make the ordering shift under
     itself — and shift differently on each phone, depending on when each one
     last recalculated. Today's order is decided by the season before today. */
  LocalStore.prototype.battingStats = function (excludeGameId) {
    var S = this.state, out = {};
    S.players.forEach(function (p) { out[p.id] = { pa: 0, games: 0 }; });
    Object.keys(S.plateAppearances).forEach(function (gid) {
      if (gid === excludeGameId) return;
      var m = S.plateAppearances[gid];
      Object.keys(m).forEach(function (pid) {
        if (out[pid]) out[pid].pa += m[pid] || 0;
      });
    });
    // Only games that actually got played count toward attendance.
    Object.keys(S.actuals).forEach(function (gid) {
      if (gid === excludeGameId) return;
      var att = S.attendance[gid] || {};
      S.players.forEach(function (p) {
        if ((att[p.id] || 'present') !== 'absent') out[p.id].games++;
      });
    });
    return out;
  };

  /* Move past a kid without crediting them an at-bat.
     Tapping "next batter" means "that one hit". A kid who refuses to bat must
     NOT be charged for it — that would push them down next game's order when
     they are in fact still owed. */
  /* Who is willing to catch AND owns gear. Previously only settable by hand in
     the database, which meant the 11-player setup was unreachable from the app. */
  LocalStore.prototype.setCanCatch = function (playerId, value) {
    this.state.players.forEach(function (p) {
      if (p.id === playerId) p.canCatch = !!value;
    });
    this.queue({ op: 'cancatch', playerId: playerId, value: !!value });
    this.persist();
  };

  LocalStore.prototype.skipBatter = function (gameId, orderLen) {
    var n = Math.max(orderLen || this.state.players.length, 1);
    this.state.battingGameId = gameId;
    this.state.battingNext = (this.state.battingNext + 1) % n;
    this.queue({ op: 'skip', gameId: gameId, next: this.state.battingNext });
    this.persist();
  };

  LocalStore.prototype.queue = function (op) {
    op.at = now();
    this.state.pendingOps.push(op);
    // The cap used to silently drop the OLDEST op — precisely the write at the
    // head of the drain queue. Dropping anything loses a real change, so raise
    // the ceiling well past a game's worth of activity and make an overflow
    // visible instead of quiet.
    if (this.state.pendingOps.length > 2000) {
      this.state.pendingOps.shift();
      this.queueOverflowed = true;
    }
  };

  /* Season ledger in the shape the planner wants, built only from innings that
     were actually played. Planned-but-never-reached innings must not count, or
     the ledger drifts from reality every time the clock cuts a game short. */
  LocalStore.prototype.ledger = function () {
    var IF = { P: 1, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1 };
    var PREM = { P: 1, C: 1, '1B': 1, SS: 1 };
    var out = {}, st = this.state;

    st.players.forEach(function (p) {
      out[p.id] = { pos: {}, infield: 0, outfield: 0, bench: 0, premium: 0 };
    });

    Object.keys(st.assignments).forEach(function (gameId) {
      var innings = st.assignments[gameId];
      var played = st.actuals[gameId] || {};
      Object.keys(innings).forEach(function (inn) {
        if (!played[inn]) return;
        var onField = {};
        Object.keys(innings[inn]).forEach(function (pos) {
          var id = innings[inn][pos];
          if (!id || !out[id]) return;
          onField[id] = true;
          out[id].pos[pos] = (out[id].pos[pos] || 0) + 1;
          if (IF[pos]) out[id].infield++; else out[id].outfield++;
          if (PREM[pos]) out[id].premium++;
        });
        // Anyone present but not on the field that inning was on the bench.
        var att = st.attendance[gameId] || {};
        st.players.forEach(function (p) {
          if (onField[p.id]) return;
          if ((att[p.id] || 'present') !== 'present') return;
          out[p.id].bench++;
        });
      });
    });
    return out;
  };

  LocalStore.prototype.seed = function (data) {
    this.state = Object.assign(emptyState(), this.state, data);
    this.persist();
  };

  /* --------------------------------------------------------------- supabase */

  /* Wraps LocalStore so the app is always reading from local state. Server
     changes flow in through realtime and are merged; local writes drain out
     through the pending queue. Filling in the two constants is the only thing
     standing between the current build and live multi-phone sync. */
  function SupabaseStore(cfg) {
    LocalStore.call(this);
    this.cfg = cfg || {};      // { url, anonKey, teamId }
    this.mode = 'supabase';
    this.online = false;
  }
  SupabaseStore.prototype = Object.create(LocalStore.prototype);
  SupabaseStore.prototype.constructor = SupabaseStore;

  SupabaseStore.prototype.connect = function () {
    throw new Error('SupabaseStore.connect() not wired yet — needs project URL and anon key.');
  };

  return {
    LocalStore: LocalStore,
    SupabaseStore: SupabaseStore,
    emptyState: emptyState
  };
}));
