use std::process::{Command, Stdio};

#[test]
fn native_helper_is_silent_and_bad_arguments_never_reach_the_user_root() {
    for arguments in [
        vec![],
        vec!["--version"],
        vec!["--generation", "secret-invalid-uuid"],
        vec!["--generation", "12345678-1234-1234-1234-123456789012", "unexpected"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_quotum-hook"))
            .args(arguments)
            .env("ANTHROPIC_API_KEY", "secret-token-canary")
            .env("ANTHROPIC_AUTH_TOKEN", "secret-token-canary")
            .env("CLAUDE_CODE_OAUTH_TOKEN", "secret-token-canary")
            .env(
                "ANTHROPIC_BASE_URL",
                "https://secret-user:secret-password@openrouter.ai/secret-path?secret-query#secret-fragment",
            )
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}
