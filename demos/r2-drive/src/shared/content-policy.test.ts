import { describe, expect, test } from "bun:test";
import { sniff, zipStored } from "./content-policy";

const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => new Uint8Array(values);

describe("magic bytes", () => {
  test("allows text, markdown, json, csv, pdf, and office packages", () => {
    expect(sniff(text("# Notes\n\nHello")).ok).toBe(true);
    expect(sniff(text("a,b\n1,2\n")).ok).toBe(true);
    const json = sniff(text('{"ok":true}\n'));
    expect(json.ok && json.kind).toBe("json");
    const pdf = sniff(text("%PDF-1.7\n1 0 obj\n"));
    expect(pdf.ok && pdf.kind).toBe("pdf");
    const docx = sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/document.xml", data: text("<w:document/>") },
      ]),
    );
    expect(docx.ok && docx.kind).toBe("ooxml");
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(sniff(ole).ok).toBe(true);
  });

  test("rejects images, video, audio, archives, and unknown binaries", () => {
    const rejected = [
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      bytes(0xff, 0xd8, 0xff, 0xd9),
      text("GIF89a"),
      bytes(0x1f, 0x8b, 0x08),
      bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c),
      bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07),
      bytes(0x7f, 0x45, 0x4c, 0x46),
      text("-----BEGIN PGP MESSAGE-----"),
    ];
    for (const sample of rejected) expect(sniff(sample).ok).toBe(false);
    const tar = new Uint8Array(512);
    tar.set(text("ustar"), 257);
    expect(sniff(tar).ok).toBe(false);
    expect(sniff(zipStored([{ name: "secret.zip", data: text("no") }])).ok).toBe(false);
    const media = sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/document.xml", data: text("<w:document/>") },
        { name: "word/media/image1.png", data: text("png") },
      ]),
    );
    expect(media.ok).toBe(false);
    const embedded = new Uint8Array(32);
    embedded.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    embedded.set([0xff, 0xd8, 0xff], 16);
    expect(sniff(embedded).ok).toBe(false);
  });
});
