#!/usr/bin/env python3
"""Draws the menu-bar icon, a perforated stamp, as macOS template images.

A template image is black on transparent; macOS recolours it for a light or dark menu bar, which is
why only the alpha channel carries the drawing. The glyph is a 16-point icon written at 1x (16 px)
and 2x (32 px); each size is drawn natively, pixel-exact, rather than resampled, so the 2x one has
half-point detail the 1x one cannot.

Run from the repository root:  python3 scripts/app/make-tray-icon.py
It writes app/assets/trayTemplate.png and app/assets/trayTemplate@2x.png. Only the standard library
is used, so it runs on any Mac without installing anything.
"""
import os
import struct
import zlib

SIZES = (("trayTemplate.png", 16), ("trayTemplate@2x.png", 32))


def rect(ink, x0, y0, x1, y1):
    """Adds the pixels x0..x1 by y0..y1, both ends included."""
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            ink.add((x, y))


def solid_ring(ink, x0, y0, x1, y1, thick):
    rect(ink, x0, y0, x1, y0 + thick - 1)
    rect(ink, x0, y1 - thick + 1, x1, y1)
    rect(ink, x0, y0, x0 + thick - 1, y1)
    rect(ink, x1 - thick + 1, y0, x1, y1)


def perforated_ring(ink, x0, y0, x1, y1, thick, dash, gap):
    """A square ring of `dash`-long ink runs and `gap`-long breaks, thick pixels deep. The runs are laid
    out along each edge from the corner, so a corner is always ink and the pattern is mirrored on
    opposite edges; the edge length must be a whole number of runs plus the breaks between them."""
    length = x1 - x0 + 1
    assert (length + gap) % (dash + gap) == 0, "the edge is not a whole number of dashes"
    for start in range(0, length, dash + gap):
        for d in range(dash):
            t = start + d
            rect(ink, x0 + t, y0, x0 + t, y0 + thick - 1)          # top
            rect(ink, x0 + t, y1 - thick + 1, x0 + t, y1)          # bottom
            rect(ink, x0, y0 + t, x0 + thick - 1, y0 + t)          # left
            rect(ink, x1 - thick + 1, y0 + t, x1, y0 + t)          # right


def glyph(size):
    """The set of (x, y) pixels, on a size x size canvas, that are ink: a stamp, whose torn edge is a
    ring of dashes and whose picture is a solid square. Each size is drawn natively, not scaled."""
    ink = set()
    if size == 16:
        # A 13 px stamp: 1 px teeth (ink, break, ink...), a solid 1 px border inside them, a 1 px gap
        # and the 7 px picture.
        perforated_ring(ink, 1, 1, 13, 13, 1, 1, 1)
        solid_ring(ink, 2, 2, 12, 12, 1)
        rect(ink, 4, 4, 10, 10)
    else:
        # The same at 2x, drawn on its own pixels: a 26 px stamp, 2 px teeth and breaks, a 2 px border,
        # a 2 px gap and the 14 px picture.
        perforated_ring(ink, 3, 3, 28, 28, 2, 2, 2)
        solid_ring(ink, 5, 5, 26, 26, 2)
        rect(ink, 9, 9, 22, 22)
    return ink


def png(size, ink):
    rows = []
    for y in range(size):
        row = bytearray([0])  # Filter type 0 (none) for each scanline.
        for x in range(size):
            on = (x, y) in ink
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
    for name, size in SIZES:
        with open(os.path.join(out, name), "wb") as f:
            f.write(png(size, glyph(size)))
        print(os.path.join(out, name))


if __name__ == "__main__":
    main()
