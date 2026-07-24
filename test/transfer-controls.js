'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.element.className = Array.from(values).join(' '); }
  add(...names) { const values = this.values(); names.forEach(name => values.add(name)); this.write(values); }
  remove(...names) { const values = this.values(); names.forEach(name => values.delete(name)); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : !!force;
    if (enabled) values.add(name); else values.delete(name);
    this.write(values);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.type = '';
    this._innerHTML = '';
    this.capturedPointers = new Set();
  }
  set innerHTML(value) { this._innerHTML = String(value || ''); }
  get innerHTML() { return this._innerHTML; }
  get firstElementChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.length; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference ? this.children.indexOf(reference) : -1;
    node.parentNode = this;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.get(String(name)) || null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
  querySelector(selector) {
    if (selector.startsWith('#')) return this.find(node => node.id === selector.slice(1));
    if (selector === 'i') return this.find(node => node.tagName === 'I');
    if (selector === '.bb-toast-action-label') return this.find(node => node.classList.contains('bb-toast-action-label'));
    return null;
  }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

function pointerEvent(type, pointerId) {
  return {
    type,
    button: 0,
    pointerId,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {}
  };
}

const body = new FakeElement('body');
const document = {
  body,
  createElement(tagName) { return new FakeElement(tagName); },
  querySelector(selector) { return body.querySelector(selector); }
};
let timerSequence = 0;
const windowObject = {
  BB: {},
  document,
  setTimeout() { return ++timerSequence; },
  clearTimeout() {},
  requestAnimationFrame(callback) { callback(); return ++timerSequence; }
};
windowObject.window = windowObject;

const context = vm.createContext({
  window: windowObject,
  document,
  console,
  Date,
  requestAnimationFrame: windowObject.requestAnimationFrame,
  setTimeout: windowObject.setTimeout,
  clearTimeout: windowObject.clearTimeout
});
const root = path.resolve(__dirname, '..');
vm.runInContext(fs.readFileSync(path.join(root, 'src/public/assets/js/common/ui.js'), 'utf8'), context, {
  filename: 'src/public/assets/js/common/ui.js'
});

let paused = 0;
let canceled = 0;
const group = windowObject.BB.ui.transferGroup('upload');
const controller = group.add({
  id: 'fixture',
  name: 'large.bin',
  status: 'running',
  progress: 0.1,
  onPause: () => { paused += 1; },
  onCancel: () => { canceled += 1; }
});
const item = group.items.get('fixture');
assert.ok(item, 'transfer item should exist');

item.nodes.primaryAction.dispatchEvent(pointerEvent('pointerdown', 17));
controller.update({
  status: 'running',
  progress: 0.2,
  detail: 'Progress changed while the pointer was down',
  onPause: () => { paused += 1; },
  onCancel: () => { canceled += 1; }
});
item.nodes.primaryAction.dispatchEvent(pointerEvent('pointerup', 17));
assert.equal(paused, 1, 'individual pause should survive an in-flight progress render');

item.nodes.secondaryAction.dispatchEvent(pointerEvent('pointerdown', 18));
controller.update({ status: 'preparing', detail: 'Canceling...' });
item.nodes.secondaryAction.dispatchEvent(pointerEvent('pointerup', 18));
assert.equal(canceled, 1, 'individual cancel should survive an in-flight progress render');

const ordering = windowObject.BB.ui.transferGroup('download');
ordering.add({ id: 'finished', name: 'finished.bin', status: 'completed', progress: 1 });
ordering.add({ id: 'waiting', name: 'waiting.bin', status: 'queued' });
ordering.add({ id: 'stopped', name: 'stopped.bin', status: 'paused' });
ordering.add({ id: 'active', name: 'active.bin', status: 'running', progress: 0.4 });
ordering.add({ id: 'failed', name: 'failed.bin', status: 'error' });
const transferList = ordering.element.children[1];
const orderedIds = transferList.children.map(row => {
  for (const [id, transfer] of ordering.items.entries()) {
    if (transfer.nodes.row === row) return id;
  }
  return '';
});
assert.deepEqual(
  orderedIds,
  ['active', 'waiting', 'stopped', 'failed', 'finished'],
  'bandwidth-consuming transfers should remain above queued, paused and completed rows'
);

console.log('transfer control behavior tests passed');
