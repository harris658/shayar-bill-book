/* Shayar Tex — Bill Book
   Vanilla JS, no build step, no ES modules (plain <script src>).
   Ported from design-spec.dc.html's `class Component extends DCLogic`.

   Architecture:
   - `state` is a single mutable object. `setState(patch)` merges a patch
     (object OR updater function `prev => patch`), persists to localStorage,
     and re-renders.
   - `computeVals(state)` is a near-verbatim port of the spec's `renderVals()`
     — it returns both display strings/classes AND the click/change handlers
     for the *current* render. Handlers are looked up by name at click time
     via a single delegated listener set on the (persistent) root element.
   - Party-name / new-party-name inputs are the one tricky interaction:
     a full innerHTML re-render on every keystroke would normally kill focus
     and caret position. `render()` explicitly saves + restores focus and
     selection range around the innerHTML swap.
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

  // ===================== Formatting helpers (verbatim from spec) =====================

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${months[parseInt(m, 10) - 1]} ${y.slice(2)}`;
  }

  // "dd MMM" — no year. Used only for the computed party hint (see spec seed
  // data at line 524: 'last bill 02 Jul · ₹4,750' has no year).
  function fmtDateNoYear(iso) {
    const d = new Date(iso + 'T00:00:00');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}`;
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

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function categoryColorClass(cat) {
    if (cat === 'Salary/Income') return 'cat-color-income';
    if (cat === 'Rent') return 'cat-color-rent';
    return 'cat-color-other';
  }

  // Party hint is computed at render time from the bills list, not stored
  // on the party record (brief: "COMPUTE dynamically from bills").
  function computePartyHint(name, bills) {
    const matches = bills.filter((b) => b.party === name);
    if (matches.length === 0) return 'no bills yet';
    const latest = matches.reduce((best, b) => {
      if (!best) return b;
      if (b.date !== best.date) return b.date > best.date ? b : best;
      return b.no > best.no ? b : best;
    }, null);
    return `last bill ${fmtDateNoYear(latest.date)} · ₹${fmtAmount(latest.amount)}`;
  }

  // ===================== Calculator (verbatim from spec) =====================

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

  function calcAppend(token) {
    setState((s) => {
      let str = s.calcStr;
      const isOp = (ch) => ['+', '-', '*', '/'].includes(ch);
      if (isOp(token)) {
        if (!str) return {};
        if (isOp(str.slice(-1))) str = str.slice(0, -1) + token;
        else str = str + token;
      } else if (token === '.') {
        const parts = str.split(/[+\-*/]/);
        const last = parts[parts.length - 1];
        if (last.includes('.')) return {};
        str = str + (str === '' ? '0.' : '.');
      } else {
        str = str + token;
      }
      return { calcStr: str };
    });
  }

  // ===================== State =====================

  const savedData = loadJSON(DATA_KEY, null);
  const savedSettings = loadJSON(SETTINGS_KEY, null);

  const state = {
    screen: 'home', // home | add | backup | bills | parties | print
    homeVariant: (savedSettings && savedSettings.homeVariant === 'B') ? 'B' : 'A',
    showAll: false,
    bills: (savedData && Array.isArray(savedData.bills)) ? savedData.bills : [],
    nextNo: (savedData && typeof savedData.nextNo === 'number') ? savedData.nextNo : 1,
    parties: (savedData && Array.isArray(savedData.parties)) ? savedData.parties : [],
    form: { type: 'paid', party: '', date: todayStr(), category: 'Bills & Utilities' },
    partyDropdownOpen: false,
    billsFilter: { party: '', date: '' },
    newPartyName: '',
    printMode: 'combined',
    calcStr: '',
    autoBackup: (savedSettings && typeof savedSettings.autoBackup === 'boolean') ? savedSettings.autoBackup : true,
    flashMsg: ''
  };

  function saveSnapshot() {
    saveJSON(SNAPSHOT_KEY, {
      data: { bills: state.bills, parties: state.parties, nextNo: state.nextNo },
      savedAt: new Date().toISOString()
    });
  }

  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    if (!partial) return;
    const dataChanged = ['bills', 'parties', 'nextNo'].some((k) => k in partial);
    const settingsChanged = ['homeVariant', 'autoBackup'].some((k) => k in partial);
    Object.assign(state, partial);
    if (dataChanged) {
      saveJSON(DATA_KEY, { bills: state.bills, parties: state.parties, nextNo: state.nextNo });
      if (state.autoBackup) saveSnapshot();
    }
    if (settingsChanged) {
      saveJSON(SETTINGS_KEY, { homeVariant: state.homeVariant, autoBackup: state.autoBackup });
    }
    render();
  }

  // ===================== computeVals — port of renderVals() =====================

  function computeVals(s) {
    const screen = s.screen;

    const shown = s.showAll ? s.bills : s.bills.slice(0, 3);
    const visibleBills = shown.map((b) => ({
      no: b.no,
      party: b.party,
      dateFmt: fmtDate(b.date),
      category: b.category,
      amountClass: b.type === 'received' ? 'amount-positive' : 'amount-negative',
      signedAmountFmt: (b.type === 'received' ? '+ ₹' : '− ₹') + fmtAmount(b.amount)
    }));

    const payable = s.bills.filter((b) => b.type === 'paid').reduce((a, b) => a + b.amount, 0);
    const received = s.bills.filter((b) => b.type === 'received').reduce((a, b) => a + b.amount, 0);
    const net = received - payable;
    const summary = {
      payableFmt: fmtAmount(payable),
      receivedFmt: fmtAmount(received),
      netFmt: fmtAmount(Math.abs(net)),
      netClass: net < 0 ? 'text-negative' : 'text-positive'
    };
    if (net < 0) summary.netFmt = '−' + summary.netFmt;

    const cats = ['Bills & Utilities', 'Rent', 'Salary/Income'];
    const catTotals = cats.map((c) => ({
      name: c,
      amount: s.bills.filter((b) => b.category === c).reduce((a, b) => a + b.amount, 0)
    }));
    const maxCat = Math.max(1, ...catTotals.map((c) => c.amount));
    const categoryBreakdown = catTotals.map((c) => ({
      name: c.name,
      amountFmt: fmtAmount(c.amount),
      pct: Math.round((c.amount / maxCat) * 100),
      colorClass: categoryColorClass(c.name)
    }));

    const calcDisplay = s.calcStr === '' ? '0' : s.calcStr;
    const evaluated = safeEval(s.calcStr);
    const amountValue = isNaN(evaluated) ? 0 : evaluated;

    const partyQuery = (s.form.party || '').toLowerCase();
    const partySuggestions = s.parties
      .filter((p) => partyQuery && p.name.toLowerCase().includes(partyQuery) && p.name.toLowerCase() !== partyQuery)
      .slice(0, 4)
      .map((p) => ({
        name: p.name,
        hint: computePartyHint(p.name, s.bills),
        select: () => setState({ form: { ...state.form, party: p.name }, partyDropdownOpen: false })
      }));
    const exactMatch = s.parties.some((p) => p.name.toLowerCase() === partyQuery);
    const showCreateParty = !!partyQuery && !exactMatch;

    // Deviation from spec: the spec gates the *entire* dropdown (including
    // the "+ Add as new party" row) on `partySuggestions.length > 0`, which
    // means typing a brand-new party name with zero fuzzy matches would never
    // show the create-party prompt at all. Since that prompt is an explicit
    // requirement here, the dropdown opens when there are suggestions OR a
    // create-party prompt to show.
    const partyDropdownOpen = s.partyDropdownOpen && (partySuggestions.length > 0 || showCreateParty);

    const filteredRaw = s.bills
      .filter((b) => !s.billsFilter.party || b.party === s.billsFilter.party)
      .filter((b) => !s.billsFilter.date || b.date === s.billsFilter.date);
    const filteredBills = filteredRaw.map((b) => ({
      no: b.no,
      party: b.party,
      dateFmt: fmtDate(b.date),
      category: b.category,
      amountClass: b.type === 'received' ? 'amount-positive' : 'amount-negative',
      signedAmountFmt: (b.type === 'received' ? '+ ₹' : '− ₹') + fmtAmount(b.amount)
    }));

    const partiesList = s.parties.map((p) => ({
      name: p.name,
      hint: computePartyHint(p.name, s.bills),
      remove: () => {
        if (!confirm(`Delete "${p.name}" from parties? This does not delete their past bills.`)) return;
        setState({ parties: state.parties.filter((x) => x.name !== p.name) });
      }
    }));

    const saveDisabled = !(s.form.party.trim() && amountValue > 0);
    const addPartyDisabled = !s.newPartyName.trim() ||
      s.parties.some((p) => p.name.toLowerCase() === s.newPartyName.trim().toLowerCase());

    const snapshot = loadJSON(SNAPSHOT_KEY, null);
    const backupLocalLastFmt = (snapshot && snapshot.savedAt) ? fmtDateTime(snapshot.savedAt) : 'Never';

    // ---- print ----
    const printTotalsPayable = filteredRaw.filter((b) => b.type === 'paid').reduce((a, b) => a + b.amount, 0);
    const printTotalsReceived = filteredRaw.filter((b) => b.type === 'received').reduce((a, b) => a + b.amount, 0);
    const printTotalsNet = printTotalsReceived - printTotalsPayable;
    const printTotals = {
      payableFmt: fmtAmount(printTotalsPayable),
      receivedFmt: fmtAmount(printTotalsReceived),
      netFmt: (printTotalsNet < 0 ? '−' : '') + fmtAmount(Math.abs(printTotalsNet))
    };

    const printGroups = (() => {
      const byParty = new Map();
      filteredRaw.forEach((b) => {
        if (!byParty.has(b.party)) byParty.set(b.party, []);
        byParty.get(b.party).push(b);
      });
      return Array.from(byParty.entries()).map(([party, rawBills]) => {
        const bills = rawBills.map((b) => ({
          no: b.no,
          dateFmt: fmtDate(b.date),
          category: b.category,
          signedAmountFmt: (b.type === 'received' ? '+ ₹' : '− ₹') + fmtAmount(b.amount)
        }));
        const total = rawBills.reduce((a, b) => a + (b.type === 'received' ? b.amount : -b.amount), 0);
        return { party, bills, totalFmt: (total < 0 ? '−' : '') + fmtAmount(Math.abs(total)) };
      });
    })();

    const printScopeLabel = (s.billsFilter.party && s.billsFilter.date)
      ? `${s.billsFilter.party} · ${fmtDate(s.billsFilter.date)}`
      : s.billsFilter.party ? s.billsFilter.party
        : s.billsFilter.date ? fmtDate(s.billsFilter.date)
          : 'All parties · All dates';

    return {
      screen,
      isHome: screen === 'home',
      isAdd: screen === 'add',
      isBackup: screen === 'backup',
      isBills: screen === 'bills',
      isParties: screen === 'parties',
      isPrint: screen === 'print',
      isVariantA: s.homeVariant === 'A',
      isVariantB: s.homeVariant === 'B',
      isTabScreen: screen === 'home' || screen === 'bills' || screen === 'parties' || screen === 'backup',

      navHomeActive: screen === 'home',
      navBillsActive: screen === 'bills',
      navPartiesActive: screen === 'parties',
      navMoreActive: screen === 'backup',
      goHome: () => setState({ screen: 'home' }),
      goBills: () => setState({ screen: 'bills' }),
      goParties: () => setState({ screen: 'parties' }),
      goBackup: () => setState({ screen: 'backup', flashMsg: '' }),

      variantAActive: s.homeVariant === 'A',
      variantBActive: s.homeVariant === 'B',
      setVariantA: () => setState({ homeVariant: 'A' }),
      setVariantB: () => setState({ homeVariant: 'B' }),
      showCategoryBreakdown: true,

      summary,
      hasBills: s.bills.length > 0,
      visibleBills,
      seeAllLabel: s.showAll ? 'Show less' : 'See all',
      toggleShowAll: () => setState({ showAll: !state.showAll }),
      categoryBreakdown,

      backupLocalLastFmt,
      openBackup: () => setState({ screen: 'backup', flashMsg: '' }),

      openAdd: () => setState({ screen: 'add' }),
      closeAdd: () => setState({
        screen: 'home',
        calcStr: '',
        form: { type: 'paid', party: '', date: todayStr(), category: 'Bills & Utilities' }
      }),

      form: s.form,
      partyPlaceholder: s.form.type === 'paid' ? 'Party you paid' : 'Party you received from',
      onPartyChange: (e) => setState({ form: { ...state.form, party: e.target.value }, partyDropdownOpen: true }),
      onPartyFocus: () => {
        // Guard against a no-op re-render: setState() always re-renders (no
        // diffing), and a full re-render recreates this very input node —
        // pointless churn (and, on some mobile browsers, a visible keyboard
        // flicker) if the dropdown-open state wouldn't actually change.
        const shouldOpen = !!state.form.party;
        if (state.partyDropdownOpen !== shouldOpen) setState({ partyDropdownOpen: shouldOpen });
      },
      partyDropdownOpen,
      partySuggestions,
      showCreateParty,
      createPartyFromInput: () => {
        const name = state.form.party.trim();
        if (!name) return;
        const exists = state.parties.some((p) => p.name.toLowerCase() === name.toLowerCase());
        setState({
          parties: exists ? state.parties : [...state.parties, { name }],
          partyDropdownOpen: false
        });
      },
      onDateChange: (e) => setState({ form: { ...state.form, date: e.target.value } }),
      onCategoryChange: (e) => setState({ form: { ...state.form, category: e.target.value } }),

      typePaidActive: s.form.type === 'paid',
      typeReceivedActive: s.form.type === 'received',
      setTypePaid: () => setState({ form: { ...state.form, type: 'paid' } }),
      setTypeReceived: () => setState({ form: { ...state.form, type: 'received' } }),

      calc: {
        display: calcDisplay,
        clear: () => setState({ calcStr: '' }),
        backspace: () => setState({ calcStr: state.calcStr.slice(0, -1) }),
        press0: () => calcAppend('0'),
        press1: () => calcAppend('1'),
        press2: () => calcAppend('2'),
        press3: () => calcAppend('3'),
        press4: () => calcAppend('4'),
        press5: () => calcAppend('5'),
        press6: () => calcAppend('6'),
        press7: () => calcAppend('7'),
        press8: () => calcAppend('8'),
        press9: () => calcAppend('9'),
        pressDot: () => calcAppend('.'),
        pressPlus: () => calcAppend('+'),
        pressMinus: () => calcAppend('-'),
        pressMul: () => calcAppend('*'),
        pressDiv: () => calcAppend('/'),
        pressEquals: () => {
          const v = safeEval(state.calcStr);
          setState({ calcStr: isNaN(v) ? '' : String(Math.round(v * 100) / 100) });
        }
      },

      saveDisabled,
      saveBill: () => {
        if (saveDisabled) return;
        const f = state.form;
        const partyName = f.party.trim();
        const newBill = {
          no: state.nextNo,
          party: partyName,
          date: f.date,
          category: f.category,
          type: f.type,
          amount: Math.round(amountValue * 100) / 100
        };
        const exists = state.parties.some((p) => p.name.toLowerCase() === partyName.toLowerCase());
        setState({
          bills: [newBill, ...state.bills],
          parties: exists ? state.parties : [...state.parties, { name: partyName }],
          nextNo: state.nextNo + 1,
          screen: 'home',
          calcStr: '',
          form: { type: 'paid', party: '', date: todayStr(), category: 'Bills & Utilities' }
        });
      },

      // ---- backup screen ----
      autoBackupOn: s.autoBackup,
      toggleAutoBackup: () => setState({ autoBackup: !state.autoBackup }),
      flashMsg: s.flashMsg,
      closeBackup: () => setState({ screen: 'home' }),
      backupNowLocal: () => {
        saveSnapshot();
        setState({ flashMsg: 'Backed up to local storage.' });
      },
      restoreLocal: () => {
        const snap = loadJSON(SNAPSHOT_KEY, null);
        if (!snap || !snap.data) {
          setState({ flashMsg: 'No local backup found yet.' });
          return;
        }
        if (!confirm('Restore from the last local backup? This replaces all bills and parties currently on this device.')) return;
        setState({
          bills: Array.isArray(snap.data.bills) ? snap.data.bills : [],
          parties: Array.isArray(snap.data.parties) ? snap.data.parties : [],
          nextNo: typeof snap.data.nextNo === 'number' ? snap.data.nextNo : 1,
          flashMsg: 'Restored from local storage.'
        });
      },
      downloadBackup: () => {
        const payload = {
          bills: state.bills,
          parties: state.parties,
          nextNo: state.nextNo,
          exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `shayar-tex-bills-backup-${todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setState({ flashMsg: 'Backup file downloaded.' });
      },
      restoreFromFile: () => {
        const input = document.getElementById('restore-file-input');
        if (input) input.click();
      },

      // ---- all bills screen ----
      parties: s.parties,
      billsFilter: s.billsFilter,
      onFilterPartyChange: (e) => setState({ billsFilter: { ...state.billsFilter, party: e.target.value } }),
      onFilterDateChange: (e) => setState({ billsFilter: { ...state.billsFilter, date: e.target.value } }),
      hasFilters: !!(s.billsFilter.party || s.billsFilter.date),
      clearFilters: () => setState({ billsFilter: { party: '', date: '' } }),
      filteredBills,
      noFilteredResults: filteredBills.length === 0,
      printDisabled: filteredBills.length === 0,
      openPrint: () => {
        if (filteredBills.length) setState({ screen: 'print' });
      },
      deleteBill: (no) => {
        const bill = state.bills.find((b) => b.no === no);
        if (!bill) return;
        if (!confirm(`Delete bill #${bill.no} — ${bill.party}, ₹${fmtAmount(bill.amount)}? This cannot be undone.`)) return;
        setState({ bills: state.bills.filter((b) => b.no !== no) });
      },

      // ---- parties screen ----
      partiesList,
      newPartyName: s.newPartyName,
      onNewPartyChange: (e) => setState({ newPartyName: e.target.value }),
      addPartyDisabled,
      addParty: () => {
        const name = state.newPartyName.trim();
        if (!name || state.parties.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
        setState({ parties: [...state.parties, { name }], newPartyName: '' });
      },

      // ---- print screen ----
      printModeCombined: s.printMode === 'combined',
      printModePerParty: s.printMode === 'perParty',
      setPrintCombined: () => setState({ printMode: 'combined' }),
      setPrintPerParty: () => setState({ printMode: 'perParty' }),
      printBills: filteredBills,
      printScopeLabel,
      printGeneratedDate: fmtDate(todayStr()),
      printTotals,
      printGroups,
      closePrint: () => setState({ screen: 'bills' }),
      doPrint: () => window.print()
    };
  }

  // ===================== HTML builders =====================

  function buildTopbar(v) {
    return `
      <div class="topbar">
        <div class="avatar">ST</div>
        <div class="brand-block">
          <div class="brand-title">SHAYAR TEX</div>
          <div class="brand-sub">Bill Book</div>
        </div>
        <button class="icon-btn" data-action="openBackup" title="Backup &amp; restore">&#9729;</button>
        <div class="segmented variant-toggle">
          <button class="seg-btn ${v.variantAActive ? 'is-active' : ''}" data-action="setVariantA">A</button>
          <button class="seg-btn ${v.variantBActive ? 'is-active' : ''}" data-action="setVariantB">B</button>
        </div>
      </div>`;
  }

  function buildBillRow(b, withDelete) {
    const deleteHTML = withDelete
      ? `<button class="bill-delete-btn" data-action="deleteBill" data-no="${b.no}" title="Delete bill">&times;</button>`
      : '';
    return `
      <div class="bill-row">
        <div class="bill-info">
          <div class="bill-party">${escapeHTML(b.party)}</div>
          <div class="bill-meta">#${b.no} · ${b.dateFmt} · ${escapeHTML(b.category)}</div>
        </div>
        <span class="bill-amount ${b.amountClass}">${b.signedAmountFmt}</span>
        ${deleteHTML}
      </div>`;
  }

  function buildHomeVariantA(v) {
    const billsHTML = v.visibleBills.length
      ? v.visibleBills.map((b) => buildBillRow(b)).join('')
      : `<div class="empty-note">No bills yet — tap + to add your first bill.</div>`;

    const categoriesHTML = v.showCategoryBreakdown ? `
      <div>
        <div class="section-title categories-title">Categories</div>
        <div class="categories-card">
          ${v.categoryBreakdown.map((c) => `
            <div>
              <div class="category-row-head">
                <span>${escapeHTML(c.name)}</span>
                <span class="category-amount">&#8377;${c.amountFmt}</span>
              </div>
              <div class="category-track">
                <div class="category-fill ${c.colorClass}" style="width:${c.pct}%;"></div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : '';

    return `
      <div class="home-content">
        <div class="card">
          <div class="cashflow-head">
            <span class="eyebrow">Cash Flow</span>
            <span class="cashflow-period">This Month &#9662;</span>
          </div>
          <div class="cashflow-row">
            <div class="cashflow-col">
              <div class="cashflow-label text-negative">Payable</div>
              <div class="cashflow-value">&#8377;${v.summary.payableFmt}</div>
            </div>
            <div class="cashflow-col">
              <div class="cashflow-label text-positive">Received</div>
              <div class="cashflow-value">&#8377;${v.summary.receivedFmt}</div>
            </div>
          </div>
          <div class="net-row">
            <span class="net-label">Net Balance</span>
            <span class="net-value ${v.summary.netClass}">&#8377;${v.summary.netFmt}</span>
          </div>
        </div>

        <div>
          <div class="section-head">
            <span class="section-title">Recent Bills</span>
            <button class="link-muted" data-action="toggleShowAll">${v.seeAllLabel}</button>
          </div>
          <div class="bill-list">${billsHTML}</div>
        </div>

        ${categoriesHTML}

        <div class="card card-clickable" data-action="openBackup">
          <div class="backup-card-head">
            <span class="backup-card-title">Backup</span>
            <span class="backup-manage">Manage &#8250;</span>
          </div>
          <div class="backup-card-sub">Last backup ${v.backupLocalLastFmt}</div>
        </div>
      </div>`;
  }

  function buildHomeVariantB(v) {
    const rowsHTML = v.visibleBills.length
      ? v.visibleBills.map((b) => `
        <tr>
          <td>${escapeHTML(b.party)}<div class="ledger-subline">${escapeHTML(b.category)}</div></td>
          <td class="col-date">${b.dateFmt}</td>
          <td class="col-amount ${b.amountClass}">${b.signedAmountFmt}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="ledger-empty">No bills yet — tap + to add your first bill.</td></tr>`;

    const chipsHTML = v.showCategoryBreakdown ? `
      <div class="chip-row">
        ${v.categoryBreakdown.map((c) => `
          <span class="chip">${escapeHTML(c.name)} <span class="chip-amount">&#8377;${c.amountFmt}</span></span>`).join('')}
      </div>` : '';

    return `
      <div class="ledger-content">
        <div class="summary-strip">
          <div class="summary-col">
            <div class="summary-label text-negative">Payable</div>
            <div class="summary-value">&#8377;${v.summary.payableFmt}</div>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-col">
            <div class="summary-label text-positive">Received</div>
            <div class="summary-value">&#8377;${v.summary.receivedFmt}</div>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-col">
            <div class="summary-label">Net</div>
            <div class="summary-value ${v.summary.netClass}">&#8377;${v.summary.netFmt}</div>
          </div>
        </div>

        <div class="ledger-head">
          <span class="ledger-title">Ledger</span>
          <button class="link-muted" data-action="toggleShowAll">${v.seeAllLabel}</button>
        </div>
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Paid to</th>
              <th class="col-date">Date</th>
              <th class="col-amount">Amount</th>
            </tr>
          </thead>
          <tbody>${rowsHTML}</tbody>
        </table>

        ${chipsHTML}

        <div class="warn-bar" data-action="openBackup">
          <span class="warn-bar-text">Last backup ${v.backupLocalLastFmt}</span>
          <span class="warn-bar-cta">Manage &#8250;</span>
        </div>
      </div>`;
  }

  function buildHome(v) {
    return `<div class="screen">
      ${buildTopbar(v)}
      ${v.isVariantA ? buildHomeVariantA(v) : buildHomeVariantB(v)}
    </div>`;
  }

  function buildAdd(v) {
    const dropdownHTML = v.partyDropdownOpen ? `
      <div class="autocomplete-dropdown">
        ${v.partySuggestions.map((p, i) => `
          <div class="autocomplete-item" data-action="selectSuggestion" data-index="${i}">
            <div class="autocomplete-name">${escapeHTML(p.name)}</div>
            <div class="autocomplete-hint">${escapeHTML(p.hint)}</div>
          </div>`).join('')}
        ${v.showCreateParty ? `
          <div class="autocomplete-create" data-action="createPartyFromInput">+ Add "${escapeHTML(v.form.party)}" as new party</div>` : ''}
      </div>` : '';

    return `<div class="screen-flex">
      <div class="header-row">
        <button class="back-btn" data-action="closeAdd">&#8249;</button>
        <span class="screen-title">Add Bill</span>
      </div>

      <div class="type-toggle segmented-full">
        <button class="seg-btn ${v.typePaidActive ? 'is-active' : ''}" data-action="setTypePaid">Paid to</button>
        <button class="seg-btn ${v.typeReceivedActive ? 'is-active' : ''}" data-action="setTypeReceived">Received from</button>
      </div>

      <div class="party-field">
        <input type="text" id="party-input" class="text-input" placeholder="${escapeHTML(v.partyPlaceholder)}" value="${escapeHTML(v.form.party)}" data-action="onPartyChange" data-focus-action="onPartyFocus" autocomplete="off">
        ${dropdownHTML}
      </div>

      <div class="form-row-2col">
        <input type="date" class="text-input" value="${escapeHTML(v.form.date)}" data-action="onDateChange">
        <select class="text-input" data-action="onCategoryChange">
          <option value="Bills &amp; Utilities" ${v.form.category === 'Bills & Utilities' ? 'selected' : ''}>Bills &amp; Utilities</option>
          <option value="Rent" ${v.form.category === 'Rent' ? 'selected' : ''}>Rent</option>
          <option value="Salary/Income" ${v.form.category === 'Salary/Income' ? 'selected' : ''}>Salary/Income</option>
        </select>
      </div>

      <div class="amount-section">
        <div class="amount-card">
          <div class="amount-label">Amount</div>
          <div class="amount-value">&#8377;${v.calc.display}</div>
        </div>
      </div>

      <div class="keypad">
        <button class="key-btn key-clear" data-action="calc.clear">C</button>
        <button class="key-btn key-backspace" data-action="calc.backspace">&#9003;</button>
        <button class="key-btn key-op" data-action="calc.pressDiv">&#247;</button>
        <button class="key-btn key-op" data-action="calc.pressMul">&#215;</button>

        <button class="key-btn" data-action="calc.press7">7</button>
        <button class="key-btn" data-action="calc.press8">8</button>
        <button class="key-btn" data-action="calc.press9">9</button>
        <button class="key-btn key-op" data-action="calc.pressMinus">&#8722;</button>

        <button class="key-btn" data-action="calc.press4">4</button>
        <button class="key-btn" data-action="calc.press5">5</button>
        <button class="key-btn" data-action="calc.press6">6</button>
        <button class="key-btn key-op" data-action="calc.pressPlus">+</button>

        <button class="key-btn" data-action="calc.press1">1</button>
        <button class="key-btn" data-action="calc.press2">2</button>
        <button class="key-btn" data-action="calc.press3">3</button>
        <button class="key-btn key-equals" data-action="calc.pressEquals">=</button>

        <button class="key-btn key-zero" data-action="calc.press0">0</button>
        <button class="key-btn" data-action="calc.pressDot">.</button>
      </div>

      <div class="save-section">
        <button class="btn btn-primary btn-save" data-action="saveBill" ${v.saveDisabled ? 'disabled' : ''}>Save Bill</button>
      </div>
    </div>`;
  }

  function buildBackup(v) {
    return `<div class="screen">
      <div class="header-row">
        <button class="back-btn" data-action="closeBackup">&#8249;</button>
        <span class="screen-title">Backup &amp; Restore</span>
      </div>

      <div class="backup-content">
        <div class="card">
          <div class="local-card-head">
            <span class="local-card-title">Local Storage</span>
            <button class="toggle-switch ${v.autoBackupOn ? 'is-on' : ''}" data-action="toggleAutoBackup"><span class="toggle-thumb"></span></button>
          </div>
          <div class="explainer">Keep a copy of every bill and party in this browser, on this device.</div>
          <div class="meta-line">Auto backup: ${v.autoBackupOn ? 'On' : 'Off'}</div>
          <div class="meta-line">Last backup: ${v.backupLocalLastFmt}</div>
          <div class="backup-actions">
            <button class="btn btn-primary btn-flex" data-action="backupNowLocal">Backup now</button>
            <button class="btn btn-flex" data-action="restoreLocal">Restore</button>
          </div>
        </div>

        <div class="card">
          <div class="file-card-title">Backup file</div>
          <div class="explainer">Download all bills and parties as a file you can keep anywhere.</div>
          <div class="backup-actions">
            <button class="btn btn-primary btn-flex" data-action="downloadBackup">Download backup</button>
            <button class="btn btn-flex" data-action="restoreFromFile">Restore from file</button>
          </div>
        </div>

        ${v.flashMsg ? `<div class="flash-msg">${escapeHTML(v.flashMsg)}</div>` : ''}

        <div class="backup-footnote">Backups include all bills, parties and categories. Restoring replaces the data currently on this device.</div>
      </div>
    </div>`;
  }

  function buildBills(v) {
    const listHTML = v.filteredBills.length
      ? v.filteredBills.map((b) => buildBillRow(b, true)).join('')
      : `<div class="empty-note">No bills match these filters.</div>`;

    const partyOptions = v.parties.map((p) => `
      <option value="${escapeHTML(p.name)}" ${v.billsFilter.party === p.name ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('');

    return `<div class="screen">
      <div class="header-row-tight">
        <span class="screen-title">All Bills</span>
      </div>

      <div class="filters-row">
        <select class="filter-input" data-action="onFilterPartyChange">
          <option value="" ${v.billsFilter.party === '' ? 'selected' : ''}>All parties</option>
          ${partyOptions}
        </select>
        <input type="date" class="filter-input" value="${escapeHTML(v.billsFilter.date)}" data-action="onFilterDateChange">
      </div>

      <div class="filters-actions">
        ${v.hasFilters ? `<button class="clear-filters" data-action="clearFilters">Clear filters</button>` : `<span class="filters-actions-spacer"></span>`}
        <button class="btn btn-primary" data-action="openPrint" ${v.printDisabled ? 'disabled' : ''}>Print Bill</button>
      </div>

      <div class="bills-list">${listHTML}</div>
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
          <button class="party-delete-btn" data-action="removeParty" data-index="${i}" title="Delete party">&times;</button>
        </div>`).join('')
      : `<div class="empty-note">No parties yet.</div>`;

    return `<div class="screen">
      <div class="header-row-tight">
        <span class="screen-title">Parties</span>
      </div>
      <div class="parties-list">${listHTML}</div>
      <div class="add-party-section">
        <div class="add-party-label">Add Party</div>
        <div class="add-party-row">
          <input type="text" id="new-party-input" class="text-input" placeholder="Party name" value="${escapeHTML(v.newPartyName)}" data-action="onNewPartyChange">
          <button class="btn btn-primary" data-action="addParty" ${v.addPartyDisabled ? 'disabled' : ''}>Add</button>
        </div>
      </div>
    </div>`;
  }

  function buildPrintCombined(v) {
    const rowsHTML = v.printBills.map((b) => `
      <tr>
        <td>${b.no}</td>
        <td>${b.dateFmt}</td>
        <td>${escapeHTML(b.party)}</td>
        <td>${escapeHTML(b.category)}</td>
        <td class="col-amount">${b.signedAmountFmt}</td>
      </tr>`).join('');

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
              <th>Category</th>
              <th class="col-amount">Amount</th>
            </tr>
          </thead>
          <tbody>${rowsHTML}</tbody>
        </table>
        <div class="print-totals">
          <div>Total Paid: <b>&#8377;${v.printTotals.payableFmt}</b></div>
          <div>Total Received: <b>&#8377;${v.printTotals.receivedFmt}</b></div>
          <div>Net: <b>&#8377;${v.printTotals.netFmt}</b></div>
        </div>
        <div class="signature-row">
          <span>Manager</span>
          <span>Accountant</span>
          <span>Receiver's Signature</span>
        </div>
      </div>`;
  }

  function buildPrintPerParty(v) {
    return v.printGroups.map((g) => {
      const rowsHTML = g.bills.map((b) => `
        <tr>
          <td>${b.no}</td>
          <td>${b.dateFmt}</td>
          <td>${escapeHTML(b.category)}</td>
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
                <th>Category</th>
                <th class="col-amount">Amount</th>
              </tr>
            </thead>
            <tbody>${rowsHTML}</tbody>
          </table>
          <div class="print-totals-single">
            <div>Total: <b>&#8377;${g.totalFmt}</b></div>
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
        <button class="back-btn" data-action="closePrint">&#8249;</button>
        <span class="screen-title">Print Preview</span>
        <button class="btn btn-primary" data-action="doPrint">Print</button>
      </div>
      <div class="print-mode-toggle segmented-full no-print">
        <button class="seg-btn ${v.printModeCombined ? 'is-active' : ''}" data-action="setPrintCombined">All together</button>
        <button class="seg-btn ${v.printModePerParty ? 'is-active' : ''}" data-action="setPrintPerParty">Separate bill per party</button>
      </div>
      ${v.printModeCombined ? buildPrintCombined(v) : buildPrintPerParty(v)}
    </div>`;
  }

  function buildFab(v) {
    return v.isHome ? `<button class="fab" data-action="openAdd">+</button>` : '';
  }

  function buildNav(v) {
    if (!v.isTabScreen) return '';
    return `
      <div class="bottom-nav">
        <button class="nav-item ${v.navHomeActive ? 'is-active' : ''}" data-action="goHome">Home<div class="nav-dot"></div></button>
        <button class="nav-item ${v.navBillsActive ? 'is-active' : ''}" data-action="goBills">Bills<div class="nav-dot"></div></button>
        <button class="nav-item ${v.navPartiesActive ? 'is-active' : ''}" data-action="goParties">Parties<div class="nav-dot"></div></button>
        <button class="nav-item ${v.navMoreActive ? 'is-active' : ''}" data-action="goBackup">More<div class="nav-dot"></div></button>
      </div>`;
  }

  // ===================== Render =====================

  const root = document.getElementById('app-root');
  let currentVals = null;
  // Guards the focusin listener while render() programmatically restores
  // focus below — without this, restoring focus fires a 'focusin' event,
  // which calls the field's onFocus handler, which calls setState(), which
  // calls render() again, which restores focus again: infinite recursion.
  let restoringFocus = false;

  function render() {
    // Save focus + caret so the party / new-party text inputs don't lose
    // keyboard focus on every keystroke (innerHTML replace destroys nodes).
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
      else if (v.isAdd) screenHTML = buildAdd(v);
      else if (v.isBackup) screenHTML = buildBackup(v);
      else if (v.isBills) screenHTML = buildBills(v);
      else if (v.isParties) screenHTML = buildParties(v);
      html = screenHTML + buildFab(v) + buildNav(v);
    }
    root.innerHTML = html;

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
    if (name.indexOf('.') !== -1) {
      const [group, method] = name.split('.');
      return currentVals[group] && currentVals[group][method];
    }
    return currentVals[name];
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'selectSuggestion') {
      const i = Number(el.dataset.index);
      if (currentVals.partySuggestions[i]) currentVals.partySuggestions[i].select();
      return;
    }
    if (action === 'removeParty') {
      const i = Number(el.dataset.index);
      if (currentVals.partiesList[i]) currentVals.partiesList[i].remove();
      return;
    }
    if (action === 'deleteBill') {
      const no = Number(el.dataset.no);
      if (typeof currentVals.deleteBill === 'function') currentVals.deleteBill(no);
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
    const isSelect = el.tagName === 'SELECT';
    if (isDate || isSelect) {
      const fn = resolveAction(el.dataset.action);
      if (typeof fn === 'function') fn(e);
    }
  });

  // 'focus' does not bubble — use 'focusin' for delegation.
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
          setState({ flashMsg: 'That file is not a valid backup.' });
          return;
        }
        if (!parsed || !Array.isArray(parsed.bills) || !Array.isArray(parsed.parties)) {
          setState({ flashMsg: 'That file is not a valid backup.' });
          return;
        }
        if (!confirm('Restore from this file? This replaces all bills and parties currently on this device.')) return;
        const maxNo = parsed.bills.reduce((m, b) => Math.max(m, Number(b.no) || 0), 0);
        setState({
          bills: parsed.bills,
          parties: parsed.parties,
          nextNo: typeof parsed.nextNo === 'number' ? parsed.nextNo : maxNo + 1,
          flashMsg: 'Restored from file.'
        });
      };
      reader.readAsText(file);
    });
  }

  // ===================== Boot =====================

  render();
})();
