'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TestNode {
  constructor(tagName = '') {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.childNodes = [];
    this.attributes = new Map();
    this._text = '';
  }

  appendChild(node) {
    if (node?.isFragment) {
      node.childNodes.forEach(child => this.appendChild(child));
      return node;
    }
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    nodes.forEach(node => this.appendChild(node));
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.childNodes = [];
  }

  get textContent() {
    return this._text + this.childNodes.map(node => node.textContent || '').join('');
  }
}

const document = {
  createElement(tagName) { return new TestNode(tagName); },
  createDocumentFragment() {
    const fragment = new TestNode();
    fragment.isFragment = true;
    return fragment;
  }
};

const windowObject = { BB: {} };
windowObject.window = windowObject;
const context = vm.createContext({
  window: windowObject,
  document,
  NodeFilter: { SHOW_ELEMENT: 1 },
  DOMParser: class {},
  console
});
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/public/assets/js/common/render.js'), 'utf8');
vm.runInContext(source, context, { filename: 'src/public/assets/js/common/render.js' });

function collect(node, className) {
  const result = [];
  function visit(current) {
    if (String(current?.className || '').split(/\s+/).includes(className)) result.push(current);
    for (const child of current?.childNodes || []) visit(child);
  }
  visit(node);
  return result;
}

const rendered = windowObject.BB.render.renderWrappedJSON('{"name":"alpha","n":12,"ok":true,"none":null}');
assert.equal(collect(rendered, 'wrapped-code-line').map(node => node.textContent).join('\n'), '{"name":"alpha","n":12,"ok":true,"none":null}');
assert.equal(collect(rendered, 'json-token-invalid').length, 0);
assert.equal(collect(rendered, 'json-token-number').map(node => node.textContent).join(''), '12');
assert.equal(collect(rendered, 'json-token-boolean').map(node => node.textContent).join(''), 'true');
assert.equal(collect(rendered, 'json-token-null').map(node => node.textContent).join(''), 'null');
assert.equal(collect(rendered, 'json-token-string').map(node => node.textContent).join(''), '"name""alpha""n""ok""none"');

const continued = windowObject.BB.render.renderWrappedJSON('continued"', { startsInString: true, startLine: 7, continued: true });
assert.equal(collect(continued, 'json-token-invalid').length, 0);
assert.equal(collect(continued, 'json-token-string').map(node => node.textContent).join(''), 'continued"');
assert.equal(collect(continued, 'wrapped-code-line-number')[0].textContent, '7\u21b3');

console.log('JSON syntax coloring tests passed');
