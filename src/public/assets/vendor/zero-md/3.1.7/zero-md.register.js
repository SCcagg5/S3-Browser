import ZeroMd from './zero-md-3.1.7.js';

if (!customElements.get('zero-md')) {
  customElements.define('zero-md', ZeroMd);
}
