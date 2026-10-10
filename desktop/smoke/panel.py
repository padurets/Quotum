"""Native popup lifecycle, on tray.sh's private bus and an isolated Xvfb display."""
import ctypes as C
import inspect
from pathlib import Path
import re
import subprocess
import time
from native_evidence import belongs, identity, paused


def check_panel(bus, item, child, root, env, evidence):
    controller = identity(child.pid)
    known_engines = {}
    scenario = 'initial'
    from gi.repository import Gio, GLib
    x = C.CDLL('libX11.so.6')
    x.XOpenDisplay.argtypes = [C.c_char_p]
    x.XOpenDisplay.restype = C.c_void_p
    x.XDefaultRootWindow.argtypes = [C.c_void_p]
    x.XDefaultRootWindow.restype = C.c_ulong
    x.XQueryTree.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint)]
    x.XInternAtom.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
    x.XInternAtom.restype = C.c_ulong
    x.XGetWindowProperty.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_void_p)]
    x.XFree.argtypes = [C.c_void_p]
    x.XGetWindowAttributes.argtypes = [C.c_void_p, C.c_ulong, C.c_void_p]
    x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
    x.XPending.argtypes = [C.c_void_p]
    x.XNextEvent.argtypes = [C.c_void_p, C.c_void_p]
    x.XGetInputFocus.argtypes = [C.c_void_p, C.POINTER(C.c_ulong), C.POINTER(C.c_int)]
    x.XCloseDisplay.argtypes = [C.c_void_p]

    class Attributes(C.Structure):
        _fields_ = [('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int), ('border', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p), ('root', C.c_ulong), ('cls', C.c_int), ('bit', C.c_int), ('win', C.c_int), ('back', C.c_int), ('planes', C.c_ulong), ('pixel', C.c_ulong), ('save', C.c_int), ('cmap', C.c_ulong), ('installed', C.c_int), ('map_state', C.c_int), ('all_mask', C.c_long), ('mask', C.c_long), ('dont', C.c_long), ('override', C.c_int), ('screen', C.c_void_p)]

    class Error(C.Structure):
        _fields_ = [('type', C.c_int), ('display', C.c_void_p), ('resource', C.c_ulong), ('serial', C.c_ulong), ('code', C.c_ubyte), ('request', C.c_ubyte), ('minor', C.c_ubyte)]
    errors = []
    # A window can disappear between enumeration and reading its owner.
    @C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(Error))
    def closed_window(display, error):
        if error.contents.code != 3:
            errors.append((error.contents.code, error.contents.request))
        return 0
    x.XSetErrorHandler.argtypes = [C.c_void_p]
    x.XSetErrorHandler.restype = C.c_void_p
    previous_handler = x.XSetErrorHandler(closed_window)
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError('the panel smoke needs Xvfb')

    def property_values(window, name):
        actual, length, left, data = C.c_ulong(), C.c_ulong(), C.c_ulong(), C.c_void_p()
        form = C.c_int()
        x.XGetWindowProperty(display, window, x.XInternAtom(display, name, 0), 0, 32, 0, 0, C.byref(actual), C.byref(form), C.byref(length), C.byref(left), C.byref(data))
        try:
            return list(C.cast(data, C.POINTER(C.c_ulong))[:length.value]) if form.value == 32 and data else []
        finally:
            if data:
                x.XFree(data)

    def visible(owner, all_windows=False):
        parent = C.c_ulong()
        screen = C.c_ulong()
        children = C.POINTER(C.c_ulong)()
        count = C.c_uint()
        x.XQueryTree(display, x.XDefaultRootWindow(display), C.byref(screen), C.byref(parent), C.byref(children), C.byref(count))
        try:
            ids = list(children[:count.value])
        finally:
            x.XFree(children)
        found = []
        for window in ids:
            opacity = property_values(window, b'_NET_WM_WINDOW_OPACITY')
            matches = property_values(window, b'_NET_WM_PID') == [owner] and (all_windows or opacity != [0])
            if matches:
                attributes = Attributes()
                if x.XGetWindowAttributes(display, window, C.byref(attributes)) and (all_windows or attributes.map_state == 2):
                    attributes.opacity = opacity[0] if opacity else 0xffffffff
                    attributes.skip_taskbar = x.XInternAtom(display, b'_NET_WM_STATE_SKIP_TASKBAR', 0) in property_values(window, b'_NET_WM_STATE')
                    attributes.id = window
                    found.append(attributes)
        return found

    def focused_inside(window):
        focus, revert = C.c_ulong(), C.c_int()
        x.XGetInputFocus(display, C.byref(focus), C.byref(revert))
        current = focus.value
        # GTK can focus a child proxy instead of its top-level loader window.
        # Follow only this bounded native ancestry, never just "not main".
        for _ in range(32):
            if current == window:
                return True
            if current <= 1:
                return False
            parent, screen, count = C.c_ulong(), C.c_ulong(), C.c_uint()
            children = C.POINTER(C.c_ulong)()
            valid = x.XQueryTree(display, current, C.byref(screen), C.byref(parent), C.byref(children), C.byref(count))
            if children:
                x.XFree(children)
            if not valid or parent.value == current:
                return False
            current = parent.value
        return False

    def snapshot(stage):
        pid = engine()
        focus, revert = C.c_ulong(), C.c_int()
        x.XGetInputFocus(display, C.byref(focus), C.byref(revert))
        def windows(owner):
            return [dict(id=w.id, override=w.override, x=w.x, y=w.y, width=w.width,
                         height=w.height, mapState=w.map_state, opacity=w.opacity)
                    for w in visible(owner, True)] if owner else []
        evidence.record(stage, scenario=scenario, focus=focus.value, controller=identity(child.pid),
                        engine=identity(pid) if pid else None, controllerWindows=windows(child.pid),
                        engineWindows=windows(pid))

    def wait(predicate):
        until = time.monotonic() + 10
        evidence.record('wait-start', scenario=scenario, line=inspect.currentframe().f_back.f_lineno)
        while time.monotonic() < until:
            if child.poll() is not None:
                raise RuntimeError('controller exited during the native panel check')
            value = predicate()
            if value:
                snapshot('wait-complete')
                return value
            time.sleep(.01)
        snapshot('wait-timeout')
        raise RuntimeError('native panel operation timed out')

    def engine():
        log = root / 'app/logs/hub.log'
        matches = re.findall(r'Chromium starts \(pid (\d+)\)', log.read_text()) if log.exists() else []
        pid = int(matches[-1]) if matches else None
        current = identity(pid) if pid else None
        if not current or current['state'] in ('Z', 'X') or not belongs(pid, controller):
            return None
        birth = known_engines.setdefault(pid, current['birth'])
        return pid if birth == current['birth'] else None

    def activate():
        bus.call_sync(item, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'Activate', GLib.Variant('(ii)', (600, 440)), None, Gio.DBusCallFlags.NONE, 3000, None)

    def main_revision():
        log = root / 'app/logs/hub.log'
        matches = re.findall(r'app: main window request (\d+)', log.read_text()) if log.exists() else []
        return int(matches[-1]) if matches else 0

    def open_main():
        revision = main_revision()
        subprocess.run([child.args[0]], env=env, timeout=5, check=True)
        # A second process exits after writing to the socket, before the controller
        # necessarily accepts it. The next tray action must follow acceptance.
        wait(lambda: main_revision() > revision)

    try:
        for cancel in [False, True]:
            scenario = 'initial-cancel' if cancel else 'initial-handoff'
            activate()
            loader = wait(lambda: visible(child.pid))
            assert len(loader) == 1 and loader[0].skip_taskbar, 'loader must stay out of the taskbar'
            pid = wait(engine)
            with paused(identity(pid), controller, evidence.record):
                assert visible(child.pid), 'the loader cannot wait for Chromium'
                if cancel:
                    activate()
                    wait(lambda: not visible(child.pid))
            if cancel:
                wait(lambda: engine() is None)
                assert not visible(child.pid), 'a cancelled loader reappeared'
            else:
                popup = wait(lambda: visible(pid))
                assert len(popup) == 1 and popup[0].override, 'the browser must remain a popup'
                wait(lambda: not visible(child.pid))
                activate()
                wait(lambda: not visible(pid))
                wait(lambda: engine() is None)
        # Queue three real tray callbacks while only our controller is paused.
        # Blur from the first hide must not cancel the final open request.
        scenario = 'queued-final-open'
        with paused(identity(child.pid), controller, evidence.record):
            for _ in range(3):
                bus.call(item, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'Activate', GLib.Variant('(ii)', (600, 440)), None, Gio.DBusCallFlags.NONE, 3000, None, None, None)
                bus.flush_sync(None)
                time.sleep(.1)
        pid = wait(engine)
        wait(lambda: visible(pid))
        activate()
        wait(lambda: not visible(pid))
        wait(lambda: engine() is None)
        # Reopening main was accepted first, but its browser is paused. A newer
        # tray request must remain foreground when both queued heads are drained.
        scenario = 'old-main-new-panel'
        open_main()
        pid = wait(engine)
        board = wait(lambda: next((w for w in visible(pid) if not w.override), None))
        x.XSelectInput(display, board.id, 1 << 21)  # FocusChangeMask
        with paused(identity(pid), controller, evidence.record):
            open_main()
            activate()
            loader = wait(lambda: visible(child.pid))
            wait(lambda: focused_inside(loader[0].id))
            # Initial main focus belongs before this boundary. The loader owns
            # focus now, and only an excursion after resume is a regression.
            event = (C.c_long * 24)()
            while x.XPending(display):
                x.XNextEvent(display, C.byref(event))
        popup = wait(lambda: next((w for w in visible(pid) if w.override), None))
        focus, revert = C.c_ulong(), C.c_int()
        def panel_focused():
            x.XGetInputFocus(display, C.byref(focus), C.byref(revert))
            return focus.value == popup.id
        wait(panel_focused)
        event = (C.c_long * 24)()
        while x.XPending(display):
            x.XNextEvent(display, C.byref(event))
            assert not ((event[0] & 0xffffffff) == 9 and event[4] == board.id), 'obsolete main briefly took focus from the newer loader'
        activate()
        wait(lambda: not any(w.override for w in visible(pid)))
        # Keep an existing browser stopped while the native loader is closed and
        # reopened by two queued tray callbacks. Its old FocusOut must belong to
        # the retired GTK window, even when the new show waits for publication.
        scenario = 'retired-loader-reopen'
        with paused(identity(pid), controller, evidence.record):
            activate()
            old_loader = wait(lambda: visible(child.pid))[0]
            wait(lambda: focused_inside(old_loader.id))
            with paused(identity(child.pid), controller, evidence.record):
                for _ in range(2):
                    bus.call(item, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'Activate', GLib.Variant('(ii)', (600, 440)), None, Gio.DBusCallFlags.NONE, 3000, None, None, None)
                    bus.flush_sync(None)
                    time.sleep(.1)
            replacement = wait(lambda: next((w for w in visible(child.pid) if w.id != old_loader.id), None))
            wait(lambda: focused_inside(replacement.id))
        popup = wait(lambda: next((w for w in visible(pid) if w.override), None))
        wait(lambda: focused_inside(popup.id))
        activate()
        wait(lambda: not any(w.override for w in visible(pid)))
        assert not errors, f'unexpected X11 errors: {errors}'
        return {'loadingWithoutBrowser': True, 'popupHandoff': True, 'cancelledBeforePaint': True, 'queuedFinalOpen': True, 'newerPanelKeepsFocus': True, 'retiredLoaderCannotCancelReopen': True}
    finally:
        try:
            evidence.product(root)
            snapshot('scenario-finished')
        finally:
            x.XCloseDisplay(display)
            x.XSetErrorHandler(previous_handler)
