/**
 * The platforms Quotum ships a prebuilt agent for: the npm package of each
 * (`@quotum/<name>`, installed where `os` and `cpu` match) and the Rust target it is
 * built for. npm/quotum/bin/quotum.js lists the same names.
 */
export const PLATFORMS = [
  {name: 'linux-x64', os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl', title: 'Linux x64'},
  {name: 'linux-arm64', os: 'linux', cpu: 'arm64', target: 'aarch64-unknown-linux-musl', title: 'Linux arm64'},
  {name: 'darwin-x64', os: 'darwin', cpu: 'x64', target: 'x86_64-apple-darwin', title: 'macOS (Intel)'},
  {name: 'darwin-arm64', os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin', title: 'macOS (Apple silicon)'},
  {name: 'win32-x64', os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-gnu', title: 'Windows x64', exe: '.exe'},
];
