"""
Regenerate test-data/blosc/blosc_cases.{bin,index.json}: synthetic Blosc1
frames made by the reference implementation (numcodecs / c-blosc 1.x)
covering byte/bit/no shuffle, split and non-split blocks, several blocks
with a partial last block, raw (incompressible) streams, memcpyed chunks
and typesizes 1, 2, 3, 4, 8. Each case records the SHA-256 of the
uncompressed bytes; src/data/blosc.test.ts decodes every frame and checks
it bit for bit.

    python3 -m venv venv && ./venv/bin/pip install numcodecs numpy
    ./venv/bin/python tools/gen_blosc_fixtures.py            # writes the fixtures

(One Python process per BLOSC_SPLITMODE, since c-blosc reads it from the
environment.) Not used at runtime.
"""
import os, sys, json, base64, hashlib, subprocess
import numpy as np
from numcodecs import blosc
blosc.use_threads = True   # blosc_compress path (reads BLOSC_SPLITMODE)
from numcodecs.blosc import Blosc
if len(sys.argv) == 1:
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test-data', 'blosc')
    blob = bytearray(); index = []
    for m in ('FORWARD_COMPAT', 'NEVER'):
        res = subprocess.run([sys.executable, __file__, m], env={**os.environ, 'BLOSC_SPLITMODE': m}, check=True, capture_output=True)
        for c in json.loads(res.stdout):
            b = base64.b64decode(c.pop('compressed')); c['offset'] = len(blob); c['length'] = len(b); blob += b; index.append(c)
    open(os.path.join(out, 'blosc_cases.bin'), 'wb').write(blob)
    json.dump({'generator': 'tools/gen_blosc_fixtures.py: numcodecs ' + __import__('numcodecs').__version__ + ' (c-blosc ' + blosc.VERSION_STRING + ')', 'cases': index},
              open(os.path.join(out, 'blosc_cases.index.json'), 'w'), indent=1)
    sys.exit(0)
mode = sys.argv[1]
rng = np.random.default_rng(42)
def smooth(n, dtype, noise=False):
    x = np.linspace(0, 40, n)
    y = np.sin(x) * 1.5
    if noise: y = y + 0.05 * rng.integers(-1, 2, size=n)
    return np.round(y, 2).astype(dtype)
cases = []
def add(name, arr, shuffle, blocksize=0, clevel=5):
    arr = np.ascontiguousarray(arr)
    raw = arr.tobytes()
    c = blosc.compress(arr, b'lz4', clevel, shuffle, blocksize)
    assert blosc.decompress(c) == raw
    h = dict(flags=c[2], typesize=c[3], nbytes=int.from_bytes(c[4:8],'little'), blocksize=int.from_bytes(c[8:12],'little'))
    cases.append(dict(name=f'{mode}:{name}', compressed=base64.b64encode(c).decode(), sha256=hashlib.sha256(raw).hexdigest(),
                      head=base64.b64encode(raw[:64]).decode(), tail=base64.b64encode(raw[-64:]).decode(), **h))
big = mode != 'NEVER'   # split modes enlarge blocks to >= 64 KB; need > 64 KB to get several blocks
n4 = 40003 if big else 10003
f4 = smooth(n4, '<f4')
add('f4-shuffle-multiblock-partial', f4, Blosc.SHUFFLE, 4096)
add('f4-noshuffle-multiblock-partial', f4, Blosc.NOSHUFFLE, 4096)
add('f4-bitshuffle-multiblock-partial', f4, Blosc.BITSHUFFLE, 4096)
add('f4-bitshuffle-partial-not8', smooth(n4 - 2, '<f4'), Blosc.BITSHUFFLE, 4096)
add('f8-shuffle', smooth(n4 // 2 + 1, '<f8'), Blosc.SHUFFLE, 8192)
add('i2-shuffle', (smooth(n4, '<f4') * 1000).astype('<i2'), Blosc.SHUFFLE, 2048)
add('u1-shuffle', (np.arange(n4 * 2) % 7).astype('u1'), Blosc.SHUFFLE, 4096)
nv = n4 * 4 // 3
v3 = np.frombuffer(np.tile(np.arange(30, dtype='u1'), nv // 10 + 1).tobytes()[:3 * nv], dtype='V3')
add('v3-shuffle-typesize3', v3, Blosc.SHUFFLE, 3000)
add('v3-bitshuffle-typesize3', v3, Blosc.BITSHUFFLE, 3000)
mixed = f4.copy(); mixed[1024:1024 + 4096] = rng.random(4096, dtype=np.float32)   # incompressible region -> raw streams
add('f4-shuffle-raw-stream', mixed, Blosc.SHUFFLE, 4096)
if mode == 'FORWARD_COMPAT':
    add('random-raw-streams', rng.random(3000, dtype=np.float32), Blosc.SHUFFLE, 0)
    add('memcpyed-tiny', np.arange(20, dtype='<f4'), Blosc.SHUFFLE, 0)
    add('clevel0', f4[:1000], Blosc.SHUFFLE, 0, clevel=0)
    add('long-runs', np.zeros(50000, dtype='<f4'), Blosc.SHUFFLE, 0)
    add('f4-shuffle-auto-blocksize', smooth(300000, '<f4', noise=False), Blosc.SHUFFLE, 0)
json.dump(cases, sys.stdout)
