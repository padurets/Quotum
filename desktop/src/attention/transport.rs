//! ureq owns HTTP/chunk decoding; this loopback transport makes every wait cancellable.
use super::Context;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use ureq::unversioned::transport::{Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport};

#[derive(Debug)]
pub struct LocalConnector(pub Arc<Context>, pub u16);
impl Connector for LocalConnector {
    type Out = LocalTransport;
    fn connect(&self, details: &ConnectionDetails, _: Option<()>) -> Result<Option<Self::Out>, ureq::Error> {
        self.0.check()?;
        if details.uri.scheme_str() != Some("http")
            || details.uri.host() != Some("127.0.0.1")
            || details.uri.port_u16() != Some(self.1)
        {
            return Err(io::Error::other("not the local hub").into());
        }
        let socket =
            TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, self.1)), Duration::from_secs(1))?;
        socket.set_read_timeout(Some(Duration::from_secs(1)))?;
        socket.set_write_timeout(Some(Duration::from_secs(1)))?;
        Ok(Some(LocalTransport {
            socket,
            context: self.0.clone(),
            buffers: LazyBuffers::new(16_384, 16_384),
            last_byte: Instant::now(),
        }))
    }
}
#[derive(Debug)]
pub struct LocalTransport {
    socket: TcpStream,
    context: Arc<Context>,
    buffers: LazyBuffers,
    last_byte: Instant,
}
impl Transport for LocalTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, _: NextTimeout) -> Result<(), ureq::Error> {
        self.context.check()?;
        self.socket.write_all(&self.buffers.output()[..amount])?;
        Ok(())
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        let started = Instant::now();
        loop {
            self.context.check()?;
            if started.elapsed() >= *timeout.after || self.last_byte.elapsed() > Duration::from_millis(62_500) {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "attention timeout").into());
            }
            match self.socket.read(self.buffers.input_append_buf()) {
                Ok(n) => {
                    self.context.check()?;
                    self.last_byte = Instant::now();
                    self.buffers.input_appended(n);
                    return Ok(n > 0);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    fn is_open(&mut self) -> bool {
        false
    }
}
