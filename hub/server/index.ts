// Protect diagnostics before configuration or any other hub module can fail.
process.umask(0o077);
// The pinned Node type declarations do not include this report flag.
(process.report as typeof process.report & {excludeEnv: boolean}).excludeEnv = true;
await import('./main.js');
