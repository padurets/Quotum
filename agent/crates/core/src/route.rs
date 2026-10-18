//! Route evidence describes funding, never the identity or work of a process.

use serde::{Deserialize, Serialize};
mod acquisition;
pub(crate) use acquisition::Tracker;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Subscription,
    Api,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    Machine,
    Session,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub class: Class,
    pub by: By,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

impl Route {
    pub fn new(class: Class, by: By) -> Self {
        Self { class, by, host: None, provider: None }
    }

    /// Same-strength disagreement stays unknown, including after another repetition.
    pub fn merge(self, next: Self) -> Self {
        if self.by != next.by {
            return if next.by == By::Session { next } else { self };
        }
        if self.class != next.class || self.provider != next.provider {
            return Self::new(Class::Unknown, self.by);
        }
        Self { host: if self.host == next.host { self.host } else { None }, ..self }
    }
}

/// The caller supplies only bounded auth-status output; no account fields are used.
pub fn claude_machine(output: Option<&[u8]>) -> Route {
    let value = output.and_then(|raw| serde_json::from_slice::<serde_json::Value>(raw).ok());
    let method = value.as_ref().and_then(|v| v.get("authMethod")).and_then(|v| v.as_str());
    let provider = value.as_ref().and_then(|v| v.get("apiProvider")).and_then(|v| v.as_str());
    let class = if matches!(method, Some("api_key" | "api_key_helper" | "third_party"))
        || provider.is_some_and(|p| !p.is_empty() && p != "firstParty")
    {
        Class::Api
    } else if method == Some("claude.ai") && provider == Some("firstParty") {
        Class::Subscription
    } else {
        Class::Unknown
    };
    Route::new(class, By::Machine)
}

/// Capture has already removed URL components and token values.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeFlags {
    pub scrubbed: bool,
    pub bedrock: bool,
    pub vertex: bool,
    pub foundry: bool,
    pub api_key: bool,
    pub auth_token: bool,
    pub oauth_token: bool,
    pub invalid_base: bool,
    pub host: Option<String>,
}

pub fn claude_hook(flags: &ClaudeFlags) -> Route {
    let (class, host) = if flags.scrubbed {
        (Class::Unknown, flags.host.clone())
    } else if flags.bedrock || flags.vertex || flags.foundry {
        (Class::Api, None)
    } else if flags.api_key || flags.auth_token {
        (Class::Api, flags.host.clone())
    } else if flags.oauth_token {
        (Class::Unknown, flags.host.clone())
    } else if flags.invalid_base {
        (Class::Unknown, None)
    } else if flags.host.as_deref().is_none_or(|host| host == "api.anthropic.com") {
        (Class::Subscription, None)
    } else {
        (Class::Unknown, flags.host.clone())
    };
    Route { host, ..Route::new(class, By::Session) }
}

/// Only a complete thread set and authentication proven to belong to that process
/// may reach this classifier. Global history and a fresh app-server do not prove it.
pub struct CodexThread<'a> {
    pub model_provider: Option<&'a str>,
    pub auth_method: Option<&'a str>,
}

pub fn codex_bound_threads(threads: &[CodexThread<'_>]) -> Route {
    let routes = threads.iter().map(|thread| {
        let class = match (thread.model_provider, thread.auth_method) {
            (Some("openai"), Some("chatgpt")) => Class::Subscription,
            (Some("openai"), Some("apiKey")) => Class::Api,
            (Some("openai" | ""), _) | (None, _) => Class::Unknown,
            (Some(_), _) => Class::Api,
        };
        // These are exact catalogue IDs, not the person's custom provider names.
        let provider = thread
            .model_provider
            .filter(|id| matches!(*id, "claude" | "codex" | "antigravity" | "openrouter" | "deepseek" | "zai"))
            .filter(|_| class == Class::Api)
            .map(str::to_owned);
        Route { provider, ..Route::new(class, By::Session) }
    });
    // Different API providers remain API, with no identifying provider hint.
    routes
        .reduce(|before, next| {
            if before.class != next.class {
                Route::new(Class::Unknown, By::Session)
            } else {
                Route { provider: if before.provider == next.provider { before.provider } else { None }, ..before }
            }
        })
        .unwrap_or_else(|| Route::new(Class::Unknown, By::Session))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn machine_table_and_precedence() {
        let cases = [
            (json!({"authMethod":"claude.ai","apiProvider":"firstParty"}), Class::Subscription),
            (json!({"authMethod":"api_key","apiProvider":"firstParty"}), Class::Api),
            (json!({"authMethod":"api_key_helper"}), Class::Api),
            (json!({"authMethod":"third_party"}), Class::Api),
            (json!({"authMethod":"claude.ai","apiProvider":"bedrock"}), Class::Api),
            (json!({"authMethod":"oauth_token","apiProvider":"firstParty"}), Class::Unknown),
            (json!({"authMethod":"none","apiProvider":"firstParty"}), Class::Unknown),
            (json!({"authMethod":"oauth_token","apiProvider":"vertex"}), Class::Api),
            (json!({"authMethod":"none","apiProvider":"vertex"}), Class::Api),
            (json!({"authMethod":"new","apiProvider":"firstParty"}), Class::Unknown),
            (json!({"authMethod":"claude.ai"}), Class::Unknown),
            (json!({"authMethod":"claude.ai","apiProvider":""}), Class::Unknown),
            (json!({"authMethod":"claude.ai","apiProvider":false}), Class::Unknown),
            (json!({"authMethod":true,"apiProvider":"firstParty"}), Class::Unknown),
            (json!({}), Class::Unknown),
            (json!(null), Class::Unknown),
            (json!([]), Class::Unknown),
        ];
        for (input, class) in cases {
            assert_eq!(claude_machine(Some(&serde_json::to_vec(&input).unwrap())), Route::new(class, By::Machine));
        }
        assert_eq!(claude_machine(None).class, Class::Unknown);
        assert_eq!(claude_machine(Some(b"{")).class, Class::Unknown);
    }

    #[test]
    fn hook_table_and_precedence() {
        let host = || Some("openrouter.ai".to_owned());
        let cases = [
            (
                ClaudeFlags { scrubbed: true, api_key: true, bedrock: true, host: host(), ..Default::default() },
                Class::Unknown,
                host(),
            ),
            (ClaudeFlags { bedrock: true, api_key: true, host: host(), ..Default::default() }, Class::Api, None),
            (ClaudeFlags { vertex: true, ..Default::default() }, Class::Api, None),
            (ClaudeFlags { foundry: true, ..Default::default() }, Class::Api, None),
            (ClaudeFlags { api_key: true, oauth_token: true, host: host(), ..Default::default() }, Class::Api, host()),
            (ClaudeFlags { auth_token: true, ..Default::default() }, Class::Api, None),
            (ClaudeFlags { oauth_token: true, host: host(), ..Default::default() }, Class::Unknown, host()),
            (ClaudeFlags::default(), Class::Subscription, None),
            (ClaudeFlags { host: Some("api.anthropic.com".into()), ..Default::default() }, Class::Subscription, None),
            (ClaudeFlags { host: host(), ..Default::default() }, Class::Unknown, host()),
            (ClaudeFlags { invalid_base: true, ..Default::default() }, Class::Unknown, None),
            (ClaudeFlags { api_key: true, invalid_base: true, ..Default::default() }, Class::Api, None),
            (ClaudeFlags { scrubbed: true, ..Default::default() }, Class::Unknown, None),
        ];
        for (input, class, host) in cases {
            assert_eq!(claude_hook(&input), Route { class, by: By::Session, host, provider: None });
        }
    }

    #[test]
    fn codex_table_and_complete_window_aggregation() {
        let classify =
            |provider, method| codex_bound_threads(&[CodexThread { model_provider: provider, auth_method: method }]);
        for (provider, method, class, hint) in [
            (Some("openai"), Some("chatgpt"), Class::Subscription, None),
            (Some("openai"), Some("apiKey"), Class::Api, None),
            (Some("openrouter"), Some("chatgpt"), Class::Api, Some("openrouter")),
            (Some("my-router"), None, Class::Api, None),
            (Some("openai"), Some("amazonBedrock"), Class::Unknown, None),
            (Some("openai"), None, Class::Unknown, None),
            (None, Some("chatgpt"), Class::Unknown, None),
            (Some(""), Some("chatgpt"), Class::Unknown, None),
        ] {
            assert_eq!(
                classify(provider, method),
                Route { class, by: By::Session, host: None, provider: hint.map(str::to_owned) }
            );
        }
        let threads = |a, b| {
            codex_bound_threads(&[
                CodexThread { model_provider: Some(a), auth_method: Some("chatgpt") },
                CodexThread { model_provider: Some(b), auth_method: Some("chatgpt") },
            ])
        };
        assert_eq!(threads("openai", "openrouter").class, Class::Unknown);
        assert_eq!(threads("openrouter", "deepseek"), Route::new(Class::Api, By::Session));
        assert_eq!(threads("openrouter", "openrouter").provider.as_deref(), Some("openrouter"));
        assert_eq!(codex_bound_threads(&[]).class, Class::Unknown);
    }

    #[test]
    fn evidence_strength_and_conflicts_match_the_hub() {
        let machine = Route::new(Class::Subscription, By::Machine);
        let session = Route::new(Class::Api, By::Session);
        assert_eq!(machine.clone().merge(session.clone()), session);
        assert_eq!(session.clone().merge(machine.clone()), session);
        let conflict = session.clone().merge(Route::new(Class::Subscription, By::Session));
        assert_eq!(conflict.clone().merge(session), conflict);
        assert_eq!(machine.merge(Route::new(Class::Api, By::Machine)).class, Class::Unknown);
    }
}
