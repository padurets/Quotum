//! Quotum core: measures the subscription limits of coding agents through
//! their own command-line clients, schedules the measurements and delivers them.

pub mod activity;
pub mod clients;
pub mod config;
pub mod holder;
pub mod measurement_policy;
pub mod model;
pub mod observed;
pub mod process;
pub mod providers;
pub mod runner;
pub mod schedule;
mod session_identity;
pub mod sink;
pub mod stop;
