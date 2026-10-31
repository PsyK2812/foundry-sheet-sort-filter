/**
 * Sheet Sort & Filter
 * Excel-style sorting and filtering for the dnd5e character sheet's item lists
 * (inventory, features, spells, containers).
 *
 * How it works: dnd5e (6.x) manages each item list with an <item-list-controls> custom element.
 * Its _applyFilters / _applySorting methods run every time the list is drawn or a filter changes.
 * We wrap those methods: dnd5e does its own work first, then we hide extra rows (filters) and
 * reorder rows (sort). Clickable headers and filter dropdowns are injected into the section headers.
 * Nothing is written to the items themselves; the state is kept per user, per actor, per list.
 */

const MODULE_ID = "sheet-sort-filter";
const SKIP_COLUMNS = new Set(["controls", "capacity"]);
const NUMERIC_COLUMNS = new Set(["price", "weight", "quantity", "uses", "charges"]);
const BLANK = "\u0000blank";

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    scope: "client", config: false, type: Object, default: {}
  });
  game.settings.register(MODULE_ID, "rememberState", {
    name: "SSF.Settings.Remember.Name",
    hint: "SSF.Settings.Remember.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });

  const Controls = customElements.get("item-list-controls");
  if ( !Controls ) {
    console.warn(`${MODULE_ID} | <item-list-controls> not found — is this the dnd5e system?`);
    return;
  }
  patchControls(Controls.prototype);

  document.addEventListener("pointerdown", event => {
    if ( Menu.current && !Menu.current.element.contains(event.target)
      && !event.target.closest?.(".ssf-funnel") ) Menu.close();
  }, true);
  document.addEventListener("keydown", event => {
    if ( (event.key === "Escape") && Menu.current ) {
      event.stopPropagation();
      Menu.close();
    }
  }, true);
});

Hooks.on("closeApplicationV2", () => Menu.close());

/**
 * Wrap the dnd5e list-control methods.
 * @param {object} proto  ItemListControlsElement.prototype
 */
function patchControls(proto) {
  const wrap = (name, after, before) => {
    const original = proto[name];
    if ( typeof original !== "function" ) {
      console.warn(`${MODULE_ID} | ItemListControlsElement#${name} missing; that part is disabled.`);
      return;
    }
    proto[name] = function(...args) {
      if ( before ) safe(() => before(this));
      const result = original.apply(this, args);
      if ( after ) safe(() => after(this));
      return result;
    };
  };
  wrap("_applyFilters", el => List.for(el)?.applyFilters());
  wrap("_applySorting", el => List.for(el)?.applySorting());
  wrap("_onClearFilters", null, el => List.for(el)?.clearFilters({ apply: false }));
}

function safe(fn) {
  try { return fn(); } catch(err) { console.error(`${MODULE_ID} |`, err); }
}

const t = (key, data) => data ? game.i18n.format(`SSF.${key}`, data) : game.i18n.localize(`SSF.${key}`);

/* -------------------------------------------- */
/*  Persistent state                            */
/* -------------------------------------------- */

const Store = {
  memory: {},

  get(key) {
    const all = this.remember ? game.settings.get(MODULE_ID, "state") : this.memory;
    return foundry.utils.deepClone(all[key] ?? { sort: null, filters: {} });
  },

  set(key, value) {
    const empty = !value.sort && foundry.utils.isEmpty(value.filters);
    if ( !this.remember ) {
      if ( empty ) delete this.memory[key];
      else this.memory[key] = value;
      return;
    }
    const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "state"));
    if ( empty ) delete all[key];
    else all[key] = value;
    game.settings.set(MODULE_ID, "state", all);
  },

  get remember() {
    return game.settings.get(MODULE_ID, "rememberState");
  }
};

/* -------------------------------------------- */
/*  Cell values                                 */
/* -------------------------------------------- */

/**
 * @typedef {object} CellValue
 * @property {number|string|null} sort  Sort key (null = blank, always sorted last).
 * @property {string} label             Display text for the filter list.
 * @property {string[]} keys            Filter keys (an item is hidden if all of them are unticked).
 */

/** @returns {CellValue} */
function cell(sort, label = (sort ?? "")) {
  if ( (sort === null) || (sort === undefined) || (sort === "") ) return { sort: null, label: t("Blanks"), keys: [BLANK] };
  label = String(label);
  return { sort, label, keys: [label] };
}

function parseNumber(text) {
  if ( text === null || text === undefined ) return null;
  const n = Number(String(text).replace(/[^\d.\-]/g, ""));
  return (String(text).trim() === "") || Number.isNaN(n) ? null : n;
}

function concealed(item) {
  return !game.user.isGM && (item?.system?.identified === false);
}

const fmt = n => n.toLocaleString(game.i18n.lang, { maximumFractionDigits: 2 });

/**
 * Readers for each column. Each receives (row, item) and returns a CellValue.
 * Columns without a reader fall back to the text shown in the cell.
 */
const READERS = {
  name: (row, item) => cell(item?.name ?? row.dataset.itemName ?? null),

  type: row => {
    const text = row.querySelector(".item-name .subtitle")?.textContent ?? "";
    return cell(text.split("•")[0].trim() || null);
  },

  rarity: (row, item) => {
    const raw = item?.system?.rarities;
    let keys = raw ? Array.from(raw).filter(r => r) : (item?.system?.rarity ? [item.system.rarity] : []);
    if ( concealed(item) ) keys = [];
    if ( !keys.length ) return cell(null);
    const order = Object.keys(CONFIG.DND5E.itemRarity);
    const labels = keys.map(k => CONFIG.DND5E.itemRarity[k] ?? k);
    const rank = Math.min(...keys.map(k => order.indexOf(k)).filter(i => i >= 0));
    return { sort: Number.isFinite(rank) ? rank : labels[0], label: labels.join(" / "), keys: labels };
  },

  price: (row, item) => {
    const price = item?.system?.price;
    if ( !price?.value || concealed(item) ) return cell(null);
    const conversion = CONFIG.DND5E.currencies[price.denomination]?.conversion || 1;
    const gp = price.value / conversion;
    const abbr = CONFIG.DND5E.currencies[price.denomination]?.abbreviation ?? price.denomination;
    return cell(gp, `${fmt(price.value)} ${abbr}`);
  },

  weight: (row, item) => {
    let w = item?.system?.totalWeight;
    if ( w instanceof Promise || typeof w !== "number" ) {
      w = parseNumber(row.querySelector('[data-column-id="weight"]')?.textContent);
    }
    if ( !w ) return cell(null);
    w = Math.round(w * 10) / 10;
    return cell(w, fmt(w));
  },

  quantity: (row, item) => {
    const q = item?.system?.quantity;
    if ( typeof q !== "number" ) return cell(null);
    return cell(q, fmt(q));
  },

  uses: row => usesReader(row, "uses"),
  charges: row => usesReader(row, "charges")
};

function usesReader(row, id) {
  const el = row.querySelector(`.item-row > [data-column-id="${id}"]`);
  if ( !el || el.classList.contains("empty") ) return cell(null);
  const valueEl = el.querySelector(".value, input");
  if ( !valueEl ) {
    // Recharge icon instead of a counter.
    const label = el.getAttribute("aria-label") || el.dataset.tooltipText || "";
    return label ? { sort: -1, label, keys: [label] } : cell(null);
  }
  const value = parseNumber(valueEl.value ?? valueEl.textContent) ?? 0;
  const max = parseNumber(el.querySelector(".max")?.textContent);
  return cell(value, max === null ? fmt(value) : `${fmt(value)} / ${fmt(max)}`);
}

function domReader(row, id) {
  const el = row.querySelector(`.item-row > [data-column-id="${id}"]`);
  if ( !el || el.classList.contains("empty") ) return cell(null);
  let text = el.textContent.replace(/\s+/g, " ").trim();
  if ( !text ) text = el.getAttribute("aria-label") || el.querySelector("[aria-label]")?.getAttribute("aria-label") || "";
  if ( !text ) return cell(null);
  const n = parseNumber(text);
  return cell(/^[\s\d.,+\-]+$/.test(text) && n !== null ? n : text.toLocaleLowerCase(), text);
}

/* -------------------------------------------- */
/*  A managed list                              */
/* -------------------------------------------- */

class List {
  /** @type {WeakMap<HTMLElement, List>} */
  static #instances = new WeakMap();

  /**
   * Get the controller for an <item-list-controls> element, or null if it isn't an item list.
   * @param {HTMLElement} controls
   * @returns {List|null}
   */
  static for(controls) {
    if ( (controls.getAttribute("collection") ?? "items") !== "items" ) return null;
    if ( !controls.list || !controls.app ) return null;
    let list = this.#instances.get(controls);
    if ( !list ) {
      list = new List(controls);
      this.#instances.set(controls, list);
    }
    return list;
  }

  constructor(controls) {
    this.controls = controls;
  }

  get app() { return this.controls.app; }

  get root() { return this.controls.list; }

  get key() {
    const doc = this.app.inventorySource ?? this.app.document;
    return `${doc?.uuid}::${this.controls.getAttribute("for")}`;
  }

  get state() { return Store.get(this.key); }

  set state(value) { Store.set(this.key, value); }

  /** All item rows in the list. */
  get rows() {
    return Array.from(this.root.querySelectorAll(".item-list > li.item"));
  }

  #itemCache = new Map();

  getItem(row) {
    const uuid = row.dataset.uuid;
    if ( !uuid ) return null;
    if ( !this.#itemCache.has(uuid) ) this.#itemCache.set(uuid, safe(() => fromUuidSync(uuid)) ?? null);
    return this.#itemCache.get(uuid);
  }

  /** @returns {CellValue} */
  read(row, column) {
    const reader = READERS[column];
    return (reader ? safe(() => reader(row, this.getItem(row))) : null) ?? domReader(row, column);
  }

  /* -------------------------------------------- */

  /**
   * Does a row pass all of our filters (optionally ignoring one column)?
   */
  passes(row, filters, except) {
    for ( const [column, f] of Object.entries(filters) ) {
      if ( column === except ) continue;
      if ( column === "name" && f.text ) {
        const name = (this.getItem(row)?.name ?? row.dataset.itemName ?? "").toLocaleLowerCase(game.i18n.lang);
        if ( !name.includes(f.text.toLocaleLowerCase(game.i18n.lang)) ) return false;
      }
      const value = this.read(row, column);
      if ( f.excluded?.length && value.keys.every(k => f.excluded.includes(k)) ) return false;
      if ( (f.min ?? null) !== null || (f.max ?? null) !== null ) {
        if ( typeof value.sort !== "number" ) return false;
        if ( (f.min ?? null) !== null && value.sort < f.min ) return false;
        if ( (f.max ?? null) !== null && value.sort > f.max ) return false;
      }
    }
    return true;
  }

  applyFilters() {
    this.#itemCache.clear();
    // The sheet re-rendered while a menu was open: point the menu at the new list.
    if ( Menu.current && (Menu.current.list !== this) && (Menu.current.list.key === this.key)
      && !Menu.current.list.controls.isConnected ) Menu.current.list = this;
    this.injectHeaders();
    const { filters } = this.state;
    const active = !foundry.utils.isEmpty(filters);
    for ( const row of this.rows ) {
      row.dataset.ssfBase = row.hidden ? "0" : "1";
      if ( active && !row.hidden && !this.passes(row, filters) ) row.hidden = true;
    }
    if ( active && !this.controls.keepEmpty ) {
      for ( const section of this.root.querySelectorAll(".items-section") ) {
        if ( !section.querySelector(".item-list > li.item:not([hidden])") ) section.hidden = true;
      }
    }
    const { name, properties } = this.controls.state ?? {};
    this.controls._controls?.clear?.classList.toggle("active", Boolean(active || properties?.size || name));
    this.updateHeaders();
  }

  applySorting() {
    this.#itemCache.clear();
    this.injectHeaders();
    const { sort } = this.state;
    if ( sort?.column ) {
      const dir = sort.dir === "desc" ? -1 : 1;
      const collator = new Intl.Collator(game.i18n.lang, { numeric: true, sensitivity: "base" });
      for ( const ol of this.root.querySelectorAll(".item-list") ) {
        const rows = Array.from(ol.querySelectorAll(":scope > li.item"));
        const keyed = rows.map((row, index) => ({ row, index, value: this.read(row, sort.column).sort }));
        keyed.sort((a, b) => {
          const av = a.value, bv = b.value;
          if ( av === null && bv === null ) return a.index - b.index;
          if ( av === null ) return 1;   // blanks always last
          if ( bv === null ) return -1;
          let c;
          if ( typeof av === "number" && typeof bv === "number" ) c = av - bv;
          else c = collator.compare(String(av), String(bv));
          return (c * dir) || (a.index - b.index);
        });
        for ( const { row } of keyed ) ol.append(row);
      }
    }
    this.updateHeaders();
  }

  /** Re-run dnd5e's filtering + sorting, which also runs ours. */
  refresh() {
    this.controls._applyFilters();
    this.controls._applySorting();
  }

  /* -------------------------------------------- */

  setSort(column, dir) {
    const state = this.state;
    state.sort = dir ? { column, dir } : null;
    this.state = state;
    this.controls._applySorting(); // dnd5e restores its own order, then ours is applied on top
  }

  cycleSort(column) {
    const { sort } = this.state;
    let dir = "asc";
    if ( sort?.column === column ) dir = sort.dir === "asc" ? "desc" : null;
    this.setSort(column, dir);
  }

  setFilter(column, filter) {
    const state = this.state;
    const empty = !filter || (!filter.excluded?.length && !filter.text
      && (filter.min ?? null) === null && (filter.max ?? null) === null);
    if ( empty ) delete state.filters[column];
    else state.filters[column] = filter;
    this.state = state;
    this.controls._applyFilters();
  }

  clearFilters({ apply=true }={}) {
    const state = this.state;
    state.filters = {};
    this.state = state;
    if ( apply ) this.controls._applyFilters();
  }

  /* -------------------------------------------- */
  /*  Header UI                                   */
  /* -------------------------------------------- */

  injectHeaders() {
    for ( const header of this.root.querySelectorAll(".items-header") ) {
      if ( header.dataset.ssf ) continue;
      header.dataset.ssf = "1";

      // Name column (the section title cell).
      const title = header.querySelector(".item-name");
      if ( title ) this.#decorate(title, "name", { clickToSort: false });

      for ( const col of header.querySelectorAll("[data-column-id]") ) {
        const id = col.dataset.columnId;
        if ( SKIP_COLUMNS.has(id) ) continue;
        this.#decorate(col, id, { clickToSort: true });
      }
    }
  }

  #decorate(el, column, { clickToSort }) {
    el.classList.add("ssf-header");
    el.dataset.ssfColumn = column;
    const tools = document.createElement("span");
    tools.className = "ssf-tools";
    tools.innerHTML = `
      <i class="ssf-arrow fa-solid" inert></i>
      <button type="button" class="ssf-funnel unbutton always-interactive" data-tooltip="${t("OpenMenu")}"
              aria-label="${t("OpenMenu")}"><i class="fa-solid fa-caret-down" inert></i></button>`;
    el.append(tools);

    const funnel = tools.querySelector(".ssf-funnel");
    funnel.addEventListener("pointerdown", event => event.stopPropagation());
    funnel.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if ( Menu.current?.anchor === funnel ) return Menu.close();
      new Menu(this, column, funnel).open();
    });

    if ( clickToSort ) {
      el.classList.add("ssf-sortable");
      el.dataset.tooltip = t("ClickToSort");
      el.addEventListener("click", event => {
        if ( event.target.closest(".ssf-funnel") ) return;
        event.preventDefault();
        event.stopPropagation();
        this.cycleSort(column);
      });
    }
  }

  updateHeaders() {
    const { sort, filters } = this.state;
    for ( const el of this.root.querySelectorAll(".ssf-header") ) {
      const column = el.dataset.ssfColumn;
      const sorted = sort?.column === column;
      const filtered = column === "name"
        ? ["name", "type", "rarity"].some(c => filters[c])
        : Boolean(filters[column]);
      el.classList.toggle("ssf-sorted", sorted);
      el.classList.toggle("ssf-filtered", filtered);
      const arrow = el.querySelector(".ssf-arrow");
      if ( arrow ) {
        arrow.classList.toggle("fa-arrow-up-short-wide", sorted && sort.dir === "asc");
        arrow.classList.toggle("fa-arrow-down-wide-short", sorted && sort.dir === "desc");
      }
      const icon = el.querySelector(".ssf-funnel > i");
      if ( icon ) {
        icon.classList.toggle("fa-filter", filtered);
        icon.classList.toggle("fa-caret-down", !filtered);
      }
    }
    Menu.current?.list === this && Menu.current.syncSort();
  }

  /**
   * Distinct values of a column among rows that dnd5e shows and that pass our other filters.
   * @returns {{key: string, label: string, sort: any, count: number}[]}
   */
  distinctValues(column) {
    const { filters } = this.state;
    const map = new Map();
    for ( const row of this.rows ) {
      if ( row.dataset.ssfBase === "0" ) continue;
      if ( !this.passes(row, filters, column) ) continue;
      const value = this.read(row, column);
      value.keys.forEach((key, i) => {
        const label = key === BLANK ? value.label : (value.keys.length > 1 ? key : value.label);
        const entry = map.get(key) ?? { key, label, sort: value.keys.length > 1 ? key : value.sort, count: 0 };
        entry.count++;
        map.set(key, entry);
      });
    }
    // Keep ticked-off values visible so they can be ticked back on.
    for ( const key of filters[column]?.excluded ?? [] ) {
      if ( !map.has(key) ) map.set(key, { key, label: key === BLANK ? t("Blanks") : key, sort: key, count: 0 });
    }
    const collator = new Intl.Collator(game.i18n.lang, { numeric: true, sensitivity: "base" });
    return Array.from(map.values()).sort((a, b) => {
      if ( a.key === BLANK ) return 1;
      if ( b.key === BLANK ) return -1;
      if ( typeof a.sort === "number" && typeof b.sort === "number" ) return a.sort - b.sort;
      return collator.compare(String(a.label), String(b.label));
    });
  }

  isNumeric(column) {
    if ( NUMERIC_COLUMNS.has(column) ) return true;
    if ( READERS[column] ) return false;
    const values = this.rows.map(r => this.read(r, column).sort).filter(v => v !== null);
    return values.length > 0 && values.every(v => typeof v === "number");
  }
}

/* -------------------------------------------- */
/*  Dropdown menu                               */
/* -------------------------------------------- */

class Menu {
  /** @type {Menu|null} */
  static current = null;

  static close() {
    Menu.current?.element.remove();
    Menu.current = null;
  }

  constructor(list, column, anchor) {
    this.list = list;
    this.column = column;
    this.anchor = anchor;
  }

  /** Columns edited by this menu: the name header also covers type and rarity. */
  get columns() {
    return this.column === "name" ? ["name", "type", "rarity"] : [this.column];
  }

  open() {
    Menu.close();
    Menu.current = this;
    const el = this.element = document.createElement("div");
    const theme = this.list.app.element.closest(".theme-light, .theme-dark")
      ?? document.body;
    el.className = `ssf-menu ${theme.classList.contains("theme-light") ? "ssf-light" : "ssf-dark"}`;
    el.addEventListener("pointerdown", event => event.stopPropagation());
    el.addEventListener("click", event => event.stopPropagation());
    this.render();
    document.body.append(el);
    this.position();
  }

  position() {
    const r = this.anchor.getBoundingClientRect();
    const el = this.element;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = (r.left + w <= window.innerWidth - 8) ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if ( top + h > window.innerHeight - 8 ) top = Math.max(8, r.top - h - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  render() {
    const el = this.element;
    el.replaceChildren();
    const sortColumn = this.column;
    const numeric = this.list.isNumeric(sortColumn);

    // Sorting
    const sortBox = document.createElement("div");
    sortBox.className = "ssf-sort";
    sortBox.innerHTML = `
      <button type="button" data-dir="asc"><i class="fa-solid fa-arrow-up-short-wide"></i>
        ${numeric ? t("SortSmallLarge") : t("SortAZ")}</button>
      <button type="button" data-dir="desc"><i class="fa-solid fa-arrow-down-wide-short"></i>
        ${numeric ? t("SortLargeSmall") : t("SortZA")}</button>`;
    sortBox.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      const { sort } = this.list.state;
      const same = sort?.column === sortColumn && sort.dir === b.dataset.dir;
      this.list.setSort(sortColumn, same ? null : b.dataset.dir);
    }));
    el.append(sortBox);

    if ( this.column === "name" ) {
      el.append(this.#textFilter());
      for ( const column of ["type", "rarity"] ) {
        const values = this.list.distinctValues(column);
        if ( values.length < 2 && !this.list.state.filters[column] ) continue;
        el.append(this.#valueList(column, values, t(column === "type" ? "Type" : "Rarity"), { sortable: true }));
      }
    } else {
      if ( numeric ) el.append(this.#rangeFilter());
      el.append(this.#valueList(this.column, this.list.distinctValues(this.column)));
    }

    // Footer
    const footer = document.createElement("div");
    footer.className = "ssf-footer";
    footer.innerHTML = `
      <button type="button" data-action="clear-column"><i class="fa-solid fa-filter-circle-xmark"></i> ${t("ClearColumn")}</button>
      <button type="button" data-action="clear-all"><i class="fa-solid fa-xmark"></i> ${t("ClearAll")}</button>`;
    footer.querySelector('[data-action="clear-column"]').addEventListener("click", () => {
      for ( const c of this.columns ) this.list.setFilter(c, null);
      this.render();
    });
    footer.querySelector('[data-action="clear-all"]').addEventListener("click", () => {
      this.list.clearFilters();
      if ( this.list.state.sort ) this.list.setSort(null, null);
      this.render();
    });
    el.append(footer);
    this.syncSort();
  }

  syncSort() {
    const { sort } = this.list.state;
    this.element?.querySelectorAll(".ssf-sort button").forEach(b => {
      b.classList.toggle("active", sort?.column === this.column && sort.dir === b.dataset.dir);
    });
    this.element?.querySelectorAll(".ssf-mini-sort").forEach(b => {
      const active = sort?.column === b.dataset.column;
      b.classList.toggle("active", active);
      b.querySelector("i").className = `fa-solid ${active && sort.dir === "desc"
        ? "fa-arrow-down-wide-short" : "fa-arrow-up-short-wide"}`;
    });
  }

  #textFilter() {
    const box = document.createElement("label");
    box.className = "ssf-text";
    const current = this.list.state.filters.name?.text ?? "";
    box.innerHTML = `<span>${t("NameContains")}</span><input type="search" value="${foundry.utils.escapeHTML?.(current) ?? current}">`;
    const input = box.querySelector("input");
    const apply = foundry.utils.debounce(() => {
      const f = foundry.utils.deepClone(this.list.state.filters.name ?? {});
      f.text = input.value.trim();
      this.list.setFilter("name", f);
      this.#refreshLists();
    }, 200);
    input.addEventListener("input", apply);
    setTimeout(() => input.focus(), 0);
    return box;
  }

  #rangeFilter() {
    const box = document.createElement("div");
    box.className = "ssf-range";
    const f = this.list.state.filters[this.column] ?? {};
    const unit = this.column === "price" ? ` (${CONFIG.DND5E.currencies.gp?.abbreviation ?? "gp"})` : "";
    box.innerHTML = `
      <span>${t("Between")}${unit}</span>
      <input type="number" step="any" data-bound="min" placeholder="${t("Min")}" value="${f.min ?? ""}">
      <span>–</span>
      <input type="number" step="any" data-bound="max" placeholder="${t("Max")}" value="${f.max ?? ""}">`;
    const apply = foundry.utils.debounce(() => {
      const next = foundry.utils.deepClone(this.list.state.filters[this.column] ?? {});
      for ( const input of box.querySelectorAll("input") ) {
        const v = input.value === "" ? null : Number(input.value);
        next[input.dataset.bound] = Number.isFinite(v) ? v : null;
      }
      this.list.setFilter(this.column, next);
      this.#refreshLists();
    }, 300);
    box.querySelectorAll("input").forEach(i => i.addEventListener("input", apply));
    return box;
  }

  #valueList(column, values, heading, { sortable=false }={}) {
    const box = document.createElement("div");
    box.className = "ssf-values";
    box.dataset.column = column;
    if ( heading ) {
      const h = document.createElement("div");
      h.className = "ssf-heading";
      h.innerHTML = `<span>${heading}</span>`;
      if ( sortable ) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ssf-mini-sort";
        b.dataset.column = column;
        b.dataset.tooltip = t("ClickToSort");
        b.innerHTML = '<i class="fa-solid fa-arrow-up-short-wide"></i>';
        b.addEventListener("click", () => this.list.cycleSort(column));
        h.append(b);
      }
      box.append(h);
    }

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = t("Search");
    if ( values.length > 8 ) box.append(search);

    const ul = document.createElement("ul");
    ul.className = "ssf-list";
    box.append(ul);
    this.#fillList(ul, column, values);

    search.addEventListener("input", () => {
      const q = search.value.toLocaleLowerCase(game.i18n.lang);
      ul.querySelectorAll("li[data-key]").forEach(li => {
        li.hidden = q && !li.dataset.label.toLocaleLowerCase(game.i18n.lang).includes(q);
      });
    });
    return box;
  }

  #fillList(ul, column, values) {
    const excluded = new Set(this.list.state.filters[column]?.excluded ?? []);
    ul.replaceChildren();
    const all = document.createElement("li");
    all.className = "ssf-all";
    const allChecked = values.every(v => !excluded.has(v.key));
    const someChecked = values.some(v => !excluded.has(v.key));
    all.innerHTML = `<label><input type="checkbox" ${allChecked ? "checked" : ""}> ${t("SelectAll")}</label>`;
    all.querySelector("input").indeterminate = !allChecked && someChecked;
    ul.append(all);

    for ( const v of values ) {
      const li = document.createElement("li");
      li.dataset.key = v.key;
      li.dataset.label = v.label;
      li.innerHTML = `<label><input type="checkbox" ${excluded.has(v.key) ? "" : "checked"}>
        <span class="ssf-label"></span><span class="ssf-count">${v.count || ""}</span></label>`;
      li.querySelector(".ssf-label").textContent = v.label;
      if ( v.key === BLANK ) li.classList.add("ssf-blank");
      ul.append(li);
    }

    ul.addEventListener("change", event => {
      const input = event.target;
      const state = foundry.utils.deepClone(this.list.state.filters[column] ?? {});
      let ex = new Set(state.excluded ?? []);
      if ( input.closest(".ssf-all") ) {
        const visible = Array.from(ul.querySelectorAll("li[data-key]:not([hidden])")).map(li => li.dataset.key);
        for ( const key of visible ) input.checked ? ex.delete(key) : ex.add(key);
      } else {
        const key = input.closest("li").dataset.key;
        input.checked ? ex.delete(key) : ex.add(key);
      }
      state.excluded = Array.from(ex);
      this.list.setFilter(column, state);
      this.#refreshLists(column);
    }, { once: true });
  }

  /** Refresh the checkbox lists (values depend on the other filters), keeping the one being edited stable. */
  #refreshLists(editing) {
    for ( const box of this.element.querySelectorAll(".ssf-values") ) {
      const column = box.dataset.column;
      const ul = box.querySelector(".ssf-list");
      const search = box.querySelector('input[type="search"]');
      const fresh = ul.cloneNode(false);
      ul.replaceWith(fresh);
      let values = this.list.distinctValues(column);
      if ( column === editing ) {
        // Don't drop rows from the list the user is clicking in.
        const keep = new Map(Array.from(ul.querySelectorAll("li[data-key]"))
          .map(li => [li.dataset.key, { key: li.dataset.key, label: li.dataset.label, count: 0 }]));
        for ( const v of values ) keep.set(v.key, v);
        values = Array.from(ul.querySelectorAll("li[data-key]")).map(li => keep.get(li.dataset.key))
          .concat(values.filter(v => !ul.querySelector(`li[data-key="${CSS.escape(v.key)}"]`)));
      }
      this.#fillList(fresh, column, values);
      if ( search?.value ) search.dispatchEvent(new Event("input"));
    }
  }
}

/* Small public API for macros. */
Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if ( mod ) mod.api = {
    /** Forget every saved sort/filter. */
    resetAll: () => game.settings.set(MODULE_ID, "state", {})
  };
});
