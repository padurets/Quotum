"""An installed controller must register its tray when the watcher appears later.

tray.sh supplies a private bus without service activation. Every provider is off,
and the hidden app writes only to temporary data and start-at-login directories.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

from gi.repository import Gio, GLib

if os.environ.get('QUOTUM_TEST_PRIVATE_BUS') != '1':
    raise SystemExit('run this check through tray.sh, on its private bus')

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
watcher = 'org.kde.StatusNotifierWatcher'
owned = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                      'org.freedesktop.DBus', 'NameHasOwner',
                      GLib.Variant('(s)', (watcher,)), None,
                      Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
if owned:
    raise SystemExit('the test bus must start without a tray watcher')

xml = '''<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
</interface></node>'''
registered = []
owners = []
result = {}
loop = GLib.MainLoop()


def finish():
    loop.quit()
    return False


def method(connection, sender, path, interface, name, parameters, invocation):
    if name == 'RegisterStatusNotifierItem':
        registered.append(parameters.unpack()[0])
    invocation.return_value(GLib.Variant('()', ()))
    if registered:
        GLib.timeout_add(150, finish)


def prop(connection, sender, path, interface, name):
    if name == 'RegisteredStatusNotifierItems':
        return GLib.Variant('as', registered)
    if name == 'IsStatusNotifierHostRegistered':
        return GLib.Variant('b', True)
    return GLib.Variant('i', 0)


# This API also exists in the PyGObject shipped by Ubuntu 22.04.
bus.register_object('/StatusNotifierWatcher',
                    Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], method, prop, None)

with tempfile.TemporaryDirectory(prefix='quotum-late-tray-') as directory:
    root = Path(directory)
    config = root / 'config.toml'
    config.write_text('sessions=false\n[providers.claude]\nenabled=false\n'
                      '[providers.codex]\nenabled=false\n[providers.antigravity]\nenabled=false\n')
    env = {**os.environ, 'QUOTUM_APP_DATA_DIR': str(root / 'app'),
           'QUOTUM_STATE_DIR': str(root / 'state'), 'QUOTUM_CONFIG': str(config),
           'QUOTUM_RESETS': 'off', 'XDG_CONFIG_HOME': str(root / 'xdg-config')}

    with (root / 'launch.log').open('w') as log:
        child = subprocess.Popen([str(Path(sys.argv[1]).resolve()), '--hidden'],
                                 env=env, stdout=log, stderr=log)

        def appear():
            result['noRegistrationBeforeWatcher'] = not registered
            owners.append(Gio.bus_own_name_on_connection(
                bus, watcher, Gio.BusNameOwnerFlags.NONE, None, None))
            return False

        def wait_for_controller():
            names = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                  'org.freedesktop.DBus', 'ListNames', None, None,
                                  Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
            if not any(name.startswith(f'org.kde.StatusNotifierItem-{child.pid}-') for name in names):
                return True
            result['controllerAdvertisedBeforeWatcher'] = True
            GLib.timeout_add(200, appear)
            return False

        GLib.timeout_add(50, wait_for_controller)
        GLib.timeout_add(7000, finish)
        try:
            loop.run()
            prefix = f'org.kde.StatusNotifierItem-{child.pid}-'
            result.update(registered=registered,
                          lateRegistration=any(s.startswith(prefix) for s in registered),
                          controllerAlive=child.poll() is None)
            if result['lateRegistration']:
                props = bus.call_sync(registered[0], '/StatusNotifierItem',
                                      'org.freedesktop.DBus.Properties', 'GetAll',
                                      GLib.Variant('(s)', ('org.kde.StatusNotifierItem',)), None,
                                      Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
                result.update(title=props['Title'], status=props['Status'])
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            result['exit'] = child.returncode

    print(result)
    if not (result.get('lateRegistration') and result.get('controllerAlive')
            and result.get('controllerAdvertisedBeforeWatcher')
            and result.get('noRegistrationBeforeWatcher') and child.returncode == 0):
        print((root / 'launch.log').read_text(), file=sys.stderr)
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            message = str(result).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
            print(f'::error::late tray registration failed: {message}')
        raise SystemExit(1)
