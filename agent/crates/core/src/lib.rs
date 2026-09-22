//! Quotum core: measures the subscription limits of coding agents through
//! their own command-line clients, schedules the measurements and delivers them.

pub mod config;
pub mod model;
pub mod process;
pub mod providers;
pub mod runner;
pub mod schedule;
pub mod sink;
