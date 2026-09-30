/** Tray variants keep the app's vector mark and the board's status colours. */
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
export function prepareTray(here, hub) {
  const vector = readFileSync(path.join(hub, 'public/favicon.svg'), 'utf8');
  const css = readFileSync(path.join(hub, 'ui/style.css'), 'utf8');
  const colors = {neutral: '#b3b9ff', ...Object.fromEntries(['ok', 'warn', 'crit'].map(level => [level, css.match(new RegExp(`--${level}: (#[a-f0-9]+);`))[1]]))};
  const out = path.join(here, 'resources/tray');
  const hash = createHash('sha256').update(vector + JSON.stringify(colors) + readFileSync(new URL(import.meta.url))).digest('hex');
  if (existsSync(path.join(out, 'stamp')) && readFileSync(path.join(out, 'stamp'), 'utf8') === hash) return;
  mkdirSync(out, {recursive: true});
  const work = mkdtempSync(path.join(tmpdir(), 'quotum-tray-'));
  try {
    for (const [level, color] of Object.entries(colors)) for (const partial of [false, true]) {
      const name = `${level}${partial ? '-partial' : ''}`;
      const badge = partial ? '<circle cx="25" cy="8" r="7" fill="#e6e6ef"/><path d="M25 4v4m0 3v1" stroke="#0b0c15" stroke-width="2"/>' : '';
      const svg = path.join(work, `${name}.svg`);
      writeFileSync(svg, vector.replaceAll('#b3b9ff', color).replace('</svg>', `${badge}</svg>`));
      const icons = path.join(work, name);
      execFileSync('npx', ['--yes', '@tauri-apps/cli@2.12.0', 'icon', svg, '-o', icons], {cwd: here, stdio: 'pipe', shell: process.platform === 'win32'});
      copyFileSync(path.join(icons, '32x32.png'), path.join(out, `${name}.png`));
      copyFileSync(path.join(icons, 'icon.ico'), path.join(out, `${name}.ico`));
    }
    writeFileSync(path.join(out, 'stamp'), hash);
  } finally { rmSync(work, {recursive: true, force: true}); }
}
