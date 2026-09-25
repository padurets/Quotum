'use strict';
const OWN = 'quotum://localhost';
const commands = new Set(['app_state', 'save_settings', 'take_over', 'set_autostart', 'reenter', 'quit']);
function origin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}
function allowed(url, target) {
  const here = origin(url);
  return here === OWN || (origin(target) !== OWN && here !== null && here === origin(target));
}
function mayInvoke(url, target, command) {
  if (!commands.has(command)) return false;
  return origin(url) === OWN ? command === 'quit' : allowed(url, target);
}
function external(url) {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
function navigation(url, target, isMainFrame) {
  if (allowed(url, target)) return 'allow';
  return isMainFrame && external(url) ? 'external' : 'deny';
}
module.exports = {OWN, origin, allowed, mayInvoke, external, navigation};
