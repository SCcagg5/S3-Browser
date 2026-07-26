/* Compatibility shim required by the embedded Vue/Buefy production bundles. */
window.process = window.process || { env: { NODE_ENV: 'production' } };
