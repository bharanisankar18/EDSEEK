// Where the Cloudflare Worker lives. Change PROD_API after `npm run deploy:worker`.
const PROD_API = "https://scholarship-hunter.YOUR-SUBDOMAIN.workers.dev";
window.API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://127.0.0.1:8787" : PROD_API;
