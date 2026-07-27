/**
 * Problem report: the only opt-in, user-triggered outbound action anywhere
 * in this extension (docs/ARCHITETTURA.md, "Privacy - non negoziabile"). It
 * only ever runs from an explicit click on the popup's report button - never
 * automatically, never on a timer, never as a side effect of detection.
 *
 * The payload is intentionally minimal: the domain, the detected CMP id (or
 * "none"), and the extension version. Never a full URL, a query string, a
 * page title, or any other identifier. The popup shows this exact text to
 * the user before anything is done with it - buildReportPayload() is the one
 * function that decides what that text is, so the preview and the sent
 * payload can never drift apart.
 */

/** Builds the exact text of a report. Pure - no I/O, so it is fully unit-testable. */
export function buildReportPayload({ domain, cmpId, version }) {
  const safeDomain = typeof domain === 'string' && domain.length > 0 ? domain : 'unknown';
  const safeCmpId = typeof cmpId === 'string' && cmpId.length > 0 ? cmpId : 'none';
  const safeVersion = typeof version === 'string' && version.length > 0 ? version : '0.0.0';

  return `domain: ${safeDomain}\ncmp: ${safeCmpId}\nversion: ${safeVersion}`;
}

// ---------------------------------------------------------------------------
// TRANSPORT - the ONE place a report is actually sent anywhere. Automated
// delivery is a later, not-yet-decided piece of infrastructure
// (docs/ARCHITETTURA.md); for now "sending" means putting the exact
// previewed text on the clipboard, and the report panel (popup.html) tells
// the user where to paste it: a new issue in the project's GitHub
// repository. Replacing this with a real network call later is confined to
// this one function - nothing else in the popup needs to change.
// ---------------------------------------------------------------------------
export async function sendReport(payloadText) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(payloadText);
      return true;
    } catch {
      /* fall through to the legacy fallback below */
    }
  }

  return legacyCopyToClipboard(payloadText);
}

/** Fallback for contexts where the async Clipboard API is unavailable or denied. */
function legacyCopyToClipboard(payloadText) {
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = payloadText;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}
