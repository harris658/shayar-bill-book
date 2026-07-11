/* Shayar Tex — Bill Book (v2.0)
   Vanilla JS, no build step, no ES modules (plain <script src>).
   Ported from design-spec-v2.dc.html's `class Component extends DCLogic`.

   Screens: home | bills | add | parties | more | print

   Architecture:
   - `state` is a single mutable object. `setState(patch)` merges a patch
     (object OR updater function `prev => patch`), persists to localStorage,
     and re-renders.
   - `computeVals(state)` is a near-verbatim port of the spec's `renderVals()`
     — it returns both display strings/classes AND the click/change handlers
     for the *current* render. Handlers are looked up by name at click time
     via a single delegated listener set on the (persistent) root element.
     A few handlers live inside arrays (chips, type buttons, keypad keys,
     party matches, party rows) — those are dispatched by index via a small
     set of special-cased action names, mirroring how `deleteBill` /
     `removeParty` already worked before this rewrite.
   - Party / search / note / new-party text inputs are the one tricky
     interaction: a full innerHTML re-render on every keystroke would
     normally kill focus and caret position. `render()` explicitly saves +
     restores focus and selection range around the innerHTML swap, keyed by
     each input's stable `id`.
   - A single `flash` string in state drives a toast pill (see `toast()`),
     auto-clearing after 2200ms.
*/

(function () {
  'use strict';

  // ===================== Storage keys =====================

  const DATA_KEY = 'stbills.data';
  const SETTINGS_KEY = 'stbills.settings';
  const SNAPSHOT_KEY = 'stbills.snapshot';

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full/unavailable — fail silently, in-memory state still works */
    }
  }

  // ===================== Formatting helpers =====================

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  // "d MMM yy" — used for the print sheet, where a year matters.
  function fmtDate(iso) {
    const [y, m, d] = String(iso).split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mi = parseInt(m, 10) - 1;
    if (!y || !months[mi]) return String(iso);
    return `${d} ${months[mi]} ${y.slice(2)}`;
  }

  // "d MMM" — no year. Used for bill-row meta lines (home / bills screens),
  // verbatim port of the spec's own `fmtDate(iso)` method.
  function fmtDateShort(iso) {
    const dt = new Date(iso + 'T00:00:00');
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function fmtDateTime(isoOrDate) {
    const d = new Date(isoOrDate);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${months[d.getMonth()]}, ${hh}:${mm}`;
  }

  function fmtAmount(n) {
    return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function money(n) {
    return '₹' + fmtAmount(n);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ===================== Amount calculator (restored from v1) =====================
  //
  // The amount keypad is a small calculator: draft.amount may hold an
  // expression over + - * / which safeEval() resolves to the bill amount.
  // A trailing operator/dot is ignored; anything unparsable is NaN.

  function safeEval(str) {
    if (!str) return NaN;
    if (!/^[0-9+\-*/.]+$/.test(str)) return NaN;
    if (/[+\-*/.]$/.test(str)) str = str.slice(0, -1);
    try {
      const v = Function('"use strict";return (' + str + ')')();
      return typeof v === 'number' && isFinite(v) ? v : NaN;
    } catch (e) {
      return NaN;
    }
  }

  // ===================== Data model + migration =====================
  //
  // v1 bills looked like { no, party, date, category, type, amount }.
  // v2 bills look like    { id, party, type, amount, date, note }.
  // v1 parties looked like { name }. v2 parties are plain strings.
  // Migration is idempotent: running it on already-v2 data is a no-op.

  function migrateBill(b) {
    if (!b || typeof b !== 'object') return null;
    const id = (typeof b.id === 'number' && !isNaN(b.id)) ? b.id
      : (typeof b.no === 'number' && !isNaN(b.no)) ? b.no
        : Date.now() + Math.floor(Math.random() * 1000);
    const note = (typeof b.note === 'string' && b.note)
      ? b.note
      : (typeof b.category === 'string' ? b.category : '');
    const amount = typeof b.amount === 'number' && !isNaN(b.amount) ? b.amount : (parseFloat(b.amount) || 0);
    const date = typeof b.date === 'string' && b.date ? b.date : todayStr();
    return {
      id,
      party: typeof b.party === 'string' ? b.party : '',
      type: b.type === 'received' ? 'received' : 'paid',
      amount,
      date,
      note
    };
  }

  function migrateParty(p) {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object' && typeof p.name === 'string') return p.name;
    return null;
  }

  function migrateData(data) {
    if (!data || typeof data !== 'object') return { bills: [], parties: [] };
    const bills = Array.isArray(data.bills) ? data.bills.map(migrateBill).filter(Boolean) : [];
    const parties = Array.isArray(data.parties) ? data.parties.map(migrateParty).filter(Boolean) : [];
    return { bills, parties };
  }

  function sortBills(bills) {
    return bills.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  }

  // ===================== State =====================

  const savedData = loadJSON(DATA_KEY, null);
  const savedSettings = loadJSON(SETTINGS_KEY, null);
  const migrated = migrateData(savedData);

  const state = {
    screen: 'home', // home | bills | add | parties | more | print
    bills: migrated.bills,
    parties: migrated.parties,
    search: '',
    filter: 'all', // all | received | paid
    draft: { type: 'received', party: '', date: todayStr(), note: '', amount: '' },
    newParty: '',
    printMode: 'combined', // combined | perParty
    autoBackup: (savedSettings && typeof savedSettings.autoBackup === 'boolean') ? savedSettings.autoBackup : true,
    flash: ''
  };

  function saveSnapshot() {
    saveJSON(SNAPSHOT_KEY, {
      data: { bills: state.bills, parties: state.parties },
      savedAt: new Date().toISOString()
    });
  }

  // ---- Browser-history mirroring ----
  //
  // Every screen change is reflected into the History API so the system
  // back button/gesture walks back through screens instead of closing the
  // app. Tab screens REPLACE the top entry (Android bottom-nav convention:
  // tabs don't stack), drill-in screens (add, print) PUSH one entry. The
  // boot entry is marked `base` so the first tab switch still pushes once,
  // leaving [home, current-tab, drill-in?] as the deepest possible stack.
  let fromPop = false;

  function syncHistory(prevScreen, nextScreen) {
    if (fromPop || nextScreen === prevScreen) return;
    const isDrill = nextScreen === 'add' || nextScreen === 'print';
    if (isDrill || (history.state && history.state.base)) {
      history.pushState({ screen: nextScreen }, '');
    } else {
      history.replaceState({ screen: nextScreen }, '');
    }
  }

  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    if (!partial) return;
    const dataChanged = ['bills', 'parties'].some((k) => k in partial);
    const settingsChanged = 'autoBackup' in partial;
    const prevScreen = state.screen;
    Object.assign(state, partial);
    if ('screen' in partial) syncHistory(prevScreen, partial.screen);
    if (dataChanged) {
      saveJSON(DATA_KEY, { bills: state.bills, parties: state.parties });
      if (state.autoBackup) saveSnapshot();
    }
    if (settingsChanged) {
      saveJSON(SETTINGS_KEY, { autoBackup: state.autoBackup });
    }
    render();
  }

  // ===================== Toast =====================

  let toastTimer = null;
  function toast(msg) {
    clearTimeout(toastTimer);
    setState({ flash: msg });
    toastTimer = setTimeout(() => {
      setState({ flash: '' });
    }, 2200);
  }

  // ===================== computeVals — port of renderVals() =====================

  function computeVals(s) {
    const screen = s.screen;
    const sorted = sortBills(s.bills);

    const inSum = sorted.filter((b) => b.type === 'received').reduce((a, b) => a + b.amount, 0);
    const outSum = sorted.filter((b) => b.type === 'paid').reduce((a, b) => a + b.amount, 0);
    const net = inSum - outSum;

    const billRow = (b) => {
      const isIn = b.type === 'received';
      return {
        id: b.id,
        party: b.party,
        meta: fmtDateShort(b.date) + (b.note ? ' · ' + b.note : '') + ' · ' + (isIn ? 'Received' : 'Paid'),
        amountText: (isIn ? '+' : '−') + money(b.amount),
        colorClass: isIn ? 'text-positive' : 'text-negative'
      };
    };

    // ---- home ----
    const recentBills = sorted.slice(0, 5).map(billRow);
    const noBills = sorted.length === 0;

    // ---- bills screen ----
    const q = s.search.trim().toLowerCase();
    const filtered = sorted.filter((b) =>
      (s.filter === 'all' || b.type === s.filter) &&
      (!q || b.party.toLowerCase().includes(q) || (b.note || '').toLowerCase().includes(q))
    );
    const chip = (label, value) => ({
      label,
      active: s.filter === value,
      onTap: () => setState({ filter: value })
    });
    const chips = [chip('All', 'all'), chip('Received', 'received'), chip('Paid', 'paid')];
    const filteredBills = filtered.map(billRow);

    // ---- add bill ----
    const dr = s.draft;
    const typeBtn = (label, value) => ({
      label,
      active: dr.type === value,
      onTap: () => setState((st) => ({ draft: { ...st.draft, type: value } }))
    });
    const typeBtns = [typeBtn('Received', 'received'), typeBtn('Paid', 'paid')];

    const pq = dr.party.trim().toLowerCase();
    const hasExactParty = !!pq && s.parties.some((p) => p.toLowerCase() === pq);
    const matchNames = pq && !hasExactParty
      ? s.parties.filter((p) => p.toLowerCase().includes(pq)).slice(0, 4)
      : [];
    const partyMatches = matchNames.map((name) => ({
      name,
      onPick: () => setState((st) => ({ draft: { ...st.draft, party: name } }))
    }));
    // "+ Add as new party" row (restored from v1): typing a name with no
    // exact match offers to create the party right from the bill form.
    const showCreateParty = !!pq && !hasExactParty;
    const onCreateParty = () => {
      const name = dr.party.trim();
      if (!name) return;
      setState((st) => (st.parties.some((p) => p.toLowerCase() === name.toLowerCase())
        ? {}
        : { parties: [...st.parties, name] }));
      toast('Party added ✓');
    };

    // Keypad = v1's calculator in v2's grid: C ⌫ ÷ × / 7 8 9 − / 4 5 6 + /
    // 1 2 3 = / 0 . ("=" spans two rows, "0" spans two columns).
    const isOp = (ch) => ['+', '-', '*', '/'].includes(ch);
    const applyKey = (a, k) => {
      if (k === 'C') return '';
      if (k === '⌫') return a.slice(0, -1);
      if (k === '=') {
        const v = safeEval(a);
        return isNaN(v) ? '' : String(Math.round(v * 100) / 100);
      }
      if (isOp(k)) {
        if (!a) return a;
        return isOp(a.slice(-1)) ? a.slice(0, -1) + k : a + k;
      }
      if (k === '.') {
        const last = a.split(/[+\-*/]/).pop();
        if (last.includes('.')) return a;
        return a + (last === '' ? '0.' : '.');
      }
      if (a.length >= 24) return a;
      return a + k;
    };
    const keyDefs = [
      { label: 'C', key: 'C', cls: 'key-clear' },
      { label: '⌫', key: '⌫', cls: 'key-backspace' },
      { label: '÷', key: '/', cls: 'key-op' },
      { label: '×', key: '*', cls: 'key-op' },
      { label: '7', key: '7', cls: '' },
      { label: '8', key: '8', cls: '' },
      { label: '9', key: '9', cls: '' },
      { label: '−', key: '-', cls: 'key-op' },
      { label: '4', key: '4', cls: '' },
      { label: '5', key: '5', cls: '' },
      { label: '6', key: '6', cls: '' },
      { label: '+', key: '+', cls: 'key-op' },
      { label: '1', key: '1', cls: '' },
      { label: '2', key: '2', cls: '' },
      { label: '3', key: '3', cls: '' },
      { label: '=', key: '=', cls: 'key-equals' },
      { label: '0', key: '0', cls: 'key-zero' },
      { label: '.', key: '.', cls: '' }
    ];
    const keys = keyDefs.map((d) => ({
      label: d.label,
      cls: d.cls,
      onTap: () => setState((st) => ({ draft: { ...st.draft, amount: applyKey(st.draft.amount, d.key) } }))
    }));

    const evaluated = safeEval(dr.amount);
    const amountNum = isNaN(evaluated) ? 0 : Math.round(evaluated * 100) / 100;
    const canSave = dr.party.trim().length > 0 && amountNum > 0;

    const onSave = () => {
      if (!canSave) return;
      const party = dr.party.trim();
      setState((st) => ({
        bills: [...st.bills, { id: Date.now(), party, type: dr.type, amount: amountNum, date: dr.date, note: dr.note.trim() }],
        parties: st.parties.some((p) => p.toLowerCase() === party.toLowerCase()) ? st.parties : [...st.parties, party],
        draft: { type: 'received', party: '', date: todayStr(), note: '', amount: '' },
        screen: 'home'
      }));
      toast('Bill saved ✓');
    };

    // ---- parties ----
    const partiesList = s.parties.map((name) => {
      const count = s.bills.filter((b) => b.party === name).length;
      return {
        name,
        hint: count === 0 ? 'No bills yet' : count + (count === 1 ? ' bill' : ' bills'),
        onDelete: () => {
          if (!confirm(`Delete "${name}" from parties? This does not delete their past bills.`)) return;
          setState((st) => ({ parties: st.parties.filter((p) => p !== name) }));
          toast('Party removed');
        }
      };
    });

    // ---- more ----
    const snapshot = loadJSON(SNAPSHOT_KEY, null);
    const lastBackup = !s.autoBackup ? 'Off' : ((snapshot && snapshot.savedAt) ? fmtDateTime(snapshot.savedAt) : 'Never');

    // ---- print (scope is always ALL bills — the old party/date filter is gone) ----
    const printBills = sorted.map((b) => ({
      dateFmt: fmtDate(b.date),
      party: b.party,
      note: b.note || '',
      signedAmountFmt: (b.type === 'received' ? '+ ₹' : '− ₹') + fmtAmount(b.amount)
    }));
    const printTotals = {
      payableFmt: fmtAmount(outSum),
      receivedFmt: fmtAmount(inSum),
      netFmt: (net < 0 ? '−' : '') + fmtAmount(Math.abs(net))
    };
    const printGroups = (() => {
      const byParty = new Map();
      sorted.forEach((b) => {
        if (!byParty.has(b.party)) byParty.set(b.party, []);
        byParty.get(b.party).push(b);
      });
      return Array.from(byParty.entries()).map(([party, rawBills]) => {
        const bills = rawBills.map((b) => ({
          dateFmt: fmtDate(b.date),
          note: b.note || '',
          signedAmountFmt: (b.type === 'received' ? '+ ₹' : '− ₹') + fmtAmount(b.amount)
        }));
        const total = rawBills.reduce((a, b) => a + (b.type === 'received' ? b.amount : -b.amount), 0);
        return { party, bills, totalFmt: (total < 0 ? '−' : '') + fmtAmount(Math.abs(total)) };
      });
    })();

    const navItem = (key) => ({ active: screen === key });

    return {
      screen,
      isHome: screen === 'home',
      isBills: screen === 'bills',
      isAdd: screen === 'add',
      isParties: screen === 'parties',
      isMore: screen === 'more',
      isPrint: screen === 'print',
      showNav: screen !== 'add' && screen !== 'print',

      goHome: () => setState({ screen: 'home' }),
      goBills: () => setState({ screen: 'bills' }),
      goAdd: () => setState({ screen: 'add' }),
      goParties: () => setState({ screen: 'parties' }),
      goMore: () => setState({ screen: 'more' }),
      // ‹ on drill-in screens = real history back, so the system back
      // button and the on-screen button land on the same previous screen.
      goBack: () => history.back(),

      navHome: navItem('home'),
      navBills: navItem('bills'),
      navParties: navItem('parties'),
      navMore: navItem('more'),

      // ---- home ----
      periodLabel: new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      inTotal: money(inSum),
      outTotal: money(outSum),
      netTotal: (net >= 0 ? '+' : '−') + money(Math.abs(net)),
      netClass: net >= 0 ? 'text-positive' : 'text-negative',
      recentBills,
      noBills,

      // ---- bills screen ----
      search: s.search,
      onSearch: (e) => setState({ search: e.target.value }),
      chips,
      filteredBills,
      noFiltered: filteredBills.length === 0,

      // ---- add bill ----
      typeBtns,
      draftParty: dr.party,
      onPartyInput: (e) => setState((st) => ({ draft: { ...st.draft, party: e.target.value } })),
      showPartyDrop: partyMatches.length > 0 || showCreateParty,
      partyMatches,
      showCreateParty,
      onCreateParty,
      draftDate: dr.date,
      onDateChange: (e) => setState((st) => ({ draft: { ...st.draft, date: e.target.value } })),
      draftNote: dr.note,
      onNoteChange: (e) => setState((st) => ({ draft: { ...st.draft, note: e.target.value } })),
      amountDisplay: dr.amount
        ? '₹' + dr.amount.replace(/\//g, '÷').replace(/\*/g, '×').replace(/-/g, '−')
        : '₹0',
      onClearAmount: () => setState((st) => ({ draft: { ...st.draft, amount: '' } })),
      keys,
      saveDisabled: !canSave,
      onSave,

      // ---- parties ----
      newParty: s.newParty,
      onNewPartyInput: (e) => setState({ newParty: e.target.value }),
      onAddParty: () => {
        const name = s.newParty.trim();
        if (!name) return;
        if (s.parties.some((p) => p.toLowerCase() === name.toLowerCase())) {
          toast('Party already exists');
          return;
        }
        setState((st) => ({ parties: [...st.parties, name], newParty: '' }));
        toast('Party added ✓');
      },
      partiesList,

      // ---- bill delete (dispatched by numeric id — see click listener) ----
      deleteBill: (id) => {
        const bill = state.bills.find((b) => b.id === id);
        if (!bill) return;
        if (!confirm(`Delete bill — ${bill.party}, ₹${fmtAmount(bill.amount)}? This cannot be undone.`)) return;
        setState((st) => ({ bills: st.bills.filter((b) => b.id !== id) }));
        toast('Bill deleted');
      },

      // ---- more ----
      autoBackup: s.autoBackup,
      onToggleBackup: () => setState((st) => ({ autoBackup: !st.autoBackup })),
      lastBackup,
      onExport: () => {
        const payload = { bills: state.bills, parties: state.parties, exportedAt: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `shayar-tex-bills-backup-${todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Backup file downloaded.');
      },
      onImport: () => {
        const input = document.getElementById('restore-file-input');
        if (input) input.click();
      },
      onPrint: () => setState({ screen: 'print' }),

      // ---- print ----
      printModeCombined: s.printMode === 'combined',
      printModePerParty: s.printMode === 'perParty',
      setPrintCombined: () => setState({ printMode: 'combined' }),
      setPrintPerParty: () => setState({ printMode: 'perParty' }),
      printBills,
      printScopeLabel: 'All parties · All dates',
      printGeneratedDate: fmtDate(todayStr()),
      printTotals,
      printGroups,
      closePrint: () => history.back(),
      doPrint: () => window.print(),

      hasFlash: !!s.flash,
      flash: s.flash
    };
  }

  // ===================== HTML builders =====================

  function buildTopbarHome() {
    return `
      <div class="topbar">
        <div class="avatar">ST</div>
        <div class="brand-block">
          <div class="brand-title">SHAYAR TEX</div>
          <div class="brand-sub">Bill Book</div>
        </div>
        <button class="icon-btn" data-action="goMore" aria-label="Settings" title="Settings">⚙</button>
      </div>`;
  }

  function buildBillRow(b, withDelete) {
    const deleteHTML = withDelete
      ? `<button class="icon-delete-btn" data-action="deleteBill" data-id="${b.id}" aria-label="Delete bill" title="Delete bill">✕</button>`
      : '';
    return `
      <div class="bill-row">
        <div class="bill-info">
          <div class="bill-party">${escapeHTML(b.party)}</div>
          <div class="bill-meta">${escapeHTML(b.meta)}</div>
        </div>
        <span class="bill-amount ${b.colorClass}">${b.amountText}</span>
        ${deleteHTML}
      </div>`;
  }

  function buildHome(v) {
    const billsHTML = v.recentBills.length
      ? v.recentBills.map((b) => buildBillRow(b, false)).join('')
      : `<div class="empty-note">No bills yet — tap + to add your first bill</div>`;

    return `<div class="screen">
      ${buildTopbarHome()}
      <div class="home-content">
        <div class="card">
          <div class="cashflow-head">
            <span class="eyebrow">Cashflow</span>
            <span class="cashflow-period">${escapeHTML(v.periodLabel)}</span>
          </div>
          <div class="cashflow-row">
            <div class="cashflow-col">
              <div class="cashflow-label text-positive">Received</div>
              <div class="cashflow-value">${v.inTotal}</div>
            </div>
            <div class="cashflow-col">
              <div class="cashflow-label text-negative">Paid</div>
              <div class="cashflow-value">${v.outTotal}</div>
            </div>
          </div>
          <div class="net-row">
            <span class="net-label">Net</span>
            <span class="net-value ${v.netClass}">${v.netTotal}</span>
          </div>
        </div>

        <div>
          <div class="section-head">
            <span class="section-title">Recent bills</span>
            <button class="link-accent" data-action="goBills">View all →</button>
          </div>
          <div class="bill-list">${billsHTML}</div>
        </div>
      </div>
    </div>`;
  }

  function buildBills(v) {
    const listHTML = v.filteredBills.length
      ? v.filteredBills.map((b) => buildBillRow(b, true)).join('')
      : `<div class="empty-note">No bills match</div>`;
    const chipsHTML = v.chips.map((c, i) => `
      <button class="chip-btn ${c.active ? 'is-active' : ''}" data-action="chipTap" data-index="${i}">${escapeHTML(c.label)}</button>`).join('');

    return `<div class="screen">
      <div class="header-row-tight">
        <span class="screen-title">All bills</span>
      </div>
      <div class="search-row">
        <input type="text" id="search-input" class="text-input" placeholder="Search party or note…" value="${escapeHTML(v.search)}" data-action="onSearch">
      </div>
      <div class="chips-row">${chipsHTML}</div>
      <div class="bills-list">${listHTML}</div>
    </div>`;
  }

  function buildAdd(v) {
    const typeBtnsHTML = v.typeBtns.map((t, i) => `
      <button class="type-btn ${t.active ? 'is-active' : ''}" data-action="typeTap" data-index="${i}">${escapeHTML(t.label)}</button>`).join('');

    const dropdownHTML = v.showPartyDrop ? `
      <div class="autocomplete-dropdown">
        ${v.partyMatches.map((p, i) => `
          <div class="autocomplete-item" data-action="pickParty" data-index="${i}">${escapeHTML(p.name)}</div>`).join('')}
        ${v.showCreateParty ? `
          <div class="autocomplete-item autocomplete-create" data-action="onCreateParty">+ Add "${escapeHTML(v.draftParty.trim())}" as new party</div>` : ''}
      </div>` : '';

    const keysHTML = v.keys.map((k, i) => `
      <button class="key-btn ${k.cls}" data-action="keyTap" data-index="${i}">${escapeHTML(k.label)}</button>`).join('');

    return `<div class="screen-flex">
      <div class="header-row">
        <button class="back-btn" data-action="goBack" aria-label="Back">‹</button>
        <span class="screen-title">New bill</span>
      </div>

      <div class="type-toggle">${typeBtnsHTML}</div>

      <div class="party-field">
        <input type="text" id="party-input" class="text-input" placeholder="Party name" value="${escapeHTML(v.draftParty)}" data-action="onPartyInput" autocomplete="off">
        ${dropdownHTML}
      </div>

      <div class="form-row-2col">
        <input type="date" class="text-input" value="${escapeHTML(v.draftDate)}" data-action="onDateChange">
        <input type="text" id="note-input" class="text-input" placeholder="Note (optional)" value="${escapeHTML(v.draftNote)}" data-action="onNoteChange">
      </div>

      <div class="amount-section">
        <div class="amount-card">
          <div class="amount-card-head">
            <span class="amount-label">Amount</span>
            <button class="link-danger" data-action="onClearAmount">Clear</button>
          </div>
          <div class="amount-value">${escapeHTML(v.amountDisplay)}</div>
        </div>
      </div>

      <div class="keypad">${keysHTML}</div>

      <div class="save-section">
        <button class="btn btn-primary btn-save" data-action="onSave" ${v.saveDisabled ? 'disabled' : ''}>Save bill</button>
      </div>
    </div>`;
  }

  function buildParties(v) {
    const listHTML = v.partiesList.length
      ? v.partiesList.map((p, i) => `
        <div class="party-row">
          <div class="party-info">
            <div class="party-name">${escapeHTML(p.name)}</div>
            <div class="party-hint">${escapeHTML(p.hint)}</div>
          </div>
          <button class="icon-delete-btn" data-action="removeParty" data-index="${i}" aria-label="Delete party" title="Delete party">✕</button>
        </div>`).join('')
      : '';

    return `<div class="screen">
      <div class="header-row-tight">
        <span class="screen-title">Parties</span>
      </div>
      <div class="add-party-row">
        <input type="text" id="new-party-input" class="text-input" placeholder="New party name" value="${escapeHTML(v.newParty)}" data-action="onNewPartyInput">
        <button class="btn btn-primary btn-add-party" data-action="onAddParty">Add</button>
      </div>
      <div class="parties-list">${listHTML}</div>
    </div>`;
  }

  function buildMore(v) {
    return `<div class="screen">
      <div class="header-row-tight">
        <span class="screen-title">More</span>
      </div>
      <div class="more-content">
        <div class="card">
          <div class="more-card-head">
            <span class="more-card-title">Auto backup</span>
            <button class="toggle-switch ${v.autoBackup ? 'is-on' : ''}" data-action="onToggleBackup" aria-label="Toggle auto backup"><span class="toggle-thumb"></span></button>
          </div>
          <div class="explainer">Your bills are saved on this device. Auto backup keeps a copy every day.</div>
          <div class="meta-line">Last backup: ${escapeHTML(v.lastBackup)}</div>
          <div class="more-actions">
            <button class="btn btn-primary btn-flex" data-action="onExport">Export data</button>
            <button class="btn btn-flex" data-action="onImport">Import</button>
          </div>
        </div>
        <div class="card">
          <div class="more-card-title">Print statement</div>
          <div class="explainer">Print or share a statement of bills for any party or month.</div>
          <button class="btn btn-block" data-action="onPrint">Open print preview</button>
        </div>
        <div class="more-footer">Shayar Tex Bill Book · v2.0</div>
      </div>
    </div>`;
  }

  function buildPrintCombined(v) {
    const rowsHTML = v.printBills.length
      ? v.printBills.map((b, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${b.dateFmt}</td>
          <td>${escapeHTML(b.party)}</td>
          <td>${escapeHTML(b.note)}</td>
          <td class="col-amount">${b.signedAmountFmt}</td>
        </tr>`).join('')
      : `<tr><td colspan="5" class="print-empty">No bills yet.</td></tr>`;

    return `
      <div class="print-page">
        <div class="print-header">
          <div class="print-brand">SHAYAR TEX</div>
          <div class="print-subtitle">BILL SUMMARY</div>
        </div>
        <div class="print-scope-row">
          <span>Scope: ${escapeHTML(v.printScopeLabel)}</span>
          <span>Generated: ${v.printGeneratedDate}</span>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th>No</th>
              <th>Date</th>
              <th>Party</th>
              <th>Note</th>
              <th class="col-amount">Amount</th>
            </tr>
          </thead>
          <tbody>${rowsHTML}</tbody>
        </table>
        <div class="print-totals">
          <div>Total Paid: <b>₹${v.printTotals.payableFmt}</b></div>
          <div>Total Received: <b>₹${v.printTotals.receivedFmt}</b></div>
          <div>Net: <b>₹${v.printTotals.netFmt}</b></div>
        </div>
        <div class="signature-row">
          <span>Manager</span>
          <span>Accountant</span>
          <span>Receiver's Signature</span>
        </div>
      </div>`;
  }

  function buildPrintPerParty(v) {
    if (!v.printGroups.length) {
      return `
        <div class="print-page">
          <div class="print-header">
            <div class="print-brand">SHAYAR TEX</div>
            <div class="print-subtitle">DEBIT VOUCHER</div>
          </div>
          <div class="print-empty">No bills yet.</div>
        </div>`;
    }
    return v.printGroups.map((g) => {
      const rowsHTML = g.bills.map((b, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${b.dateFmt}</td>
          <td>${escapeHTML(b.note)}</td>
          <td class="col-amount">${b.signedAmountFmt}</td>
        </tr>`).join('');

      return `
        <div class="print-page">
          <div class="print-header">
            <div class="print-brand">SHAYAR TEX</div>
            <div class="print-subtitle">DEBIT VOUCHER</div>
          </div>
          <div class="print-scope-row">
            <span>Pay to: ${escapeHTML(g.party)}</span>
            <span>Date: ${v.printGeneratedDate}</span>
          </div>
          <table class="print-table">
            <thead>
              <tr>
                <th>No</th>
                <th>Date</th>
                <th>Note</th>
                <th class="col-amount">Amount</th>
              </tr>
            </thead>
            <tbody>${rowsHTML}</tbody>
          </table>
          <div class="print-totals-single">
            <div>Total: <b>₹${g.totalFmt}</b></div>
          </div>
          <div class="signature-row">
            <span>Manager</span>
            <span>Accountant</span>
            <span>Receiver's Signature</span>
          </div>
        </div>`;
    }).join('');
  }

  function buildPrint(v) {
    return `<div id="print-sheet">
      <div class="print-topbar no-print">
        <button class="back-btn" data-action="closePrint" aria-label="Back">‹</button>
        <span class="screen-title">Print preview</span>
        <button class="btn btn-primary" data-action="doPrint">Print</button>
      </div>
      <div class="print-mode-toggle no-print">
        <button class="type-btn ${v.printModeCombined ? 'is-active' : ''}" data-action="setPrintCombined">All together</button>
        <button class="type-btn ${v.printModePerParty ? 'is-active' : ''}" data-action="setPrintPerParty">Separate bill per party</button>
      </div>
      ${v.printModeCombined ? buildPrintCombined(v) : buildPrintPerParty(v)}
    </div>`;
  }

  function buildNav(v) {
    if (!v.showNav) return '';
    const homeSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>';
    const billsSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l3 3v15l-2.2-1.4L13.6 21l-2.2-1.4L9.2 21 7 19.6 6 21z"/><path d="M9 8h6"/><path d="M9 12h6"/></svg>';
    const partiesSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.2 2.5-5.3 5.5-5.3s5.5 2.1 5.5 5.3"/><path d="M16 5.2A3.2 3.2 0 0 1 16 11.5"/><path d="M17 14.9c2.4.4 4 2.4 4 5.1"/></svg>';
    const moreSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

    const navBtn = (action, item, label, svg) => `
      <button class="nav-item ${item.active ? 'is-active' : ''}" data-action="${action}">
        ${svg}
        <div class="nav-label">${label}</div>
      </button>`;

    return `
      <div class="bottom-nav">
        <div class="nav-row">
          <div class="nav-group">
            ${navBtn('goHome', v.navHome, 'Home', homeSvg)}
            ${navBtn('goBills', v.navBills, 'Bills', billsSvg)}
          </div>
          <div class="nav-spacer"></div>
          <div class="nav-group">
            ${navBtn('goParties', v.navParties, 'Parties', partiesSvg)}
            ${navBtn('goMore', v.navMore, 'More', moreSvg)}
          </div>
        </div>
        <button class="nav-fab" data-action="goAdd" aria-label="New bill">+</button>
      </div>`;
  }

  function buildToast(v) {
    return v.hasFlash ? `<div class="toast">${escapeHTML(v.flash)}</div>` : '';
  }

  // ===================== Render =====================

  const root = document.getElementById('app-root');
  let currentVals = null;
  // The window keeps its scroll position across innerHTML swaps, so switching
  // from a scrolled long screen would show the next screen mid-scroll with its
  // title off-screen. Reset to the top whenever the screen changes.
  let lastScreen = null;
  // Guards the focusin listener while render() programmatically restores
  // focus below — without this, restoring focus fires a 'focusin' event,
  // which calls the field's onFocus handler, which calls setState(), which
  // calls render() again, which restores focus again: infinite recursion.
  let restoringFocus = false;

  function render() {
    // Save focus + caret so text inputs (search / party / note / new-party)
    // don't lose keyboard focus on every keystroke (innerHTML replace
    // destroys and recreates every node).
    const active = document.activeElement;
    let focusInfo = null;
    if (active && active.id && root.contains(active)) {
      focusInfo = { id: active.id };
      if (typeof active.selectionStart === 'number') {
        focusInfo.start = active.selectionStart;
        focusInfo.end = active.selectionEnd;
      }
    }

    const v = computeVals(state);
    currentVals = v;

    let html;
    if (v.isPrint) {
      html = buildPrint(v);
    } else {
      let screenHTML = '';
      if (v.isHome) screenHTML = buildHome(v);
      else if (v.isBills) screenHTML = buildBills(v);
      else if (v.isAdd) screenHTML = buildAdd(v);
      else if (v.isParties) screenHTML = buildParties(v);
      else if (v.isMore) screenHTML = buildMore(v);
      html = screenHTML + buildNav(v);
    }
    html += buildToast(v);
    root.innerHTML = html;

    if (v.screen !== lastScreen) {
      window.scrollTo(0, 0);
      lastScreen = v.screen;
    }

    if (focusInfo) {
      const el = document.getElementById(focusInfo.id);
      if (el) {
        restoringFocus = true;
        el.focus();
        restoringFocus = false;
        if (focusInfo.start != null && typeof el.setSelectionRange === 'function') {
          try {
            el.setSelectionRange(focusInfo.start, focusInfo.end);
          } catch (e) {
            /* not a text-selectable input type — ignore */
          }
        }
      }
    }
  }

  // ===================== Action dispatch =====================

  function resolveAction(name) {
    if (!currentVals) return null;
    return currentVals[name];
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    // Text/date inputs carry data-action for the 'input'/'change' listeners
    // below — a plain click on them must not invoke the handler (it would be
    // called without an event object).
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    const action = el.dataset.action;

    // Indexed-list actions: the handler lives on an item inside an array
    // returned by computeVals, so it's looked up by index rather than name.
    if (action === 'chipTap') {
      const i = Number(el.dataset.index);
      if (currentVals.chips[i]) currentVals.chips[i].onTap();
      return;
    }
    if (action === 'typeTap') {
      const i = Number(el.dataset.index);
      if (currentVals.typeBtns[i]) currentVals.typeBtns[i].onTap();
      return;
    }
    if (action === 'pickParty') {
      const i = Number(el.dataset.index);
      if (currentVals.partyMatches[i]) currentVals.partyMatches[i].onPick();
      return;
    }
    if (action === 'keyTap') {
      const i = Number(el.dataset.index);
      if (currentVals.keys[i]) currentVals.keys[i].onTap();
      return;
    }
    if (action === 'removeParty') {
      const i = Number(el.dataset.index);
      if (currentVals.partiesList[i]) currentVals.partiesList[i].onDelete();
      return;
    }
    if (action === 'deleteBill') {
      const id = Number(el.dataset.id);
      if (typeof currentVals.deleteBill === 'function') currentVals.deleteBill(id);
      return;
    }

    const fn = resolveAction(action);
    if (typeof fn === 'function') fn();
  });

  root.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.action) return;
    if (el.tagName === 'INPUT' && el.type === 'text') {
      const fn = resolveAction(el.dataset.action);
      if (typeof fn === 'function') fn(e);
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.action) return;
    const isDate = el.tagName === 'INPUT' && el.type === 'date';
    if (isDate) {
      const fn = resolveAction(el.dataset.action);
      if (typeof fn === 'function') fn(e);
    }
  });

  // 'focus' does not bubble — use 'focusin' for delegation. (No screen
  // currently wires up data-focus-action, but the listener is kept as part
  // of the app's standing delegated-event architecture.)
  root.addEventListener('focusin', (e) => {
    if (restoringFocus) return; // programmatic refocus after render — not a user focus event
    const el = e.target;
    if (!el.dataset || !el.dataset.focusAction) return;
    const fn = resolveAction(el.dataset.focusAction);
    if (typeof fn === 'function') fn(e);
  });

  // ===================== Restore-from-file (input lives outside root) =====================

  const restoreInput = document.getElementById('restore-file-input');
  if (restoreInput) {
    restoreInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // allow re-selecting the same file later
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (err) {
          toast('That file is not a valid backup.');
          return;
        }
        if (!parsed || !Array.isArray(parsed.bills) || !Array.isArray(parsed.parties)) {
          toast('That file is not a valid backup.');
          return;
        }
        if (!confirm('Restore from this file? This replaces all bills and parties currently on this device.')) return;
        // Accepts both old-format and new-format backups.
        const restored = migrateData(parsed);
        setState({ bills: restored.bills, parties: restored.parties });
        toast('Restored from file.');
      };
      reader.readAsText(file);
    });
  }

  // ===================== Boot =====================

  history.replaceState({ screen: state.screen, base: true }, '');

  window.addEventListener('popstate', (e) => {
    const target = (e.state && e.state.screen) || 'home';
    fromPop = true;
    setState({ screen: target });
    fromPop = false;
  });

  render();
})();
