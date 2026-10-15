#!/usr/bin/env python3
"""Build the bundled Omni Judge samples. Re-run only when the media set changes."""

from __future__ import annotations

import math
import os
import random
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "samples"
SRC = Path("/tmp/oj-src")
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def save_jpeg(image: Image.Image, name: str, max_edge: int = 960, quality: int = 82) -> None:
    rgb = image.convert("RGB")
    rgb = ImageOps.exif_transpose(rgb)
    rgb.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    dest = OUT / name
    rgb.save(dest, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"wrote {dest.name} {dest.stat().st_size} {rgb.size}")


def crop_phone(image: Image.Image) -> Image.Image:
    w, h = image.size
    return image.crop((int(w * 0.28), int(h * 0.12), int(w * 0.92), int(h * 0.95)))


def paper_noise(image: Image.Image, amount: int = 12) -> Image.Image:
    rng = random.Random(7)
    px = image.load()
    w, h = image.size
    for _ in range(w * h // 40):
        x, y = rng.randrange(w), rng.randrange(h)
        r, g, b = px[x, y]
        d = rng.randint(-amount, amount)
        px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))
    return image


def make_receipt(blurry: bool) -> Image.Image:
    w, h = 720, 1100
    img = Image.new("RGB", (w, h), (236, 232, 214))
    draw = ImageDraw.Draw(img)
    margin = 48
    draw.rectangle((28, 28, w - 28, h - 28), outline=(90, 84, 70), width=2)
    mono = font(FONT_MONO, 28)
    small = font(FONT_MONO, 22)
    tiny = font(FONT_MONO, 18)
    title = font(FONT_BOLD, 36)
    draw.text((w // 2, 70), "NORTHLINE CAFE", fill=(20, 18, 14), font=title, anchor="mt")
    draw.text((w // 2, 118), "14 Graphite Way", fill=(40, 36, 28), font=small, anchor="mt")
    draw.text((w // 2, 148), "14 Oct 2026  08:41", fill=(40, 36, 28), font=small, anchor="mt")
    draw.text((w // 2, 186), "------------------------------", fill=(40, 36, 28), font=mono, anchor="mt")
    lines = [
        ("Oat latte", "4.50"),
        ("Avocado toast", "8.75"),
        ("Sparkling water", "2.25"),
        ("Subtotal", "15.50"),
        ("Tax 8.25%", "1.28"),
        ("TOTAL", "16.78"),
    ]
    y = 230
    for label, price in lines:
        weight = title if label == "TOTAL" else mono
        draw.text((margin, y), label, fill=(20, 18, 14), font=weight)
        draw.text((w - margin, y), price, fill=(20, 18, 14), font=weight, anchor="rt")
        y += 52 if label != "TOTAL" else 64
    draw.text((w // 2, y + 8), "VISA  ****1842", fill=(40, 36, 28), font=small, anchor="mt")
    draw.text((w // 2, y + 44), "AUTH 774291", fill=(40, 36, 28), font=small, anchor="mt")
    barcode_y = y + 90
    rng = random.Random(21)
    x = margin
    while x < w - margin:
        bar_w = 2 if rng.random() < 0.65 else 5
        draw.rectangle((x, barcode_y, x + bar_w, barcode_y + 70), fill=(20, 18, 14))
        x += bar_w + 2
    draw.text((w // 2, barcode_y + 92), "THANK YOU", fill=(40, 36, 28), font=tiny, anchor="mt")
    draw.text((w // 2, barcode_y + 118), "Keep this receipt for expenses", fill=(40, 36, 28), font=tiny, anchor="mt")
    img = paper_noise(img, 10)
    if not blurry:
        return img
    smeared = img.transform(img.size, Image.Transform.AFFINE, (1, 0.18, -40, 0.02, 1, 8), resample=Image.Resampling.BICUBIC)
    smeared = smeared.filter(ImageFilter.GaussianBlur(radius=14))
    smeared = smeared.filter(ImageFilter.UnsharpMask(radius=1, percent=40))
    return smeared.point(lambda p: min(255, int(p * 1.08 + 8)))


def cardboard(size: tuple[int, int], seed: int) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", size, (186, 142, 86))
    px = img.load()
    w, h = size
    for y in range(h):
        for x in range(w):
            n = rng.randint(-14, 14)
            stripe = 8 if (x + y) % 17 == 0 else 0
            r = max(0, min(255, 186 + n - stripe))
            g = max(0, min(255, 142 + n - stripe))
            b = max(0, min(255, 86 + n // 2))
            px[x, y] = (r, g, b)
    return img.filter(ImageFilter.SMOOTH)


def draw_label(box: Image.Image, xy: tuple[int, int], damaged: bool) -> None:
    x, y = xy
    label = Image.new("RGB", (210, 130), (248, 246, 238))
    d = ImageDraw.Draw(label)
    d.rectangle((0, 0, 209, 129), outline=(40, 36, 28), width=2)
    d.text((10, 8), "SHIP TO", fill=(40, 36, 28), font=font(FONT_SANS, 14))
    d.text((10, 28), "Northline Desk", fill=(20, 18, 14), font=font(FONT_BOLD, 16))
    d.text((10, 50), "14 Graphite Way", fill=(40, 36, 28), font=font(FONT_SANS, 14))
    d.text((10, 70), "ORDER  N-1842", fill=(40, 36, 28), font=font(FONT_MONO, 13))
    for i in range(18):
        d.rectangle((10 + i * 10, 94, 16 + i * 10, 118), fill=(20, 18, 14))
    if damaged:
        label = label.transform(label.size, Image.Transform.AFFINE, (1, 0.12, 0, 0.08, 1, 0), resample=Image.Resampling.BICUBIC)
        d = ImageDraw.Draw(label)
        d.line((0, 20, 210, 110), fill=(40, 36, 28), width=3)
        d.polygon([(160, 0), (210, 0), (210, 50)], fill=(186, 142, 86))
    box.paste(label, (x, y))


def make_parcel(damaged: bool) -> Image.Image:
    canvas = Image.new("RGB", (1000, 780), (48, 48, 52))
    floor = Image.new("RGB", (1000, 280), (62, 62, 66))
    canvas.paste(floor, (0, 500))
    face = cardboard((560, 360), 3)
    top = cardboard((560, 120), 4)
    side = cardboard((90, 360), 5)
    d_face = ImageDraw.Draw(face)
    d_face.rectangle((12, 12, 547, 347), outline=(120, 88, 50), width=3)
    d_face.rectangle((0, 168, 559, 198), fill=(210, 176, 72))
    ImageDraw.Draw(top).rectangle((0, 50, 559, 78), fill=(210, 176, 72))
    ImageDraw.Draw(side).rectangle((0, 168, 89, 198), fill=(210, 176, 72))
    if damaged:
        crush = ImageDraw.Draw(face)
        crush.polygon([(360, 40), (559, 20), (559, 220), (400, 260), (340, 140)], fill=(120, 86, 48))
        crush.line([(380, 50), (540, 90), (500, 200), (390, 230)], fill=(60, 40, 24), width=6)
        for hole in ((430, 80), (500, 130), (460, 170)):
            crush.ellipse((hole[0], hole[1], hole[0] + 28, hole[1] + 18), fill=(48, 48, 52))
        torn = ImageDraw.Draw(top)
        torn.polygon([(300, 0), (559, 0), (559, 119), (280, 90)], fill=(48, 48, 52))
        torn.line([(280, 90), (400, 20), (520, 70)], fill=(70, 48, 28), width=5)
        ImageDraw.Draw(side).polygon([(20, 240), (89, 200), (89, 359), (0, 359)], fill=(40, 40, 44))
    box = Image.new("RGB", (650, 480), (48, 48, 52))
    box.paste(top, (90, 0))
    box.paste(side, (0, 120))
    box.paste(face, (90, 120))
    draw_label(box, (150, 200), damaged)
    if damaged:
        box = box.transform(box.size, Image.Transform.AFFINE, (1, 0.04, 0, 0.03, 1, 8), resample=Image.Resampling.BICUBIC)
    canvas.paste(box, (170, 160))
    shade = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shade).ellipse((240, 620, 820, 720), fill=(0, 0, 0, 60))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shade).convert("RGB")
    return canvas.filter(ImageFilter.SMOOTH)


def write_wav(path: Path, samples: list[float], rate: int = 16_000) -> None:
    data = b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        len(data),
    )
    path.write_bytes(header + data)


def tts(text: str, dest: Path, voice: str, speed: int, pitch: int) -> None:
    raw = dest.with_suffix(".raw.wav")
    subprocess.check_call(
        ["espeak-ng", "-v", voice, "-s", str(speed), "-p", str(pitch), "-a", "160", "-w", str(raw), text]
    )
    subprocess.check_call(
        ["ffmpeg", "-y", "-i", str(raw), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    raw.unlink(missing_ok=True)
    print(f"wrote {dest.name} {dest.stat().st_size}")


def person(draw: ImageDraw.ImageDraw, origin: tuple[float, float], phase: float, tilt: float, scale: float) -> None:
    ox, oy = origin
    swing = math.sin(phase) * 0.55
    arm = math.sin(phase + math.pi) * 0.45

    def rot(px: float, py: float) -> tuple[int, int]:
        ca, sa = math.cos(tilt), math.sin(tilt)
        x, y = px * scale, py * scale
        rx, ry = x * ca - y * sa, x * sa + y * ca
        return int(ox + rx), int(oy + ry)

    color = (28, 28, 30)
    head = rot(0, -78)
    draw.ellipse((head[0] - 14, head[1] - 16, head[0] + 14, head[1] + 16), fill=color)
    draw.line([rot(0, -60), rot(0, 8)], fill=color, width=10)
    draw.line([rot(-6, -44), rot(-34, -12 + arm * 18)], fill=color, width=7)
    draw.line([rot(6, -44), rot(34, -12 - arm * 18)], fill=color, width=7)
    draw.line([rot(0, 8), rot(-22 + swing * 8, 78)], fill=color, width=8)
    draw.line([rot(0, 8), rot(22 - swing * 8, 78)], fill=color, width=8)
    draw.ellipse((rot(-22 + swing * 8, 82)[0] - 6, rot(-22 + swing * 8, 82)[1] - 4, rot(-22 + swing * 8, 82)[0] + 10, rot(-22 + swing * 8, 82)[1] + 6), fill=color)
    draw.ellipse((rot(22 - swing * 8, 82)[0] - 6, rot(22 - swing * 8, 82)[1] - 4, rot(22 - swing * 8, 82)[0] + 10, rot(22 - swing * 8, 82)[1] + 6), fill=color)


def scene(w: int = 480, h: int = 270) -> Image.Image:
    img = Image.new("RGB", (w, h), (58, 60, 64))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 168, w, h), fill=(92, 92, 96))
    for x in range(0, w, 28):
        d.rectangle((x, 168, x + 14, 178), fill=(212, 168, 36) if (x // 28) % 2 == 0 else (20, 20, 22))
    d.rectangle((0, 0, 18, h), fill=(70, 72, 76))
    d.rectangle((w - 18, 0, w, h), fill=(70, 72, 76))
    return img


def encode_video(frames: list[Image.Image], dest: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        for i, frame in enumerate(frames):
            frame.save(folder / f"f{i:03d}.png")
        subprocess.check_call(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                "12",
                "-i",
                str(folder / "f%03d.png"),
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=mono:sample_rate=16000",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "28",
                "-preset",
                "slow",
                "-c:a",
                "aac",
                "-b:a",
                "32k",
                "-movflags",
                "+faststart",
                str(dest),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    print(f"wrote {dest.name} {dest.stat().st_size}")


def make_walk() -> list[Image.Image]:
    frames = []
    for i in range(48):
        img = scene()
        d = ImageDraw.Draw(img)
        x = 70 + i * 7.2
        person(d, (x, 168), i * 0.7, 0.0, 1.15)
        frames.append(img)
    return frames


def make_fall() -> list[Image.Image]:
    frames = []
    for i in range(48):
        img = scene()
        d = ImageDraw.Draw(img)
        if i < 10:
            person(d, (220, 168), 0.2, math.sin(i / 2) * 0.08, 1.15)
        elif i < 30:
            t = (i - 10) / 20
            tilt = t * (math.pi / 2)
            y = 168 + t * t * 70
            x = 220 + t * 70
            person(d, (x, y), 0.4, tilt, 1.15)
        else:
            t = min(1, (i - 30) / 6)
            person(d, (300, 238), 0.1, math.pi / 2 + t * 0.08, 1.15)
        frames.append(img)
    return frames


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    save_jpeg(make_receipt(False), "receipt-legible.jpg", max_edge=900, quality=85)
    save_jpeg(make_receipt(True), "receipt-blurry.jpg", max_edge=900, quality=70)
    save_jpeg(crop_phone(Image.open(SRC / "shattered.jpg")), "phone-cracked.jpg")
    save_jpeg(Image.open(SRC / "phone_intact.jpg"), "phone-intact.jpg")
    save_jpeg(make_parcel(True), "parcel-damaged.jpg", max_edge=900, quality=84)
    save_jpeg(make_parcel(False), "parcel-intact.jpg", max_edge=900, quality=84)

    urgent = (
        "This is unacceptable! You charged my card twice and I still cannot log in. "
        "I need this fixed right now. I am furious."
    )
    routine = (
        "Hello. I would like to update the shipping address on my next order. "
        "There is no rush at all. Thank you."
    )
    tts(urgent, OUT / "voice-urgent.wav", "en-us", 175, 28)
    tts(routine, OUT / "voice-routine.wav", "en-us", 125, 48)

    encode_video(make_fall(), OUT / "safety-fall.mp4")
    encode_video(make_walk(), OUT / "safety-walk.mp4")

    for stale in ("voicemail.wav", "machine.wav", "gallery.png", "package.png", "clip.webm"):
        path = OUT / stale
        if path.exists():
            path.unlink()
            print("removed", stale)


if __name__ == "__main__":
    main()
