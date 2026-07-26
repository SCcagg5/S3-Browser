'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPath = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(rootPath, 'src/public/assets/js/common/sqlite-viewer.js'), 'utf8');

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return this.element._className.split(/\s+/).filter(Boolean); }
  sync(values) { this.element._className = Array.from(new Set(values)).join(' '); }
  add(...names) { this.sync([...this.values(), ...names]); }
  remove(...names) {
    const removed = new Set(names);
    this.sync(this.values().filter(name => !removed.has(name)));
  }
  contains(name) { return this.values().includes(name); }
  toggle(name, force) {
    const present = this.contains(name);
    const next = force === undefined ? !present : Boolean(force);
    if (next && !present) this.add(name);
    if (!next && present) this.remove(name);
    return next;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this._className = '';
    this.classList = new FakeClassList(this);
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.clientHeight = 200;
    this.scrollLeft = 0;
  }
  set className(value) { this._className = String(value || ''); }
  get className() { return this._className; }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node); }
  appendChild(node) {
    if (node == null) return node;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.focused = true; }
  setSelectionRange() {}
  querySelector(selector) {
    const dataFilter = selector.match(/^\[data-filter-column="(\d+)"\]$/);
    if (dataFilter) return this.find(node => node.dataset.filterColumn === dataFilter[1]);
    const classMatch = selector.match(/^\.([A-Za-z0-9_-]+)/);
    if (classMatch) return this.find(node => node.classList.contains(classMatch[1]));
    return null;
  }
  find(predicate) {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
  findAll(predicate, output = []) {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (predicate(child)) output.push(child);
      child.findAll(predicate, output);
    }
    return output;
  }
  set innerHTML(value) { this.textContent = String(value || ''); this.children = []; }
}

class FakeText {
  constructor(value) { this.textContent = String(value); this.parentNode = null; }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const scrollingElement = { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 };
const document = {
  createElement: tag => new FakeElement(tag),
  createTextNode: value => new FakeText(value),
  scrollingElement,
  documentElement: scrollingElement
};

const calls = [];
let pending = null;
const rendered = [];
const BB = {
  api: {
    async createSQLiteSession() {
      return {
        id: 'session-1',
        tables: [
          { name: 'items', type: 'table', columns: [{ name: 'id' }, { name: 'name' }] },
          { name: 'logs', type: 'table', columns: [{ name: 'message' }] }
        ]
      };
    },
    sqliteTable(options) {
      calls.push(options);
      if (calls.length === 1) {
        return Promise.resolve({
          columns: [{ name: 'id' }, { name: 'name' }],
          rows: [{ id: 1, name: 'alpha' }],
          page: 0,
          pageSize: 100,
          totalRows: -1,
          sourceTotalRows: -1,
          totalKnown: false,
          sourceTotalKnown: false,
          hasMore: true
        });
      }
      pending = deferred();
      return pending.promise;
    },
    async deleteSQLiteSession() {}
  },
  tabular: {
    renderTable(options) {
      rendered.push(options);
      const table = new FakeElement('section');
      table.className = 'data-preview bb-data-grid';
      if (options.beforeTable) table.appendChild(options.beforeTable);
      const scroller = new FakeElement('div');
      scroller.className = 'data-table-scroll';
      table.appendChild(scroller);
      return table;
    }
  }
};

const windowObject = {
  BB,
  clearTimeout,
  setTimeout,
  requestAnimationFrame(callback) { callback(); return 1; }
};
windowObject.window = windowObject;

const context = vm.createContext({
  window: windowObject,
  document,
  console,
  AbortController,
  DOMException,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: windowObject.requestAnimationFrame
});
vm.runInContext(source, context, { filename: 'sqlite-viewer.js' });

(async () => {
  const root = await BB.sqliteViewer.render({ key: 'fixture.sqlite', size: 1024, instance: 'main' });
  assert.ok(Number.isNaN(rendered[0].totalRows), 'an unknown SQLite total must not be converted to zero');
  assert.ok(Number.isNaN(rendered[0].sourceTotalRows), 'an unknown source total must stay unknown');
  assert.equal(rendered[0].hasNext, true, 'the next page must remain available when the backend reports more rows');
  assert.ok(rendered[0].queryTools, 'SQLite must use the shared DataGrid filtering tools');
  assert.equal(root.find(node => node.classList.contains('sqlite-query-toolbar')), null, 'SQLite must not render a separate global search bar');
  assert.ok(root.find(node => node.classList.contains('sqlite-table-controls')), 'SQLite tables must use the shared worksheet tab style');

  const scroller = root.querySelector('.data-table-scroll');
  let prevented = false;
  scroller.dispatchEvent({
    type: 'wheel', deltaY: 120, deltaX: 0, deltaMode: 0, ctrlKey: false, shiftKey: false,
    preventDefault() { prevented = true; }
  });
  assert.equal(scrollingElement.scrollTop, 120, 'vertical wheel input over the SQLite table must scroll the page');
  assert.equal(prevented, true);

  rendered[0].onPage(1);
  assert.equal(calls.at(-1).page, 1, 'SQLite pagination must request the selected page');
  pending.resolve({
    columns: [{ name: 'id' }, { name: 'name' }],
    rows: [{ id: 101, name: 'next' }],
    page: 1,
    pageSize: 100,
    totalRows: 101,
    sourceTotalRows: 101,
    totalKnown: true,
    sourceTotalKnown: true,
    hasMore: false
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendered.at(-1).totalRows, 101);
  assert.equal(rendered.at(-1).page, 1);

  assert.match(source, /filters: activeFilters\(\)/);
  assert.match(source, /sortColumn: state\.sortColumn/);
  assert.doesNotMatch(source, /Search the complete table|sqlite-query-toolbar/);

  root.cleanup();
  console.log('SQLite viewer behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
