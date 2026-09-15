/* Fire Tigers — Supabase adapter.
 *
 * Extends LocalStore rather than replacing it. The UI always reads local state,
 * so a dead signal at the field changes nothing about how the app behaves: you
 * keep tapping, the screen keeps responding, and the queue drains when bars
 * come back. The server is a sync target, never a dependency of the render.
 */
(function (root) {
  'use strict';
  var Base = root.Store.LocalStore;

  // Postgres errors that will never succeed on retry: unique violation,
  // foreign key, check constraint, RLS denial, bad input syntax. Anything
  // else (timeouts, 5xx, offline) is worth retrying.
  var PERMANENT = {
    '23505': 1, '23503': 1, '23514': 1, '23502': 1, '42501': 1, '22P02': 1
  };

  function firstError(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].error) return list[i].error;
    }
    return null;
  }

  function SB(cfg) {
    Base.call(this);
    this.cfg = cfg;
    this.mode = 'supabase';
    this.session = null;
    this.member = null;
    this.online = navigator.onLine;
    var self = this;
    window.addEventListener('online', function () {
      self.online = true;
      self.netDown = false;
      // Draining alone only pushes THIS phone's work up. Everything the other
      // two coaches changed during the outage arrived on a realtime socket that
      // was not connected, so it has to be re-fetched or it is lost here.
      if (self.member && self.sb) {
        self.pull()
          .then(function () { self.stale = false; self.emit(); })
          .catch(function () { self.stale = true; self.emit(); });
      }
      self.drain();
    });
    window.addEventListener('offline', function () { self.online = false; self.emit(); });
  }
  SB.prototype = Object.create(Base.prototype);
  SB.prototype.constructor = SB;

  /* ------------------------------------------------------------------ auth */

  SB.prototype.init = function () {
    var self = this;
    // The library comes from a CDN. If it did not load, this is still a working
    // offline app backed by localStorage — do not take the whole thing down.
    if (!window.supabase || !window.supabase.createClient) {
      this.libMissing = true;
      this.netDown = true;
      this.member = this.state.member || null;
      return Promise.resolve(null);
    }
    this.sb = window.supabase.createClient(this.cfg.supabaseUrl, this.cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return this.sb.auth.getSession().then(function (r) {
      // "No session" and "could not reach the auth server to refresh one" look
      // identical here. Treating the second as signed-out locked coaches out at
      // the field, which is exactly where it matters.
      if (r.error) {
        self.netDown = true;
        self.lastError = r.error.message;
      }
      self.session = r.data && r.data.session;
      self.sb.auth.onAuthStateChange(function (_evt, s) {
        var had = !!self.session;
        self.session = s;
        if (!had && s) self.start();
        if (!s) { self.member = null; self.emit(); }
      });
      return self.session;
    });
  };

  SB.prototype.signIn = function (email) {
    return this.sb.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: location.href.split('#')[0] }
    });
  };

  SB.prototype.signOut = function () {
    var self = this;
    return this.sb.auth.signOut().then(function () {
      try { localStorage.removeItem('firetigers.v1'); } catch (e) {}
      self.state = root.Store.emptyState();
      self.emit();
    });
  };

  /* Signed in but not on the roster is a real state, not an error: RLS
     correctly shows nothing until someone adds you to team_members. */
  SB.prototype.start = function () {
    var self = this;
    // Scope to THIS user. Team members can see each other by design, so without
    // the user_id filter this returns every coach on the team and maybeSingle()
    // rejects the lot.
    var uid = this.session && this.session.user && this.session.user.id;
    if (!uid) {
      // No live session. If this phone was signed in before, keep working from
      // cache rather than demanding a sign-in link with no signal to fetch it.
      this.member = this.netDown ? (this.state.member || null) : null;
      this.emit();
      return Promise.resolve(this.member);
    }
    return this.sb.from('team_members')
      .select('role, display_name, team_id, user_id')
      .eq('team_id', this.cfg.teamId)
      .eq('user_id', uid)
      .maybeSingle()
      .then(function (r) {
        if (r.error) {
          // A failed lookup is not evidence that you are off the roster. Fall
          // back to the cached membership and flag the connection instead.
          self.memberError = r.error.message +
            (r.error.code ? ' [' + r.error.code + ']' : '');
          self.netDown = true;
          self.member = self.state.member || null;
          self.emit();
          return self.member;
        }
        self.memberError = null;
        self.member = r.data || null;
        if (!self.member) { self.state.member = null; self.emit(); return null; }
        self.state.member = self.member;
        // pull() gets its OWN catch. Chaining it here funnelled a failed READ
        // into the membership handler, which cleared member — and member is
        // what the whole UI, push() and drain() key off. One bad SELECT meant
        // "you are not a coach", with no UI and no sync, until a good reload.
        self.pull().then(function () {
          self.stale = false;
          self.watch();
          self.drain();
        }).catch(function (e) {
          self.stale = true;
          self.lastError = e && e.message;
          self.emit();
        });
        return self.member;
      })
      .catch(function (e) {
        self.memberError = e.message || String(e);
        self.netDown = true;
        self.member = self.state.member || null;
        self.emit();
        return self.member;
      });
  };

  /* ------------------------------------------------------------------ read */

  SB.prototype.pull = function () {
    var self = this, S = this.state, team = this.cfg.teamId;
    return Promise.all([
      this.sb.from('players').select('*').eq('team_id', team)
        .eq('active', true).order('bats_order'),
      this.sb.from('games').select('*').eq('team_id', team).order('starts_at'),
      this.sb.from('batting_state').select('*').eq('team_id', team).maybeSingle()
    ]).then(function (res) {
      // A failed SELECT and a genuinely empty table are indistinguishable if you
      // only read .data. Writing the empty version over good local state and
      // persisting it destroyed the very cache this app runs on at the field.
      // Build everything into temporaries and only commit once all of it landed.
      var err = firstError(res);
      if (err) { self.netDown = true; throw new Error(err.message); }

      var players = (res[0].data || []).map(function (p) {
        return {
          id: p.id,
          name: p.first_name + ' ' + p.last_initial + '.',
          first: p.first_name, lastInitial: p.last_initial,
          canCatch: p.can_catch, batsOrder: p.bats_order, jersey: p.jersey
        };
      });
      var games = (res[1].data || []).map(function (g) {
        return {
          id: g.id, startsAt: g.starts_at, opponent: g.opponent,
          homeAway: g.home_away, status: g.status,
          hasCatcher: g.has_catcher, timeLimit: g.time_limit_min,
          maxBatters: g.max_batters_per_half, outs: g.outs_per_half,
          runCap: g.run_cap_per_half, inningsPlayed: g.innings_played,
          clockStartedAt: g.clock_started_at
        };
      });
      var nextIdx = (res[2].data && res[2].data.next_index) || 0;
      var nextGame = (res[2].data && res[2].data.game_id) || null;

      var ids = games.map(function (g) { return g.id; });
      if (!ids.length) {
        S.players = players; S.games = games;
        S.battingNext = nextIdx; S.battingGameId = nextGame;
        self.persist();
        return;
      }
      return Promise.all([
        self.sb.from('assignments').select('*').in('game_id', ids),
        self.sb.from('game_players').select('*').in('game_id', ids)
      ]).then(function (r2) {
        var err2 = firstError(r2);
        if (err2) { self.netDown = true; throw new Error(err2.message); }

        var assignments = {}, actuals = {}, attendance = {};
        var plateAppearances = {}, battingSlots = {};
        (r2[0].data || []).forEach(function (a) {
          assignments[a.game_id] = assignments[a.game_id] || {};
          assignments[a.game_id][a.inning] = assignments[a.game_id][a.inning] || {};
          assignments[a.game_id][a.inning][a.position] = a.player_id;
          if (a.actual) {
            actuals[a.game_id] = actuals[a.game_id] || {};
            actuals[a.game_id][a.inning] = true;
          }
        });
        (r2[1].data || []).forEach(function (gp) {
          attendance[gp.game_id] = attendance[gp.game_id] || {};
          attendance[gp.game_id][gp.player_id] = gp.status;
          plateAppearances[gp.game_id] = plateAppearances[gp.game_id] || {};
          plateAppearances[gp.game_id][gp.player_id] = gp.plate_appearances;
          if (gp.batting_slot != null) {
            battingSlots[gp.game_id] = battingSlots[gp.game_id] || {};
            battingSlots[gp.game_id][gp.player_id] = gp.batting_slot;
          }
        });

        S.players = players; S.games = games;
        S.battingNext = nextIdx; S.battingGameId = nextGame;
        S.assignments = assignments; S.actuals = actuals;
        S.attendance = attendance; S.plateAppearances = plateAppearances;
        S.battingSlots = battingSlots;
        self.persist();
      });
    });
  };

  /* --------------------------------------------------------------- realtime */

  SB.prototype.watch = function () {
    var self = this, S = this.state;
    if (this.channel) return;
    this.channel = this.sb.channel('firetigers')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' },
        function (p) {
          var r = p.new || p.old; if (!r) return;
          S.assignments[r.game_id] = S.assignments[r.game_id] || {};
          S.assignments[r.game_id][r.inning] = S.assignments[r.game_id][r.inning] || {};
          S.assignments[r.game_id][r.inning][r.position] =
            p.eventType === 'DELETE' ? null : r.player_id;
          if (p.new && p.new.actual) {
            S.actuals[r.game_id] = S.actuals[r.game_id] || {};
            S.actuals[r.game_id][r.inning] = true;
          }
          self.persist();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players' },
        function (p) {
          var r = p.new; if (!r) return;
          S.attendance[r.game_id] = S.attendance[r.game_id] || {};
          S.attendance[r.game_id][r.player_id] = r.status;
          S.plateAppearances[r.game_id] = S.plateAppearances[r.game_id] || {};
          S.plateAppearances[r.game_id][r.player_id] = r.plate_appearances;
          // The batting order arrives here too, one row per player.
          S.battingSlots[r.game_id] = S.battingSlots[r.game_id] || {};
          if (r.batting_slot == null) delete S.battingSlots[r.game_id][r.player_id];
          else S.battingSlots[r.game_id][r.player_id] = r.batting_slot;
          self.persist();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' },
        function (p) {
          var r = p.new; if (!r) return;
          S.players.forEach(function (pl) {
            if (pl.id !== r.id) return;
            pl.canCatch = r.can_catch;
            pl.name = r.first_name + ' ' + r.last_initial + '.';
            pl.jersey = r.jersey;
          });
          self.persist();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'batting_state' },
        function (p) {
          var r = p.new; if (!r) return;
          S.battingNext = r.next_index || 0;
          S.battingGameId = r.game_id || null;
          self.persist();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' },
        function (p) {
          var r = p.new; if (!r) return;
          S.games.forEach(function (g) {
            if (g.id !== r.id) return;
            g.status = r.status; g.hasCatcher = r.has_catcher;
            g.inningsPlayed = r.innings_played; g.clockStartedAt = r.clock_started_at;
          });
          self.persist();
        })
      // Without a status callback a dropped socket is invisible: the phone
      // keeps showing a lineup it is no longer receiving updates for, while the
      // badge still reads "Synced".
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          if (self.stale) {
            self.pull().then(function () { self.stale = false; self.emit(); })
              .catch(function () { self.emit(); });
          }
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ||
            status === 'CLOSED') {
          self.stale = true;
          self.emit();
        }
      });
  };

  /* ----------------------------------------------------------------- write */

  /* Every local write lands immediately, then tries the server. A failure is
     not an error the coach should see — it stays queued and goes out later. */
  SB.prototype.push = function (op) {
    var self = this;
    if (!this.sb || !this.member) return Promise.resolve(false);
    var q;
    if (op.op === 'assign') {
      q = this.sb.from('assignments').upsert({
        game_id: op.gameId, inning: op.inning, position: op.position,
        player_id: op.playerId, updated_at: new Date().toISOString(),
        updated_by: this.session && this.session.user.id
      }, { onConflict: 'game_id,inning,position' });
    } else if (op.op === 'attendance') {
      q = this.sb.from('game_players').upsert({
        game_id: op.gameId, player_id: op.playerId, status: op.status
      }, { onConflict: 'game_id,player_id' });
    } else if (op.op === 'actual') {
      q = this.sb.from('assignments').update({ actual: true })
            .eq('game_id', op.gameId).eq('inning', op.inning);
    } else if (op.op === 'bat') {
      q = Promise.all([
        this.sb.from('game_players').upsert({
          game_id: op.gameId, player_id: op.playerId,
          plate_appearances: op.pa
        }, { onConflict: 'game_id,player_id' }),
        this.sb.from('batting_state').upsert({
          team_id: this.cfg.teamId, next_index: op.next, game_id: op.gameId,
          updated_at: new Date().toISOString()
        }, { onConflict: 'team_id' })
      ]);
    } else if (op.op === 'slots') {
      q = Promise.all([
        this.sb.from('game_players').upsert(
          (op.all || op.ids).map(function (id) {
            var i = op.ids.indexOf(id);
            return { game_id: op.gameId, player_id: id,
                     batting_slot: i >= 0 ? i : null };
          }), { onConflict: 'game_id,player_id' }),
        // Setting the order restarts the rotation — push that to everyone too.
        this.sb.from('batting_state').upsert({
          team_id: this.cfg.teamId, next_index: op.next || 0, game_id: op.gameId,
          updated_at: new Date().toISOString()
        }, { onConflict: 'team_id' })
      ]);
    } else if (op.op === 'cancatch') {
      q = this.sb.from('players').update({ can_catch: op.value }).eq('id', op.playerId);
    } else if (op.op === 'skip') {
      q = this.sb.from('batting_state').upsert({
        team_id: this.cfg.teamId, next_index: op.next, game_id: op.gameId,
        updated_at: new Date().toISOString()
      }, { onConflict: 'team_id' });
    } else if (op.op === 'game') {
      q = this.sb.from('games').update(op.patch).eq('id', op.gameId);
    } else {
      return Promise.resolve(true);
    }
    // Promise.all resolves to an ARRAY of results, so checking r.error on it
    // silently passed failures as successes and dropped them from the queue.
    return Promise.resolve(q).then(function (r) {
      var list = Array.isArray(r) ? r : [r];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].error) {
          self.lastError = list[i].error.message;
          return PERMANENT[list[i].error.code] ? 'permanent' : false;
        }
      }
      return true;
    }).catch(function (e) {
      self.lastError = e && e.message;
      return false;
    });
  };

  SB.prototype.drain = function () {
    if (this.draining || !this.online || !this.member) return;
    var self = this;
    this.draining = true;
    var next = function () {
      var ops = self.state.pendingOps;
      if (!ops.length) { self.draining = false; self.emit(); return; }
      var op = ops[0];
      return self.push(op).then(function (ok) {
        // A write the database will never accept — a constraint violation, a
        // permission denial — used to sit at the head of the queue and be
        // retried forever, so every change made after it never left the phone.
        // Drop it, count it, and keep the rest moving.
        if (ok === 'permanent') {
          self.deadLettered = (self.deadLettered || 0) + 1;
          ops.shift();
          self.persist();
          return next();
        }
        if (!ok) { self.draining = false; return; }   // retry on the next trigger
        ops.shift();
        self.persist();
        return next();
      });
    };
    next();
  };

  // Local write first, then flush. Overrides the base queue-only behaviour.
  ['setAssignment', 'setAttendance', 'markInningPlayed', 'advanceBatter',
   'setBattingSlots', 'skipBatter', 'setCanCatch'].forEach(
    function (fn) {
      SB.prototype[fn] = function () {
        Base.prototype[fn].apply(this, arguments);
        this.drain();
      };
    });

  SB.prototype.patchGame = function (gameId, patch) {
    this.state.games.forEach(function (g) {
      if (g.id === gameId) Object.assign(g, patch.local || {});
    });
    this.queue({ op: 'game', gameId: gameId, patch: patch.remote });
    this.persist();
    this.drain();
  };

  root.SupabaseStore = SB;
}(window));
