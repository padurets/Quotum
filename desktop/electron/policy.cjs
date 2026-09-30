'use strict';
const OWN = 'quotum://localhost';
const commands = new Set(['app_state', 'save_settings', 'save_desktop_settings', 'take_over', 'set_autostart', 'reenter', 'quit', 'open_main', 'close_panel', 'report_panel_height']);
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
function mayInvoke(url, target, command, role = 'main') {
  if (!commands.has(command)) return false;
  if (origin(url) === OWN) return command === 'quit';
  const panel = ['open_main', 'close_panel', 'report_panel_height'];
  if (role === 'compact' && !['app_state', 'reenter', ...panel].includes(command)) return false;
  if (role === 'main' && panel.includes(command)) return false;
  if (!['main', 'compact'].includes(role)) return false;
  return allowed(url, target);
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
