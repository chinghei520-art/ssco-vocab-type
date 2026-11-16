/* SSCO FSRS trial scheduler.

   Library: ts-fsrs 6.0.0 (vendored UMD). Model: FSRS-6, the supported
   preset selected explicitly. ts-fsrs 6 defaults to FSRS-7; this trial does
   not follow that default or the wiki's newest write-up. Weights are the
   library preset. desiredRetention 0.90 is the model target, not a promise
   that the learner remembers. Fuzz is off so due times are deterministic.
   Learning steps are the library defaults (1m, 10m), not a 1/3/7 day ladder.

   Old attempt logs are not FSRS evidence. Only review events recorded by
   this module are replayed. Replay ignores a client's claimed grade and
   recomputes it from the observation, in time order.
*/
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SSCOScheduler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LIB = "ts-fsrs@6.0.0";
  const MODEL = "FSRS-6";
  const DESIRED_RETENTION = 0.9;
  const CRITERION = "延遲獨立拼寫率（試行指標）：每張活躍卡計 1 次。分子只計「最近一次獨立首次」答對，而且嗰次香港日遲過學識當日。用過提示、睇過答案、跳過、補救再對，都唔計成功。分母包括未學新卡。逾期唔等於錯，時間過咗唔會改上次結果。呢個數唔係 FSRS 目標記得率，亦唔係預測熟練。";

  function fnvHex(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5 ^ 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + i;
      h2 = Math.imul(h2, 0x01000193);
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }

  function cardId(item) {
    if (!item) return "";
    const answers = Array.isArray(item.answers) ? item.answers.join("\u001f") : "";
    const canon = [item.unit || "", item.zh || "", String(item.blankIndex), answers].join("\u001e");
    return "c_" + fnvHex(canon);
  }

  function hkParts(ts) {
    const date = new Date(ts);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const get = function (type) {
      const found = parts.find(function (p) { return p.type === type; });
      return found ? found.value : "";
    };
    return {
      day: get("year") + "-" + get("month") + "-" + get("day"),
      label: get("year") + "-" + get("month") + "-" + get("day") + " " + get("hour") + ":" + get("minute")
    };
  }

  function hkDay(ts) {
    return hkParts(ts).day;
  }

  function hkLabel(ts) {
    if (ts == null) return "—";
    return hkParts(ts).label;
  }

  let schedulerPromise = null;
  function engine() {
    const lib = typeof globalThis !== "undefined" ? globalThis.FSRS : null;
    if (!lib || typeof lib.DefaultScheduler !== "function") return Promise.resolve(null);
    if (!schedulerPromise) {
      schedulerPromise = Promise.resolve(lib.DefaultScheduler({
        version: MODEL,
        desiredRetention: DESIRED_RETENTION,
        enableFuzz: false
      })).catch(function () {
        schedulerPromise = null;
        return null;
      });
    }
    return schedulerPromise;
  }

  function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object") return null;
    const t = Math.floor(Number(raw.t));
    if (!Number.isFinite(t) || t <= 0) return null;
    if (typeof raw.cardId !== "string" || !/^c_[0-9a-f]{16}$/.test(raw.cardId)) return null;
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(raw.id)) return null;
    const outcomes = { correct: 1, incorrect: 1, skip: 1, expose: 1 };
    const kinds = { new: 1, review: 1, manual: 1, remediation: 1 };
    return {
      id: raw.id,
      cardId: raw.cardId,
      t: t,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId.slice(0, 80) : "",
      kind: kinds[raw.kind] ? raw.kind : "manual",
      outcome: outcomes[raw.outcome] ? raw.outcome : "expose",
      hint: !!raw.hint,
      revealed: !!raw.revealed,
      initial: raw.initial !== false,
      v: 2
    };
  }

  function dedupe(events) {
    const map = new Map();
    (events || []).forEach(function (raw) {
      const event = normalizeEvent(raw);
      if (!event) return;
      if (!map.has(event.id)) map.set(event.id, event);
    });
    return Array.from(map.values()).sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  function roleAt(card, t) {
    if (!card) return "new";
    const due = card.dueAt instanceof Date ? card.dueAt.getTime() : Number(card.dueAt);
    if (Number.isFinite(due) && due <= t) return "review";
    return "manual";
  }

  function gradeFor(event, role) {
    if (!event.initial || event.kind === "remediation") return null;
    const helped = !!(event.hint || event.revealed || event.outcome === "expose");
    const correct = event.outcome === "correct" && !helped;
    if (role === "manual") {
      if (event.outcome === "incorrect" || event.outcome === "skip") return "again";
      return null;
    }
    if (correct) return "good";
    return "again";
  }

  function applyGrade(fsrs, card, cardIdValue, grade, t) {
    const rating = grade === "good" ? fsrsRating(fsrs, "Good") : fsrsRating(fsrs, "Again");
    const now = new Date(t);
    const base = card || fsrs.newCard({ now: now, cardId: cardIdValue });
    return fsrs.review({ card: base, grade: rating, now: now }).card;
  }

  function fsrsRating(fsrs, name) {
    if (fsrs.Rating && fsrs.Rating[name] != null) return fsrs.Rating[name];
    if (typeof globalThis !== "undefined" && globalThis.FSRS && globalThis.FSRS.Rating) {
      return globalThis.FSRS.Rating[name];
    }
    return name === "Good" ? 3 : 1;
  }

  function foldCard(events, fsrs) {
    const list = dedupe(events);
    let card = null;
    let introducedHk = null;
    const sessions = new Set();
    const applied = [];
    list.forEach(function (event) {
      const sessionKey = event.sessionId || event.id;
      const first = !sessions.has(sessionKey);
      if (first) sessions.add(sessionKey);
      const schedulingEvent = first && event.initial && event.kind !== "remediation";
      if (!schedulingEvent) return;
      const role = roleAt(card, event.t);
      const grade = gradeFor(event, role);
      if (!grade) return;
      if (!fsrs) {
        applied.push({ id: event.id, grade: grade, t: event.t, role: role });
        return;
      }
      card = applyGrade(fsrs, card, event.cardId, grade, event.t);
      if (!introducedHk) introducedHk = hkDay(event.t);
      applied.push({ id: event.id, grade: grade, t: event.t, role: role });
    });
    const dueMs = card && card.dueAt ? new Date(card.dueAt).getTime() : null;
    return {
      card: card,
      dueAt: Number.isFinite(dueMs) ? dueMs : null,
      introducedHk: introducedHk,
      scheduled: !!card,
      applied: applied
    };
  }

  function statusOf(summary, now) {
    if (!summary || !summary.scheduled) return "new";
    if (summary.dueAt == null) return "new";
    if (summary.dueAt <= now) return "due";
    return "waiting";
  }

  function lastInitial(events) {
    const list = dedupe(events).filter(function (event) {
      return event.initial && event.kind !== "remediation";
    });
    return list.length ? list[list.length - 1] : null;
  }

  function resultLabel(event) {
    if (!event) return "未有";
    if (event.outcome === "skip") return "跳過";
    if (event.outcome === "incorrect") return "錯";
    if (event.revealed || event.outcome === "expose") return "睇過答案";
    if (event.hint) return "用過提示";
    if (event.outcome === "correct") return "獨立正確";
    return "錯";
  }

  function summarize(items, events, now, fsrs) {
    const byCard = new Map();
    dedupe(events).forEach(function (event) {
      if (!byCard.has(event.cardId)) byCard.set(event.cardId, []);
      byCard.get(event.cardId).push(event);
    });
    const rows = (items || []).map(function (item) {
      const id = cardId(item);
      const mine = byCard.get(id) || [];
      const folded = foldCard(mine, fsrs);
      const latest = lastInitial(mine);
      const delayed = !!(
        latest &&
        latest.outcome === "correct" &&
        !latest.hint &&
        !latest.revealed &&
        folded.introducedHk &&
        hkDay(latest.t) > folded.introducedHk
      );
      return {
        cardId: id,
        zh: item.zh || "",
        answer: (item.answers && item.answers[0]) || "",
        unit: item.unit || "",
        status: statusOf(folded, now),
        dueAt: folded.dueAt,
        dueLabel: folded.dueAt ? hkLabel(folded.dueAt) : "—",
        lastLabel: resultLabel(latest),
        delayed: delayed,
        introducedHk: folded.introducedHk
      };
    });
    const due = rows.filter(function (row) { return row.status === "due"; })
      .sort(function (a, b) { return a.dueAt - b.dueAt || (a.cardId < b.cardId ? -1 : 1); });
    const fresh = rows.filter(function (row) { return row.status === "new"; })
      .sort(function (a, b) { return a.cardId < b.cardId ? -1 : 1; });
    const waiting = rows.filter(function (row) { return row.status === "waiting"; })
      .sort(function (a, b) { return a.dueAt - b.dueAt || (a.cardId < b.cardId ? -1 : 1); });
    const today = hkDay(now);
    const todays = dedupe(events).filter(function (event) {
      return event.initial && event.kind !== "remediation" && hkDay(event.t) === today;
    });
    const todayDenom = todays.filter(function (event) {
      return event.outcome === "correct" || event.outcome === "incorrect" || event.outcome === "skip";
    });
    const todayGood = todayDenom.filter(function (event) {
      return event.outcome === "correct" && !event.hint && !event.revealed;
    });
    const remediation = dedupe(events).filter(function (event) {
      return hkDay(event.t) === today && (event.kind === "remediation" || !event.initial);
    });
    return {
      rows: rows,
      due: due,
      fresh: fresh,
      waiting: waiting,
      order: due.concat(fresh),
      denominator: rows.length,
      delayedCount: rows.filter(function (row) { return row.delayed; }).length,
      todayIndependent: { correct: todayGood.length, total: todayDenom.length },
      remediationCount: remediation.length,
      available: !!fsrs,
      model: MODEL,
      retention: DESIRED_RETENTION,
      criterion: CRITERION
    };
  }

  function effectText(grade, role) {
    if (!grade) {
      return role === "manual"
        ? "額外練習：獨立答對唔會推後到期。"
        : "今次唔會計入排程（補救或同一輪重複）。";
    }
    if (grade === "good") return role === "new" ? "新卡：FSRS Good，開始間隔（模型目標 90%，不是保證）。" : "到期複習：FSRS Good，按模型推下次。";
    if (role === "manual") return "額外練習答錯：FSRS Again，間隔會縮短，歷史保留。";
    return "未能獨立答對：FSRS Again，間隔縮短，歷史保留。";
  }

  function plan(events, observation, fsrs) {
    const event = normalizeEvent(observation);
    if (!event) return null;
    const prior = dedupe(events).filter(function (item) { return item.cardId === event.cardId; });
    const sessionKey = event.sessionId || event.id;
    const seen = prior.some(function (item) {
      return (item.sessionId || item.id) === sessionKey;
    });
    const stored = Object.assign({}, event, {
      initial: seen ? false : event.initial,
      kind: seen ? "remediation" : event.kind
    });
    const before = foldCard(prior, fsrs);
    const after = foldCard(prior.concat([stored]), fsrs);
    const grade = after.applied.length > before.applied.length
      ? after.applied[after.applied.length - 1].grade
      : null;
    const role = roleAt(before.card, event.t);
    return {
      event: stored,
      grade: grade,
      role: stored.kind === "remediation" || !stored.initial ? "remediation" : role,
      effect: effectText(grade, stored.kind === "remediation" || !stored.initial ? "remediation" : role),
      dueAt: after.dueAt
    };
  }

  return {
    LIB: LIB,
    MODEL: MODEL,
    DESIRED_RETENTION: DESIRED_RETENTION,
    CRITERION: CRITERION,
    cardId: cardId,
    hkDay: hkDay,
    hkLabel: hkLabel,
    engine: engine,
    normalizeEvent: normalizeEvent,
    dedupe: dedupe,
    foldCard: foldCard,
    summarize: summarize,
    plan: plan,
    resetEngine: function () { schedulerPromise = null; }
  };
});
