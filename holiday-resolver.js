/**
 * Holiday Resolver Engine
 *
 * Resolves holiday occurrences from RRULE-based schedules, applies observance
 * shifting rules, and evaluates operational / network impacts for a given year.
 *
 * Usage (Node.js):
 *   const { HolidayResolver } = require('./holiday-resolver');
 *   const resolver = new HolidayResolver(config);
 *   const events   = resolver.resolve(2026);
 *
 * Usage (browser): included via <script src="holiday-resolver.js">
 *   window.HolidayResolver / window.RRuleParser are exported automatically.
 */

'use strict';

// ─── Date utilities ──────────────────────────────────────────────────────────

/** WEEKDAY short-code → JS getDay() index (0=Sun) */
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WD_SHORT  = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_FULL   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_FULL = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format a local Date as YYYY-MM-DD (no UTC conversion). */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string to a local Date (midnight). */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isWeekend(date) {
  const wd = date.getDay();
  return wd === 0 || wd === 6;
}

function prevBusinessDay(date) {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

function nextBusinessDay(date) {
  let d = addDays(date, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/**
 * Human-readable date: "Friday, January 1, 2026"
 */
function formatDateLong(dateStr) {
  const d = parseDate(dateStr);
  return `${WD_FULL[d.getDay()]}, ${MONTH_FULL[d.getMonth() + 1]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ─── RRULE parser / expander ─────────────────────────────────────────────────

class RRuleParser {
  /** Parse an RRULE string into a plain key→value object. */
  static parse(rruleStr) {
    const rule = {};
    for (const part of rruleStr.trim().split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return rule;
  }

  /**
   * Expand an RRULE for a specific calendar year and return an array of
   * local Date objects that fall within that year.
   *
   * Supported:  FREQ=YEARLY, BYMONTH, BYMONTHDAY, BYDAY, BYSETPOS
   * Limitation: INTERVAL, COUNT and UNTIL are parsed but only used to gate
   *             whether the year is in range — not for sub-year frequency.
   */
  static expandForYear(rruleStr, year) {
    const rule = this.parse(rruleStr);

    if (rule.FREQ && rule.FREQ !== 'YEARLY') {
      console.warn(`[RRuleParser] FREQ=${rule.FREQ} is not fully supported; treating as YEARLY.`);
    }

    // UNTIL gate
    if (rule.UNTIL) {
      const until = parseDate(rule.UNTIL.replace(/T.*$/, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
      if (until.getFullYear() < year) return [];
    }

    const months = rule.BYMONTH
      ? rule.BYMONTH.split(',').map(Number)
      : Array.from({ length: 12 }, (_, i) => i + 1);

    const results = [];

    for (const month of months) {
      const daysInMonth = new Date(year, month, 0).getDate();

      if (rule.BYMONTHDAY) {
        // Fixed day of month: BYMONTHDAY=1  or  BYMONTHDAY=-1 (last day)
        for (const raw of rule.BYMONTHDAY.split(',').map(Number)) {
          const dayNum = raw > 0 ? raw : daysInMonth + raw + 1;
          if (dayNum >= 1 && dayNum <= daysInMonth) {
            results.push(new Date(year, month - 1, dayNum));
          }
        }

      } else if (rule.BYDAY) {
        // Nth weekday: 1MO, -1TH, 4TH, etc.
        const bydays = rule.BYDAY.split(',');
        const candidates = [];

        for (const byday of bydays) {
          const m = byday.match(/^(-?\d*)([A-Z]{2})$/);
          if (!m) continue;
          const n  = m[1] ? parseInt(m[1], 10) : 0;
          const wd = WD[m[2]];
          if (wd === undefined) continue;

          if (n === 0) {
            // Every occurrence of this weekday in the month
            for (let day = 1; day <= daysInMonth; day++) {
              if (new Date(year, month - 1, day).getDay() === wd) {
                candidates.push(new Date(year, month - 1, day));
              }
            }
          } else if (n > 0) {
            // nth from start
            const first   = new Date(year, month - 1, 1).getDay();
            const dayNum  = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
            if (dayNum <= daysInMonth) {
              candidates.push(new Date(year, month - 1, dayNum));
            }
          } else {
            // nth from end (negative)
            const last   = new Date(year, month, 0);
            const lastWd = last.getDay();
            const dayNum = last.getDate() - ((lastWd - wd + 7) % 7) + (n + 1) * 7;
            if (dayNum >= 1) {
              candidates.push(new Date(year, month - 1, dayNum));
            }
          }
        }

        if (rule.BYSETPOS) {
          candidates.sort((a, b) => a - b);
          for (const raw of rule.BYSETPOS.split(',').map(Number)) {
            const idx = raw > 0 ? raw - 1 : candidates.length + raw;
            if (idx >= 0 && idx < candidates.length) results.push(candidates[idx]);
          }
        } else {
          results.push(...candidates);
        }

      } else {
        // Only BYMONTH specified — default to the 1st of that month
        results.push(new Date(year, month - 1, 1));
      }
    }

    return results;
  }
}

// ─── HolidayResolver ────────────────────────────────────────────────────────

class HolidayResolver {
  /**
   * @param {object} config  Full configuration object (see sample-config.json)
   */
  constructor(config) {
    this.config = config;
    /** @type {Map<string,object>} */
    this.jurisdictions = this._indexById(config.jurisdictions || []);
    /** @type {Map<string,object>} */
    this.events = this._indexById(config.events || []);
    /** @type {Map<string,object>} */
    this.policies = this._indexById(config.policies || []);
    /** @type {object[]} */
    this.impacts = config.impacts || [];
  }

  // ── helpers ──

  _indexById(arr) {
    const m = new Map();
    for (const item of arr) {
      if (item.id) m.set(item.id, item);
    }
    return m;
  }

  /**
   * Return the Set of jurisdiction IDs that are "in scope" for `id`
   * (the jurisdiction itself plus all recursive children).
   */
  _jurisdictionScope(id) {
    const scope = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [jid, jur] of this.jurisdictions) {
        if (!scope.has(jid) && jur.parent_id && scope.has(jur.parent_id)) {
          scope.add(jid);
          changed = true;
        }
      }
    }
    return scope;
  }

  // ── public API ──

  /**
   * Resolve all events for the given year range (inclusive).
   *
   * @param {number}  startYear
   * @param {number}  [endYear]    defaults to startYear
   * @param {object}  [options]
   * @param {string}  [options.jurisdictionId]  filter by jurisdiction (+ children)
   * @returns {ResolvedEvent[]}  sorted by observed_date ascending
   */
  resolve(startYear, endYear = startYear, options = {}) {
    const results = [];
    const scope = options.jurisdictionId
      ? this._jurisdictionScope(options.jurisdictionId)
      : null;

    for (let year = startYear; year <= endYear; year++) {
      for (const [, event] of this.events) {
        if (scope) {
          const jur = this.jurisdictions.get(event.jurisdiction_id);
          if (!jur || !scope.has(jur.id)) continue;
        }
        const resolved = this._resolveEvent(event, year);
        results.push(...resolved);
      }
    }

    results.sort((a, b) => a.observed_date.localeCompare(b.observed_date));
    return results;
  }

  /**
   * Check whether a specific ISO date is a holiday (actual or observed).
   *
   * @param {string}  dateStr        YYYY-MM-DD
   * @param {string}  [jurisdictionId]
   * @returns {{ date, is_holiday, is_actual, is_observed, events }}
   */
  checkDate(dateStr, jurisdictionId = null) {
    const year = parseInt(dateStr.slice(0, 4), 10);
    const all  = this.resolve(year, year, jurisdictionId ? { jurisdictionId } : {});
    const matches = all.filter(e =>
      e.actual_date === dateStr || e.observed_date === dateStr,
    );
    return {
      date: dateStr,
      is_holiday:  matches.length > 0,
      is_actual:   matches.some(e => e.actual_date   === dateStr),
      is_observed: matches.some(e => e.observed_date === dateStr),
      events: matches,
    };
  }

  // ── internal resolution ──

  _resolveEvent(event, year) {
    const td = event.time_definition;
    if (!td) return [];

    const recurrence = td.recurrence;
    let dates = [];

    if (!recurrence) {
      // Static single date
      if (td.start_date) {
        const d = parseDate(td.start_date);
        if (d.getFullYear() === year) dates.push(d);
      }
    } else {
      try {
        dates = RRuleParser.expandForYear(recurrence.rrule, year);
      } catch (err) {
        console.warn(`[HolidayResolver] RRULE expand error for "${event.id}": ${err.message}`);
        return [];
      }

      // Add rdates
      for (const rd of (recurrence.rdate || [])) {
        const d = parseDate(rd);
        if (d.getFullYear() === year) dates.push(d);
      }

      // Remove exdates
      const exSet = new Set((recurrence.exdate || []).map(ex =>
        toDateStr(parseDate(ex)),
      ));
      dates = dates.filter(d => !exSet.has(toDateStr(d)));
    }

    const results = [];
    for (const actualDate of dates) {
      const observedDate = this._applyObservance(
        actualDate,
        recurrence ? (recurrence.observance_rules || []) : [],
      );
      results.push(this._buildResult(event, actualDate, observedDate, year));
    }
    return results;
  }

  _applyObservance(date, rules) {
    const wd = date.getDay(); // 0=Sun, 6=Sat
    for (const rule of rules) {
      let hit = false;
      switch (rule.condition) {
        case 'falls_on_saturday': hit = wd === 6; break;
        case 'falls_on_sunday':   hit = wd === 0; break;
        case 'falls_on_weekend':  hit = wd === 0 || wd === 6; break;
      }
      if (!hit) continue;
      switch (rule.action) {
        case 'observe_previous_business_day': return prevBusinessDay(date);
        case 'observe_next_business_day':     return nextBusinessDay(date);
        case 'no_observance_shift':           return date;
      }
    }
    return date;
  }

  _buildResult(event, actualDate, observedDate, year) {
    const actualStr   = toDateStr(actualDate);
    const observedStr = toDateStr(observedDate);
    const jur         = this.jurisdictions.get(event.jurisdiction_id) || null;
    const impacts     = this._resolveImpacts(event, actualDate, observedDate);

    return {
      id:             event.id,
      name:           event.name,
      classification: event.classification || null,
      status:         event.status || null,
      alt_names:      event.alt_names || [],
      jurisdiction:   jur,
      actual_date:    actualStr,
      observed_date:  observedStr,
      is_shifted:     actualStr !== observedStr,
      shift_direction: actualStr !== observedStr
        ? (observedDate > actualDate ? 'forward' : 'back')
        : null,
      year,
      impacts,
      daily_windows:  event.time_definition?.daily_windows || [],
    };
  }

  // ── impact resolution ──

  _resolveImpacts(event, actualDate, observedDate) {
    return this.impacts
      .filter(impact => this._matchesEvent(impact.match, event))
      .map(impact   => this._evaluateImpact(impact, actualDate, observedDate));
  }

  _matchesEvent(match, event) {
    if (!match) return false;
    // event_id or generic id match
    if (match.event_id && match.event_id !== event.id) return false;
    if (match.id       && match.id       !== event.id) return false;

    // jurisdiction ISO code match
    const jur = this.jurisdictions.get(event.jurisdiction_id);
    if (match.iso_3166_1 && (!jur || jur.iso_3166_1 !== match.iso_3166_1)) return false;
    if (match.iso_3166_2 && (!jur || jur.iso_3166_2 !== match.iso_3166_2)) return false;

    // policy_id match → not applicable for event impacts
    if (match.policy_id) return false;

    return true;
  }

  _evaluateImpact(impact, actualDate, observedDate) {
    const scheduleEntries = [];

    if (impact.impact_schedule) {
      const tz = impact.impact_schedule.timezone;
      for (const opImpact of (impact.impact_schedule.operations || [])) {
        for (const rule of (opImpact.rules || [])) {
          const entry = this._evalImpactRule(
            rule, opImpact.operation, actualDate, observedDate, tz,
          );
          if (entry) scheduleEntries.push(entry);
        }
      }
    }

    return {
      operational_impact: impact.operational_impact || null,
      network_impacts:    impact.network_impacts    || null,
      schedule_entries:   scheduleEntries,
    };
  }

  _evalImpactRule(rule, operation, actualDate, observedDate, timezone) {
    const when = rule.when;
    if (!when) return null;

    const base       = when.date_ref === 'actual' ? actualDate : observedDate;
    const targetDate = addDays(base, when.offset_days || 0);

    // Check condition block
    if (rule.if) {
      const cond = rule.if;
      if (cond.weekday_in && cond.weekday_in.length > 0) {
        const wdCode = WD_SHORT[targetDate.getDay()];
        if (!cond.weekday_in.includes(wdCode)) return null;
      }
      // facility_filters / equipment_filters are pass-through data;
      // network-level filtering is left to the calling application.
    }

    return {
      operation,
      date:        toDateStr(targetDate),
      date_ref:    when.date_ref,
      offset_days: when.offset_days || 0,
      effect:      rule.effect,
      reason:      rule.reason || null,
      condition:   rule.if    || null,
    };
  }
}

// ─── Policy resolver (subset of HolidayResolver for policies) ───────────────

class PolicyResolver {
  constructor(config) {
    this.jurisdictions = new HolidayResolver(config).jurisdictions;
    this.policies = new Map();
    for (const p of (config.policies || [])) {
      if (p.id) this.policies.set(p.id, p);
    }
    this.impacts = (config.impacts || []).filter(imp => imp.match?.policy_id);
  }

  resolve(year) {
    const results = [];
    for (const [, policy] of this.policies) {
      const td = policy.time_definition;
      if (!td?.recurrence) continue;

      let dates = [];
      try {
        dates = RRuleParser.expandForYear(td.recurrence.rrule, year);
      } catch (e) { continue; }

      for (const d of dates) {
        results.push({
          id:       policy.id,
          name:     policy.name,
          category: policy.category,
          status:   policy.status,
          date:     toDateStr(d),
          year,
        });
      }
    }
    results.sort((a, b) => a.date.localeCompare(b.date));
    return results;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

const _exports = {
  HolidayResolver,
  PolicyResolver,
  RRuleParser,
  // date utils exposed for convenience
  toDateStr,
  parseDate,
  addDays,
  formatDateLong,
  WD_SHORT,
  WD_FULL,
  MONTH_FULL,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
} else if (typeof window !== 'undefined') {
  Object.assign(window, _exports);
}
