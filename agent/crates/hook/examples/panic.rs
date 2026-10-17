fn main() {
    // An aborting release canary shares the helper's real redirection and panic hook.
    // Invalid argv returns before any user-root lookup; this example is never packaged.
    quotum_core::hook::run();
    panic!("hook-release-panic-secret-canary");
}
