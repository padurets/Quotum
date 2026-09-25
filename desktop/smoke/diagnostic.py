"""Expose the synthetic smoke failure in the CI check, not just its exit code."""
from pathlib import Path
import sys

root = Path(sys.argv[1])
parts = [sys.argv[2]]
for name in ['output.log', 'app/logs/hub.log', 'app/logs/agent.log']:
    file = root / name
    if file.exists():
        lines = file.read_text(errors='replace').splitlines()[-12:]
        parts.append(f'{name}:\n' + '\n'.join(lines))
message = '\n'.join(parts)[-6000:]
# Escape workflow-command control characters; this is text, never another command.
message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
print(f'::error::{message}')
