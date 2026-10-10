/**
 * sites.js
 *
 * Which sites are scanned and which are ignored, shared by the service worker (content-script
 * injection, ingest ignore lists). content.js is a classic script and cannot import this module, so
 * it keeps a copy of normalizeDomain / checkIfSiteEnabled / isIgnoredHost with the same semantics;
 * change both together.
 */

/** Feeds scanned unless explicitly disabled in configuration.sites. */
export const DEFAULT_SITE_DOMAINS = Object.freeze([
  'facebook.com', 'linkedin.com', 'x.com', 'instagram.com', 'youtube.com', 'medium.com', 'github.com', 'news.ycombinator.com'
]);

/**
 * Normalizes a host or a stored site / ignore entry: lower-case; strips the scheme, a leading
 * '*.', path/query/fragment, port, trailing dots and 'www.'. twitter.com (and its subdomains) is
 * folded into x.com. '*' is kept as is.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDomain(value) {
  let d = String(value ?? '').trim().toLowerCase();
  if (d === '*') return d;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/^\*\./, '');
  d = d.split(/[/?#]/)[0];
  d = d.replace(/:\d+$/, '').replace(/\.+$/, '');
  d = d.replace(/^www\./, '');
  if (d === 'twitter.com' || d.endsWith('.twitter.com')) d = 'x.com';
  return d;
}

/**
 * True when `host` is `domain` or one of its subdomains (both normalized; '*' never matches here).
 *
 * @param {unknown} host
 * @param {unknown} domain
 * @returns {boolean}
 */
export function hostMatchesDomain(host, domain) {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  return !!h && !!d && d !== '*' && h !== '*' && (h === d || h.endsWith('.' + d));
}

/**
 * Whether content scripts should scan `hostname`. A '*' entry enables every site; otherwise the
 * first exact / subdomain match decides, and the default feeds are enabled unless disabled.
 *
 * @param {string} hostname
 * @param {{ domain: string, isEnabled?: boolean }[]} sites
 * @returns {boolean}
 */
export function checkIfSiteEnabled(hostname, sites) {
  const host = normalizeDomain(hostname);
  const list = Array.isArray(sites) ? sites.filter(s => s && typeof s.domain === 'string') : [];

  if (list.length > 0) {
    const anySite = list.find(s => s.domain === '*');
    if (anySite && anySite.isEnabled) return true;

    const match = list.find(s => s.domain !== '*' && hostMatchesDomain(host, s.domain));
    if (match) return match.isEnabled !== false;
  }

  return DEFAULT_SITE_DOMAINS.some(d => hostMatchesDomain(host, d));
}

/**
 * True when `hostname` is on the ignored-domains list.
 *
 * @param {string} hostname
 * @param {unknown} ignoredDomains
 * @returns {boolean}
 */
export function isIgnoredHost(hostname, ignoredDomains) {
  return (Array.isArray(ignoredDomains) ? ignoredDomains : []).some(d => typeof d === 'string' && hostMatchesDomain(hostname, d));
}
