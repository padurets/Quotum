#!/usr/bin/env bash
set -euo pipefail

(( $# <= 2 ))
chrome_package="${1-google-chrome-stable}"
chrome_command="${2-google-chrome}"
case "$chrome_package:$chrome_command" in google-chrome-stable:google-chrome|google-chrome-beta:google-chrome-beta) ;; *) exit 1 ;; esac
chrome_version="$(dpkg-query -W -f='${Version}' "$chrome_package")"
chrome_version="${chrome_version%%-*}"
[[ "$chrome_version" =~ ^[0-9]+(\.[0-9]+){3}$ ]]
chrome_image="$(dirname "$(readlink -f "$(command -v "$chrome_command")")")/chrome"
unwind_dir="$(mktemp -d "$RUNNER_TEMP/quotum-native-unwind-XXXXXX")"
trap 'rm -f -- "$unwind_dir/archive.zip" "$unwind_dir/chrome.debug" "$unwind_dir/unwind.debug"; rmdir "$unwind_dir"' EXIT
curl --fail --location --max-time 120 --max-filesize 536870912 --output "$unwind_dir/archive.zip" "https://edgedl.me.gvt1.com/chrome/linux/symbols/google-chrome-debug-info-linux64-$chrome_version.zip"
python3 - "$chrome_version" "$chrome_image" "$unwind_dir" <<'PY'
import hashlib, json, pathlib, re, shutil, subprocess, sys, zipfile
version, image, directory = sys.argv[1:]
directory = pathlib.Path(directory)
full, thin = directory / 'chrome.debug', directory / 'unwind.debug'
with zipfile.ZipFile(directory / 'archive.zip') as archive:
    member = archive.getinfo('debug-info/chrome.debug')
    assert 0 < member.file_size <= 2 * 1024**3
    with archive.open(member) as source, full.open('xb') as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
remove = ['.debug_info', '.debug_line', '.debug_abbrev', '.debug_aranges', '.debug_ranges', '.debug_str',
          '.debug_addr', '.gdb_index', '.debug_names', '.debug_line_str', '.debug_loc', '.debug_loclists', '.debug_rnglists']
subprocess.run(['objcopy', '--strip-all', *['--remove-section=' + name for name in remove],
                '--keep-section=.debug_frame', '--keep-section=.note.gnu.build-id', str(full), str(thin)], check=True)
def section_hash(file, name):
    table = subprocess.check_output(['readelf', '-SW', str(file)], text=True)
    matches = re.findall(r'^\s*\[\s*\d+\]\s+' + re.escape(name) + r'\s+\S+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s', table, re.M)
    assert len(matches) == 1
    offset, size = (int(value, 16) for value in matches[0])
    digest = hashlib.sha256()
    with file.open('rb') as source:
        source.seek(offset)
        remaining = size
        while remaining:
            chunk = source.read(min(remaining, 1024 * 1024))
            assert chunk
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest(), size
def build_id(file):
    notes = subprocess.check_output(['readelf', '-n', str(file)], text=True)
    matches = re.findall(r'Build ID: ([0-9a-f]{8,128})', notes)
    assert len(matches) == 1 and len(matches[0]) % 2 == 0
    return matches[0]
identity = build_id(image)
assert build_id(full) == build_id(thin) == identity
cfi = section_hash(full, '.debug_frame')
assert 0 < cfi[1] <= 96 * 1024**2
assert section_hash(thin, '.debug_frame') == cfi
assert section_hash(thin, '.note.gnu.build-id') == section_hash(full, '.note.gnu.build-id')
assert 0 < thin.stat().st_size <= 96 * 1024**2
print(json.dumps({'kind': 'native-unwind-preparation', 'version': version, 'buildId': identity,
                  'cfiHash': cfi[0], 'cfiBytes': cfi[1], 'thinBytes': thin.stat().st_size}))
PY
unwind_id="$(readelf -n "$unwind_dir/unwind.debug" | awk '/Build ID:/{print $3}')"
unwind_target="/usr/lib/debug/.build-id/${unwind_id:0:2}/${unwind_id:2}.debug"
sudo test ! -e "$unwind_target"
sudo test ! -L "$unwind_target"
sudo install -D -m 0644 "$unwind_dir/unwind.debug" "$unwind_target"
