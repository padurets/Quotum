"""Native popup lifecycle, on tray.sh's private bus and an isolated Xvfb display."""
import ctypes as C
import os
from pathlib import Path
import re
import signal
import time


def check_panel(bus, item, child, root):
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

    def visible(owner):
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
            matches = property_values(window, b'_NET_WM_PID') == [owner] and property_values(window, b'_NET_WM_WINDOW_OPACITY') != [0]
            if matches:
                attributes = Attributes()
                if x.XGetWindowAttributes(display, window, C.byref(attributes)) and attributes.map_state == 2:
                    attributes.skip_taskbar = x.XInternAtom(display, b'_NET_WM_STATE_SKIP_TASKBAR', 0) in property_values(window, b'_NET_WM_STATE')
                    found.append(attributes)
        return found

    def wait(predicate):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            if child.poll() is not None:
                raise RuntimeError('controller exited during the native panel check')
            value = predicate()
            if value:
                return value
            time.sleep(.01)
        raise RuntimeError('native panel operation timed out')

    def engine():
        log = root / 'app/logs/hub.log'
        matches = re.findall(r'Chromium starts \(pid (\d+)\)', log.read_text()) if log.exists() else []
        pid = int(matches[-1]) if matches else None
        return pid if pid and Path(f'/proc/{pid}').exists() else None

    def activate():
        bus.call_sync(item, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'Activate', GLib.Variant('(ii)', (600, 440)), None, Gio.DBusCallFlags.NONE, 3000, None)

    try:
        for cancel in [False, True]:
            activate()
            loader = wait(lambda: visible(child.pid))
            assert len(loader) == 1 and loader[0].skip_taskbar, 'loader must stay out of the taskbar'
            pid = wait(engine)
            os.kill(pid, signal.SIGSTOP)
            try:
                assert visible(child.pid), 'the loader cannot wait for Chromium'
                if cancel:
                    activate()
                    wait(lambda: not visible(child.pid))
            finally:
                os.kill(pid, signal.SIGCONT)
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
        assert not errors, f'unexpected X11 errors: {errors}'
        return {'loadingWithoutBrowser': True, 'popupHandoff': True, 'cancelledBeforePaint': True}
    finally:
        x.XCloseDisplay(display)
        x.XSetErrorHandler(previous_handler)
