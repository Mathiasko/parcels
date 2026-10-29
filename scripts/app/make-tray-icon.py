#!/usr/bin/env python3
"""Draws the menu-bar icon, a parcel glyph, as macOS template images.

A template image is black on transparent; macOS recolours it for a light or dark menu bar, which is
why only the alpha channel carries the drawing. The glyph is drawn on a 16-point grid and written
at 1x (16 px) and 2x (32 px), so both are pixel-exact rather than resampled.

Run from the repository root:  python3 scripts/app/make-tray-icon.py
It writes app/assets/trayTemplate.png and app/assets/trayTemplate@2x.png. Only the standard library
is used, so it runs on any Mac without installing anything.
"""
import os
import struct
import zlib

GRID = 16


def glyph():
    """The set of (x, y) cells, on the 16x16 grid, that are ink."""
    ink = set()

    def rect(x0, y0, x1, y1):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                ink.add((x, y))

    # The box: a 1-cell outline from (1, 3) to (14, 14).
    rect(1, 3, 14, 3)
    rect(1, 14, 14, 14)
    rect(1, 3, 1, 14)
    rect(14, 3, 14, 14)
    # The lid's edge, a third of the way down.
    rect(1, 7, 14, 7)
    # The tape: a 2-cell strip down the middle of the lid and on down the front.
    rect(7, 3, 8, 10)
    return ink


def png(size, ink):
    scale = size // GRID
    rows = []
    for y in range(size):
        row = bytearray([0])  # Filter type 0 (none) for each scanline.
        for x in range(size):
            on = (x // scale, y // scale) in ink
            row += bytes((0, 0, 0, 255 if on else 0))
        rows.append(bytes(row))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    # 8-bit RGBA, no interlace.
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def main():
    out = os.path.join("app", "assets")
    os.makedirs(out, exist_ok=True)
    ink = glyph()
    for name, size in (("trayTemplate.png", 16), ("trayTemplate@2x.png", 32)):
        with open(os.path.join(out, name), "wb") as f:
            f.write(png(size, ink))
        print(os.path.join(out, name))


if __name__ == "__main__":
    main()
