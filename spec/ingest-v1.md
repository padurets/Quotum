# Ingest format v1

How an agent delivers measurements to a hub. Any collector may implement it; the
reference implementation is `agent/` (Rust).

## Request

```
POST /v1/ingest
Authorization: Bearer <device token>
Content-Type: application/json
```

```json
{
  "version": 1,
  "agent": "agent-limits/0.1.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "sentAt": "2026-09-22T18:43:45.120Z",
  "snapshots": [
    {
      "provider": "claude",
      "account": "9c1e5a0b7d2f4e6a8b0c1d2e",
      "plan": "max",
      "observedAt": "2026-09-22T18:43:44.870Z",
      "via": "claude-code/get_usage",
      "client": "2.1.280",
      "staleAfterMs": 204000,
      "windows": [
        {"id": "session", "kind": "session", "minutes": 300, "usedPercent": 5, "resetsAt": "2026-09-22T20:20:00.921Z"},
        {"id": "weekly", "kind": "weekly", "minutes": 10080, "usedPercent": 10, "resetsAt": "2026-09-28T06:00:00Z"},
        {"id": "weekly:fable", "kind": "weekly", "minutes": 10080, "label": "Fable", "usedPercent": 0, "resetsAt": "2026-09-28T06:00:00Z"}
      ]
    }
  ],
  "failures": [
    {"provider": "antigravity", "observedAt": "2026-09-22T18:43:52Z", "error": "not_logged_in", "detail": "…"}
  ]
}
```

Timestamps are RFC 3339 strings. Optional fields may be omitted or `null`. A batch holds
at most 500 snapshots and 500 failures; a hub may refuse larger bodies.

### Machine

| Field | Meaning |
|---|---|
| `id` | Random id generated once per installation. Not derived from hardware. |
| `name` | Display name, the host name by default (configurable). |
| `os`, `arch` | As reported by the agent's runtime (`linux`, `macos`, `windows`; `x86_64`, `aarch64`). |

### Snapshot

One successful measurement of one provider account on one machine.

| Field | Meaning |
|---|---|
| `provider` | `claude`, `codex` or `antigravity`. |
| `account` | Pseudonym of the account: the first 24 hex characters of `sha256("agent-limits/account/v1\n<provider>\n<stable account id, lower-case>")`. The same account on two machines gets the same pseudonym. Absent when the client does not say which account it is (Antigravity); the hub then keeps the account per machine. |
| `plan` | The provider's plan name (`max`, `pro`), if reported. |
| `observedAt` | When the client answered. |
| `via` | How the value was obtained (`claude-code/get_usage`, `codex/app-server`, `agy/usage`). |
| `client` | Version of the agent's client that answered. |
| `staleAfterMs` | How long this measurement stays representative. The agent promises the next measurement of this provider before then; a later one is a gap. At most 24 h. |
| `windows` | At least one window. |

### Window

| Field | Meaning |
|---|---|
| `id` | Stable within the provider: `session`, `weekly`, `<scope>:<kind>` (`weekly:fable`, `gemini:session`), `window-<minutes>` for other lengths. |
| `kind` | `session` (5 hours), `weekly`, or `other`. |
| `minutes` | Window length, if known. |
| `label` | The provider's name for the scope of the window (a model or model group), if any. |
| `usedPercent` | 0–100, share of the window already used. |
| `resetsAt` | When the window resets, if known. An idle rolling window reports "now + length". |

### Failure

A measurement that did not succeed. `error` is one of `not_logged_in`, `unsupported`
(the client cannot report plan limits: too old, API-key login), `timeout`,
`invalid_output`, `failed`. `detail` is free text for people, at most 200 characters.
Agents do not report providers whose client is not installed.

## Response

`200` with `{"accepted": n, "duplicates": n, "failures": n}`. A snapshot the hub already
has (same account, not newer than the last one) counts as a duplicate, so resending a
batch after a lost answer is safe.

| Status | Meaning | Agent behaviour |
|---|---|---|
| `400` | The batch does not match this format (`{"error": "invalid_batch", "detail": …}`) | Drop it |
| `401` | Unknown token | Keep the data, retry later |
| `413` | Body too large | Drop it |
| `5xx`, network errors | Hub unavailable | Keep the data, retry later |

## Privacy

What never leaves the machine: tokens, cookies, e-mail addresses, account ids,
prompts, file paths. What is sent: the pseudonym of the account, the plan name,
percentages and reset times of the windows, the client version, the machine id and
name.
