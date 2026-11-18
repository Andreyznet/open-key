#!/usr/bin/env python3
import os
import struct
import zlib

def make_png(width: int, height: int, maskable: bool = False) -> bytes:
    """Generates a valid high-contrast RGBA PNG icon for DomRu Lab (Poco X6 Pro)."""
    raw_rows = bytearray()
    cx, cy = width / 2.0, height / 2.0
    radius = min(width, height) * (0.34 if maskable else 0.40)

    for y in range(height):
        raw_rows.append(0)  # filter type 0 (None)
        for x in range(width):
            dx = x - cx
            dy = y - cy
            dist = (dx * dx + dy * dy) ** 0.5

            # Background: dark slate #090D16 -> #0F172A gradient
            r, g, b, a = 11, 17, 32, 255

            # Outer glowing ring (Sky/Emerald cyan accent)
            if abs(dist - radius) < width * 0.032:
                r, g, b = 14, 165, 233  # sky-500 #0EA5E9
            elif dist < radius:
                # Inner shield background
                r, g, b = 15, 23, 42  # slate-900

                # Draw stylized gate / face biometric brackets inside
                nx = dx / radius  # -1..1
                ny = dy / radius  # -1..1

                # Corner brackets
                in_bracket_x = 0.35 <= abs(nx) <= 0.58
                in_bracket_y = 0.35 <= abs(ny) <= 0.58
                is_bracket_edge = (
                    (in_bracket_x and 0.48 <= abs(ny) <= 0.58)
                    or (in_bracket_y and 0.48 <= abs(nx) <= 0.58)
                )
                # Central keyhole / gate arch
                in_arch = (nx * nx + (ny + 0.08) ** 2) <= 0.055 or (
                    abs(nx) <= 0.09 and -0.05 <= ny <= 0.32
                )

                if is_bracket_edge:
                    r, g, b = 56, 189, 248  # sky-400
                elif in_arch:
                    r, g, b = 16, 185, 129  # emerald-500

            raw_rows.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(bytes(raw_rows), 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )

os.makedirs("/app/applet/public", exist_ok=True)
os.makedirs("/app/applet/android-app/res/drawable", exist_ok=True)
os.makedirs("/app/applet/android-app/res/values", exist_ok=True)
os.makedirs("/app/applet/android-app/src/ru/domrulab/pocox6pro", exist_ok=True)

with open("/app/applet/public/pwa-192x192.png", "wb") as f:
    f.write(make_png(192, 192, False))

with open("/app/applet/public/pwa-512x512.png", "wb") as f:
    f.write(make_png(512, 512, False))

with open("/app/applet/public/pwa-maskable-512x512.png", "wb") as f:
    f.write(make_png(512, 512, True))

with open("/app/applet/public/apple-touch-icon.png", "wb") as f:
    f.write(make_png(180, 180, False))

with open("/app/applet/android-app/res/drawable/ic_launcher.png", "wb") as f:
    f.write(make_png(192, 192, False))

print("Generated all PNG icons successfully.")
