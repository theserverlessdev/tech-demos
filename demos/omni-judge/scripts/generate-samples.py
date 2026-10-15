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


def kraft(size: tuple[int, int], seed: int, shade: tuple[int, int, int]) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", size, shade)
    px = img.load()
    w, h = size
    for y in range(h):
        for x in range(w):
            n = rng.randint(-18, 18)
            rib = 10 if y % 7 == 0 else 0
            r = max(0, min(255, shade[0] + n - rib))
            g = max(0, min(255, shade[1] + n - rib))
            b = max(0, min(255, shade[2] + n // 2))
            px[x, y] = (r, g, b)
    return img.filter(ImageFilter.SMOOTH)


def shipping_label(damaged: bool) -> Image.Image:
    label = Image.new("RGB", (248, 156), (250, 247, 236))
    d = ImageDraw.Draw(label)
    d.rectangle((0, 0, 247, 155), outline=(36, 32, 26), width=3)
    d.rectangle((0, 0, 247, 28), fill=(196, 48, 32))
    d.text((10, 6), "FRAGILE  ·  HANDLE WITH CARE", fill=(255, 246, 238), font=font(FONT_BOLD, 13))
    d.text((10, 36), "SHIP TO", fill=(90, 82, 70), font=font(FONT_SANS, 12))
    d.text((10, 54), "Northline Desk", fill=(22, 18, 14), font=font(FONT_BOLD, 18))
    d.text((10, 78), "14 Graphite Way", fill=(40, 36, 28), font=font(FONT_SANS, 14))
    d.text((10, 98), "ORDER  N-1842", fill=(40, 36, 28), font=font(FONT_MONO, 13))
    for i in range(22):
        d.rectangle((10 + i * 10, 122, 16 + i * 10, 146), fill=(22, 18, 14))
    if damaged:
        d.line((8, 40, 236, 148), fill=(36, 32, 26), width=4)
        d.polygon([(190, 0), (247, 0), (247, 70)], fill=(132, 92, 52))
        label = label.transform(label.size, Image.Transform.AFFINE, (1, 0.08, 0, 0.05, 1, 0), resample=Image.Resampling.BICUBIC)
    return label


def make_parcel_intact() -> Image.Image:
    """Front-facing sealed carton on a plain field. No isometric side that can read as a tear."""
    w, h = 1000, 800
    canvas = Image.new("RGB", (w, h), (242, 242, 238))
    face = kraft((640, 430), 11, (198, 156, 98))
    d = ImageDraw.Draw(face)
    d.rectangle((2, 2, 637, 427), outline=(138, 102, 58), width=5)
    tape = (232, 204, 108)
    d.rectangle((0, 196, 639, 244), fill=tape)
    d.rectangle((292, 0, 348, 429), fill=tape)
    d.rectangle((292, 196, 348, 244), fill=(238, 214, 120))
    d.rectangle((0, 196, 18, 244), fill=tape)
    d.rectangle((621, 196, 639, 244), fill=tape)
    label = shipping_label(False)
    face.paste(label, (36, 28))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((178, 198, 822, 632), radius=6, fill=(0, 0, 0, 28))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    canvas.paste(face, (180, 186))
    return canvas.filter(ImageFilter.SMOOTH)


def make_parcel(damaged: bool) -> Image.Image:
    if not damaged:
        return make_parcel_intact()
    w, h = 1100, 820
    canvas = Image.new("RGB", (w, h), (54, 56, 60))
    d = ImageDraw.Draw(canvas)
    for y in range(470, h):
        tone = 78 + (y - 470) // 8
        d.line((0, y, w, y), fill=(tone, tone - 2, tone - 6))
    d.rectangle((0, 0, 70, h), fill=(168, 92, 58))
    d.rectangle((w - 90, 0, w, h), fill=(46, 48, 52))
    d.rectangle((70, 120, 86, h), fill=(92, 64, 40))
    shade = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shade).ellipse((250, 620, 920, 760), fill=(0, 0, 0, 70))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shade).convert("RGB")

    face = kraft((560, 360), 3, (188, 142, 84))
    top = kraft((560, 150), 4, (214, 172, 108))
    side = kraft((150, 360), 5, (150, 108, 62))
    df, dt, ds = ImageDraw.Draw(face), ImageDraw.Draw(top), ImageDraw.Draw(side)
    tape = (214, 176, 64)
    df.rectangle((0, 164, 559, 196), fill=tape)
    dt.rectangle((0, 62, 559, 94), fill=tape)
    ds.rectangle((0, 164, 149, 196), fill=tape)
    df.rectangle((8, 8, 551, 351), outline=(120, 86, 48), width=3)
    label = shipping_label(damaged)
    face.paste(label, (42, 118))

    if damaged:
        df.polygon([(330, 10), (559, 0), (559, 250), (390, 300), (310, 150)], fill=(118, 80, 44))
        df.line([(350, 30), (540, 90), (510, 220), (370, 250)], fill=(48, 32, 18), width=8)
        for hole in ((430, 70), (500, 130), (455, 180)):
            df.ellipse((hole[0], hole[1], hole[0] + 36, hole[1] + 22), fill=(40, 42, 46))
        dt.polygon([(280, 0), (559, 0), (559, 149), (250, 110)], fill=(54, 56, 60))
        dt.line([(250, 110), (400, 20), (540, 90)], fill=(70, 48, 24), width=7)
        ds.polygon([(20, 230), (149, 190), (149, 359), (0, 359)], fill=(40, 42, 46))
        df.text((360, 40), "CRUSHED", fill=(250, 236, 210), font=font(FONT_BOLD, 28))

    box = Image.new("RGBA", (760, 560), (0, 0, 0, 0))
    box.paste(top, (150, 0))
    box.paste(side, (0, 150))
    box.paste(face, (150, 150))
    if damaged:
        box = box.transform(box.size, Image.Transform.AFFINE, (1, 0.05, 0, 0.04, 1, 10), resample=Image.Resampling.BICUBIC)
    canvas.paste(box.convert("RGB"), (160, 140), box)
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
    swing = math.sin(phase) * 0.7
    arm = math.sin(phase + math.pi) * 0.55

    def rot(px: float, py: float) -> tuple[int, int]:
        ca, sa = math.cos(tilt), math.sin(tilt)
        x, y = px * scale, py * scale
        rx, ry = x * ca - y * sa, x * sa + y * ca
        return int(ox + rx), int(oy + ry)

    shirt, pants, skin = (196, 72, 28), (36, 38, 44), (214, 176, 140)
    head = rot(0, -92)
    draw.ellipse((head[0] - 16, head[1] - 18, head[0] + 16, head[1] + 18), fill=skin)
    torso = [rot(-18, -70), rot(18, -70), rot(16, 8), rot(-16, 8)]
    draw.polygon(torso, fill=shirt)
    draw.line([rot(-12, -58), rot(-38, -8 + arm * 22)], fill=skin, width=11)
    draw.line([rot(12, -58), rot(38, -8 - arm * 22)], fill=skin, width=11)
    draw.line([rot(-8, 8), rot(-20 + swing * 10, 86)], fill=pants, width=13)
    draw.line([rot(8, 8), rot(20 - swing * 10, 86)], fill=pants, width=13)
    lf, rf = rot(-20 + swing * 10, 90), rot(20 - swing * 10, 90)
    draw.ellipse((lf[0] - 10, lf[1] - 5, lf[0] + 12, lf[1] + 7), fill=(28, 28, 30))
    draw.ellipse((rf[0] - 10, rf[1] - 5, rf[0] + 12, rf[1] + 7), fill=(28, 28, 30))


def scene(w: int = 640, h: int = 360) -> Image.Image:
    img = Image.new("RGB", (w, h), (72, 78, 86))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 210, w, h), fill=(168, 166, 158))
    for x in range(0, w, 40):
        d.line((x, 210, x, h), fill=(148, 146, 138), width=1)
    d.line((0, 210, w, 210), fill=(212, 168, 36), width=6)
    d.rectangle((0, 40, w, 78), fill=(48, 52, 58))
    d.text((16, 48), "WAREHOUSE AISLE  B", fill=(232, 228, 220), font=font(FONT_BOLD, 18))
    d.rectangle((0, 0, 22, h), fill=(90, 94, 100))
    d.rectangle((w - 22, 0, w, h), fill=(90, 94, 100))
    return img


def mix(samples: list[float], offset: int, burst: list[float]) -> None:
    for i, value in enumerate(burst):
        idx = offset + i
        if 0 <= idx < len(samples):
            samples[idx] = max(-1.0, min(1.0, samples[idx] + value))


def tone(freq: float, ms: int, rate: int = 16_000, vol: float = 0.35) -> list[float]:
    n = int(rate * ms / 1000)
    return [vol * math.sin(2 * math.pi * freq * i / rate) * (1 - i / max(1, n)) for i in range(n)]


def walk_audio(seconds: float = 4.0, rate: int = 16_000) -> list[float]:
    samples = [0.0] * int(seconds * rate)
    for step in range(int(seconds / 0.42)):
        mix(samples, int(step * 0.42 * rate), tone(90, 70, rate, 0.55))
        mix(samples, int(step * 0.42 * rate) + 40, tone(160, 40, rate, 0.25))
    return samples


def fall_audio(seconds: float = 4.0, rate: int = 16_000) -> list[float]:
    samples = [0.0] * int(seconds * rate)
    mix(samples, int(0.2 * rate), tone(220, 180, rate, 0.12))
    mix(samples, int(1.05 * rate), tone(70, 220, rate, 0.85))
    mix(samples, int(1.08 * rate), tone(40, 280, rate, 0.7))
    mix(samples, int(1.2 * rate), tone(180, 90, rate, 0.35))
    return samples


def encode_video(frames: list[Image.Image], dest: Path, audio: list[float]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        for i, frame in enumerate(frames):
            frame.save(folder / f"f{i:03d}.png")
        wav = folder / "a.wav"
        write_wav(wav, audio)
        subprocess.check_call(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                "12",
                "-i",
                str(folder / "f%03d.png"),
                "-i",
                str(wav),
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "26",
                "-preset",
                "slow",
                "-c:a",
                "aac",
                "-b:a",
                "48k",
                "-ar",
                "16000",
                "-ac",
                "1",
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
        x = 80 + i * 9.4
        person(d, (x, 214), i * 0.75, 0.0, 1.35)
        frames.append(img)
    return frames


def make_fall() -> list[Image.Image]:
    frames = []
    for i in range(48):
        img = scene()
        d = ImageDraw.Draw(img)
        if i < 10:
            person(d, (260, 214), 0.15, math.sin(i / 2) * 0.1, 1.35)
        elif i < 24:
            t = (i - 10) / 14
            person(d, (260 + t * 90, 214 + t * t * 90), 0.3, t * (math.pi / 2), 1.35)
        else:
            person(d, (360, 292), 0.05, math.pi / 2 + 0.06, 1.35)
        frames.append(img)
    return frames


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    save_jpeg(make_receipt(False), "receipt-legible.jpg", max_edge=900, quality=85)
    save_jpeg(make_receipt(True), "receipt-blurry.jpg", max_edge=900, quality=70)
    if (SRC / "shattered.jpg").exists():
        save_jpeg(crop_phone(Image.open(SRC / "shattered.jpg")), "phone-cracked.jpg")
    if (SRC / "phone_intact.jpg").exists():
        intact = Image.open(SRC / "phone_intact.jpg")
        w, h = intact.size
        save_jpeg(intact.crop((0, 0, int(w * 0.64), h)), "phone-intact.jpg")
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

    encode_video(make_fall(), OUT / "safety-fall.mp4", fall_audio())
    encode_video(make_walk(), OUT / "safety-walk.mp4", walk_audio())

    for stale in ("voicemail.wav", "machine.wav", "gallery.png", "package.png", "clip.webm"):
        path = OUT / stale
        if path.exists():
            path.unlink()
            print("removed", stale)


if __name__ == "__main__":
    main()
