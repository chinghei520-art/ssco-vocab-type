/* Display helpers for the v2.2 progress table.

   Labels and sort order only. This file does not grade reviews or change
   due dates. Status stays 新卡 / 到期 / 未到期. Overdue is still 到期.
   A helped success is not labeled 獨立正確.
*/
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SSCOProgressView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCOPE_NOTE = "排程暫時跟呢部機（雲端複習規則未公布）。";
  const SHOW_UNITS_DEFAULT = false;
  const DEFAULT_SORT = "status";
  const UNIT_PREF_VALUE = "1";

  const STATUS_RANK = { due: 0, new: 1, waiting: 2 };
  const RESULT_RANK = {
    "錯": 0,
    "跳過": 1,
    "睇過答案": 2,
    "用過提示": 3,
    "未有": 4,
    "獨立正確": 5
  };

  function statusLabel(status) {
    if (status === "due") return "到期";
    if (status === "waiting") return "未到期";
    return "新卡";
  }

  function unitsVisible(stored) {
    return stored === UNIT_PREF_VALUE;
  }

  function sortRows(rows, key, direction) {
    const dir = direction === "desc" ? -1 : 1;
    const list = (rows || []).slice();
    list.sort(function (a, b) {
      if (key === "due") {
        const aMissing = a.dueAt == null;
        const bMissing = b.dueAt == null;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
      }
      let cmp = 0;
      if (key === "due") cmp = (a.dueAt || 0) - (b.dueAt || 0);
      else if (key === "status") {
        const ar = STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 9;
        const br = STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 9;
        cmp = ar - br;
      } else if (key === "result") {
        const ar = RESULT_RANK[a.lastLabel] != null ? RESULT_RANK[a.lastLabel] : 9;
        const br = RESULT_RANK[b.lastLabel] != null ? RESULT_RANK[b.lastLabel] : 9;
        cmp = ar - br;
      } else if (key === "unit") {
        cmp = String(a.unit || "").localeCompare(String(b.unit || ""), "zh-Hant");
      } else {
        cmp = String(a.zh || "").localeCompare(String(b.zh || ""), "zh-Hant");
      }
      if (cmp !== 0) return cmp * dir;
      cmp = String(a.zh || "").localeCompare(String(b.zh || ""), "zh-Hant");
      if (cmp !== 0) return cmp;
      if (String(a.cardId || "") < String(b.cardId || "")) return -1;
      if (String(a.cardId || "") > String(b.cardId || "")) return 1;
      return 0;
    });
    return list;
  }

  function trialMetricLines(view) {
    if (!view || !view.todayIndependent) {
      return ["延遲獨立拼寫率 —（排程未載入）"];
    }
    const today = view.todayIndependent;
    return [
      "延遲獨立拼寫率 " + view.delayedCount + "/" + view.denominator + "（含未學）",
      "今日獨立首次 " + today.correct + "/" + today.total,
      "今日補救 " + view.remediationCount + "（唔算獨立）"
    ];
  }

  return {
    SCOPE_NOTE: SCOPE_NOTE,
    SHOW_UNITS_DEFAULT: SHOW_UNITS_DEFAULT,
    DEFAULT_SORT: DEFAULT_SORT,
    UNIT_PREF_VALUE: UNIT_PREF_VALUE,
    statusLabel: statusLabel,
    unitsVisible: unitsVisible,
    sortRows: sortRows,
    trialMetricLines: trialMetricLines
  };
});
