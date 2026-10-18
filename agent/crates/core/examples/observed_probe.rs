#[cfg(target_os = "linux")]
fn main() {
    quotum_core::observed::probe::main();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("The resource probe currently requires Linux.");
    std::process::exit(2);
}
