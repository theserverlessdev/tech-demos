import { describe, expect, test } from "bun:test";
import { sniff, zipDeflated, zipStored } from "./content-policy";

const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => new Uint8Array(values);
const pdf = text("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

describe("magic bytes", () => {
  test("allows text, markdown, json, csv, pdf, and office packages", async () => {
    expect((await sniff(text("# Notes\n\nHello"))).ok).toBe(true);
    expect((await sniff(text("a,b\n1,2\n"))).ok).toBe(true);
    const json = await sniff(text('{"ok":true}\n'));
    expect(json.ok && json.kind).toBe("json");
    const parsed = await sniff(pdf);
    expect(parsed.ok && parsed.kind).toBe("pdf");
    expect(parsed.ok && parsed.inline).toBe(false);
    const docx = await sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/document.xml", data: text("<w:document/>") },
      ]),
    );
    expect(docx.ok && docx.kind).toBe("ooxml");
  });

  test("rejects images, video, audio, archives, and unknown binaries", async () => {
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
    for (const sample of rejected) expect((await sniff(sample)).ok).toBe(false);
    const tar = new Uint8Array(512);
    tar.set(text("ustar"), 257);
    expect((await sniff(tar)).ok).toBe(false);
    expect((await sniff(zipStored([{ name: "secret.zip", data: text("no") }]))).ok).toBe(false);
    const media = await sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/document.xml", data: text("<w:document/>") },
        { name: "word/media/image1.png", data: text("png") },
      ]),
    );
    expect(media.ok).toBe(false);
  });

  test("rejects pdf polyglots, ole, loose office parts, and armour after a newline", async () => {
    const zip = zipStored([{ name: "a.txt", data: text("hi") }]);
    const polyglot = new Uint8Array(pdf.byteLength + zip.byteLength);
    polyglot.set(pdf);
    polyglot.set(zip, pdf.byteLength);
    expect((await sniff(polyglot)).ok).toBe(false);

    const ole = new Uint8Array(1024);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    crypto.getRandomValues(ole.subarray(8));
    expect((await sniff(ole)).ok).toBe(false);

    const dat = await sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/document.xml", data: text("<w:document/>") },
        { name: "word/a.dat", data: text("no") },
      ]),
    );
    expect(dat.ok).toBe(false);

    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
    const xmlPng = await sniff(
      zipStored([
        { name: "[Content_Types].xml", data: text("<Types/>") },
        { name: "word/x.xml", data: png },
      ]),
    );
    expect(xmlPng.ok).toBe(false);

    expect((await sniff(text("\n-----BEGIN PGP MESSAGE-----\n"))).ok).toBe(false);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    expect((await sniff(text(alphabet.repeat(8)))).ok).toBe(false);
    expect((await sniff(text(`${"a".repeat(400)}\n`))).ok).toBe(true);
    expect((await sniff(text("\n-----BEGIN AGE ENCRYPTED FILE-----\n"))).ok).toBe(false);
    const scripted = text("%PDF-1.7\n/JavaScript (alert(1))\n%%EOF\n");
    expect((await sniff(scripted)).ok).toBe(false);
  });

  test("a deflated minimal docx is an office document", async () => {
    const docx = await zipDeflated([
      { name: "[Content_Types].xml", data: text(`<?xml version="1.0"?><Types/>`) },
      { name: "_rels/.rels", data: text(`<?xml version="1.0"?><Relationships/>`) },
      { name: "word/document.xml", data: text(`<?xml version="1.0"?><w:document/>`) },
      { name: "word/_rels/document.xml.rels", data: text(`<?xml version="1.0"?><Relationships/>`) },
    ]);
    const sniffed = await sniff(docx);
    expect(sniffed.ok && sniffed.kind).toBe("ooxml");
  });
});
