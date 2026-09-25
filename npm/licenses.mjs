/**
 * The licenses of the Rust crates compiled into a program, as one Markdown file: every
 * crate linked into it on any platform it ships for, with the license texts its package
 * carries. The agent's `quotum` and the desktop app use it. Crates that only run while
 * compiling (build scripts, procedural macros) are left out: nothing of them is in a
 * binary; so is Quotum's own code (crates from a path, not a registry). A text several
 * crates share (spacing aside) is printed once and referred to after that.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i;

/**
 * The Markdown for the crates the package `name` of the Cargo workspace in `dir` links on
 * the given targets, under `intro`: what the program is and what else it includes.
 */
export function thirdPartyLicenses(dir, name, targets, intro) {
  const crates = new Map();
  for (const target of targets) {
    const args = ['metadata', '--format-version', '1', '--locked', '--filter-platform', target];
    const metadata = JSON.parse(execFileSync('cargo', args, {cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20}));
    const packages = new Map(metadata.packages.map(p => [p.id, p]));
    const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
    const members = new Set(metadata.workspace_members);
    const root = metadata.packages.find(p => p.name === name && members.has(p.id));
    const queue = [root.id];
    const seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      const pkg = packages.get(id);
      if (pkg.source) crates.set(`${pkg.name} ${pkg.version}`, pkg);
      for (const dep of nodes.get(id).deps) {
        const linked = dep.dep_kinds.some(k => k.kind === null);
        const macro = packages.get(dep.pkg).targets.some(t => t.kind.includes('proc-macro'));
        if (linked && !macro && !seen.has(dep.pkg)) {
          seen.add(dep.pkg);
          queue.push(dep.pkg);
        }
      }
    }
  }

  const printed = new Map();
  const sections = [...crates.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(pkg => {
      const dir = path.dirname(pkg.manifest_path);
      const files = readdirSync(dir).filter(file => LICENSE_FILE.test(file) && statSync(path.join(dir, file)).isFile()).sort();
      const lines = [`## ${pkg.name} ${pkg.version}`, '', `License: ${pkg.license ?? pkg.license_file ?? 'not stated'}${pkg.repository ? `  \n${pkg.repository}` : ''}`];
      if (!files.length) lines.push('', 'Its package carries no license text.');
      for (const file of files) {
        const text = readFileSync(path.join(dir, file), 'utf8').trim();
        const hash = createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex');
        const first = printed.get(hash);
        if (first) {
          lines.push('', `${file}: the same text as ${first}.`);
        } else {
          printed.set(hash, `${file} of ${pkg.name} ${pkg.version}`);
          lines.push('', `${file}:`, '', '```text', text, '```');
        }
      }
      return lines.join('\n');
    });

  return ['# Third-party licenses', '', ...intro, '', ...sections.flatMap(section => [section, ''])].join('\n');
}
